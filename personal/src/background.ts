import { isRecord, nativeRequest, optionsState, readRoute, saveRoute, translate, translateBatch } from './routing.js';
import { INVALID_BATCH_OUTPUT } from './translation-prompt.js';

const isOwnView = (sender: chrome.runtime.MessageSender, page: string): boolean =>
  sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(page);

const isOwnPage = (sender?: chrome.runtime.MessageSender): boolean =>
  sender?.id === chrome.runtime.id && sender?.tab?.id !== undefined && sender.frameId === 0 && /^https?:\/\//i.test(sender.url ?? '');

const dispatch = async (msg: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<object> => {
  const options = isOwnView(sender, 'options.html');
  if (msg.type === 'personal-state') {
    if (options) return { ok: true, ...await optionsState() };
    if (isOwnView(sender, 'popup.html')) return { ok: true, ...await readRoute() };
  }
  if (msg.type === 'personal-models' && options) return nativeRequest({ action: 'list-models' });
  if (msg.type === 'personal-save' && options) {
    await saveRoute(msg);
    return { ok: true };
  }
  if (msg.type === 'personal-account' && options &&
      (msg.action === 'login' || msg.action === 'logout' || msg.action === 'status')) {
    const reply = await nativeRequest({ action: msg.action });
    if (msg.action !== 'status') {
      await navigator.locks.request('personal-settings', async () => {
        const route = await readRoute();
        if (route.provider === 'plan') await chrome.storage.local.set({ route: { ...route, routeVersion: crypto.randomUUID() } });
      });
    }
    return { ok: true, connected: reply.connected === true };
  }
  if ((msg.type === 'personal-translate' || msg.type === 'personal-translate-batch') && isOwnPage(sender)) {
    if (msg.type === 'personal-translate-batch') {
      return { ok: true, translations: await translateBatch(msg.texts, msg.routeVersion) };
    }
    return { ok: true, translation: await translate(msg.text, msg.routeVersion) };
  }
  throw new Error('허용되지 않은 요청입니다.');
};

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!isRecord(message) || typeof message.type !== 'string' || !message.type.startsWith('personal-')) return;
  void dispatch(message, sender).then(respond, (error: unknown) => {
    const detail = error instanceof Error ? error.message : '요청을 처리할 수 없습니다.';
    const code = message.type === 'personal-translate-batch' && detail === INVALID_BATCH_OUTPUT ? 'INVALID_BATCH_OUTPUT' : undefined;
    respond({ ok: false, error: detail, code });
  });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'personal-body-stream') return;
  if (!isOwnPage(port.sender)) { port.disconnect(); return; }
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  const post = (reply: object): void => {
    if (controller.signal.aborted) return;
    try { port.postMessage(reply); } catch { controller.abort(); }
  };
  const begin = (message: unknown): void => {
    port.onMessage.removeListener(begin);
    if (!isRecord(message)) { post({ ok: false, error: '허용되지 않은 요청입니다.' }); return; }
    void translate(message.text, message.routeVersion, {
      signal: controller.signal,
      onStarted: () => post({ event: 'started' }),
      onDelta: (text) => post({ event: 'delta', text }),
    }).then(
      (translation) => post({ ok: true, translation }),
      (error: unknown) => post({ ok: false, error: error instanceof Error ? error.message : '번역에 실패했습니다.' }),
    );
  };
  port.onMessage.addListener(begin);
});

const launch = async (tabId: number, type: 'personal-all' | 'personal-pick' | 'personal-selected'): Promise<void> => {
  try {
    const { routeVersion } = await readRoute();
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'page.js'] });
    const result = await chrome.tabs.sendMessage(tabId, { type, routeVersion });
    if (!result?.ok) throw new Error(result?.error || '문단을 선택해 주세요.');
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'DualRead 개인 번역기' });
  } catch (error: unknown) {
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: error instanceof Error ? error.message : '일반 웹페이지에서 시도하세요.' });
  }
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'pick', title: 'DualRead · 번역할 문단 고르기', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'selected', title: 'DualRead · 선택한 글 번역', contexts: ['selection'] });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined || (info.frameId ?? 0) !== 0) return;
  if (info.menuItemId === 'pick' || info.menuItemId === 'selected') {
    void launch(tab.id, info.menuItemId === 'pick' ? 'personal-pick' : 'personal-selected');
  }
});
chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id === undefined) return;
  switch (command) {
    case 'translate-page': void launch(tab.id, 'personal-all'); break;
    case 'translate-selection': void launch(tab.id, 'personal-selected'); break;
    case 'pick-paragraph': void launch(tab.id, 'personal-pick'); break;
  }
});
