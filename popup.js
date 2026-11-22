const pick = document.querySelector('#pick');
const selected = document.querySelector('#selected');
const clear = document.querySelector('#clear');
const settings = document.querySelector('#settings');
const destination = document.querySelector('#destination');
const usage = document.querySelector('#usage');
const status = document.querySelector('#status');
let version = '';
const showStatus = (message, error = false) => {
    status.textContent = message;
    status.dataset.error = String(error);
};
const setBusy = (busy) => {
    pick.disabled = busy || !version;
    selected.disabled = busy || !version;
    clear.disabled = busy;
};
const load = async () => {
    const state = await chrome.runtime.sendMessage({ type: 'personal-state' });
    if (!state?.ok || !state.routeVersion)
        throw new Error(state?.error || '번역 설정을 불러올 수 없습니다.');
    version = state.routeVersion;
    usage.hidden = state.provider !== 'plan';
    destination.textContent = state.provider === 'plan'
        ? (state.connected ? 'OpenAI · ChatGPT 플랜 사용 중' : 'OpenAI · 내 ChatGPT 구독')
        : `${new URL(state.endpoint).origin} · ${state.model}`;
};
const run = async (action) => {
    setBusy(true);
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id === undefined)
            throw new Error('현재 웹페이지를 찾을 수 없습니다.');
        try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'page.js'] });
        }
        catch {
            throw new Error('이 페이지에는 접근할 수 없습니다. 일반 웹페이지에서 다시 시도해 주세요.');
        }
        showStatus(action === 'selected' ? '번역 중…' : '');
        const reply = await chrome.tabs.sendMessage(tab.id, { type: `personal-${action}`, routeVersion: version });
        if (!reply?.ok)
            throw new Error(reply?.error || '페이지에서 응답을 받지 못했습니다.');
        if (action === 'pick') {
            window.close();
        }
        else if (reply.message) {
            showStatus(reply.message);
        }
        else if (action === 'clear') {
            showStatus(reply.count ? `번역 ${reply.count}개를 지웠습니다.` : '지울 번역이 없습니다.');
        }
        else {
            showStatus(reply.count ? '선택한 글의 번역을 표시했습니다.' : '새로 번역할 글이 없습니다.');
        }
    }
    catch (error) {
        showStatus(error instanceof Error ? error.message : '요청을 처리할 수 없습니다.', true);
    }
    finally {
        setBusy(false);
    }
};
pick.addEventListener('click', () => void run('pick'));
selected.addEventListener('click', () => void run('selected'));
clear.addEventListener('click', () => void run('clear'));
settings.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage().catch(() => showStatus('설정 화면을 열 수 없습니다.', true));
});
void load()
    .catch((error) => showStatus(error instanceof Error ? error.message : '설정을 확인해 주세요.', true))
    .finally(() => setBusy(false));
export {};
