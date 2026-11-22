import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { mockTranslator, shortcutHtml, shortcutPagePath, verifyPageShortcuts } from './page-shortcuts.mjs';
import { verifyBodyStream, verifyProgressivePage } from './progressive-page.mjs';
import { verifyEditorialUnits } from './editorial-units.mjs';
import { planCatalog, verifyPlanModelSettings, verifyRetainedModelControls } from './model-settings.mjs';
import { readingHtml, readingPagePath, readingTranslation, verifyReadingLayout } from './reading-layout.mjs';

const extensionDirectory = process.env.EXTENSION_DIR
  ? resolve(process.env.EXTENSION_DIR)
  : fileURLToPath(new URL('../dist/', import.meta.url));
const original = 'Translate this one paragraph.';
const selectedWord = 'ManualSelection';
const suffix = 'NEIGHBOR_AFTER';
const pagePath = '/PRIVATE_URL_TOKEN';
const translated = '선택한 문단의 번역입니다.';
const nativeTranslation = '플랜 테스트 번역입니다.';
const translatedBlock = '.llm-bilingual-translation.is-done';
const instruction = '.llm-bilingual-page-notice';
const signature = 'local-test-model';
const excluded = [
  'PRIVATE_URL_TOKEN', 'PRIVATE_TITLE', 'PRIVATE_META', 'PRIVATE_LINK', 'PRIVATE_HIDDEN',
  'NEIGHBOR_BEFORE', suffix, 'PRIVATE_FORM', 'PRIVATE_MENU', 'PRIVATE_EDIT',
  'PRIVATE_COOKIE', 'PRIVATE_OFFSCREEN',
];
const body = `<!doctype html><meta charset="utf-8"><title>PRIVATE_TITLE</title>
<meta name="description" content="PRIVATE_META"><h2>NEIGHBOR_BEFORE</h2>
<p id="target"><span id="click-target">${original}</span><span hidden>PRIVATE_HIDDEN</span></p>
<p id="partial"><span id="one-word">${selectedWord}</span> ${suffix}</p>
<p><a href="/PRIVATE_LINK">PRIVATE_LINK</a></p>
<p><button id="menu">PRIVATE_MENU</button></p><input value="PRIVATE_FORM">
<div contenteditable="true"><p>PRIVATE_EDIT</p></div>
<section style="margin-top:110vh"><p>Look-ahead line one.</p><p>Look-ahead line two.</p></section>
<div style="height:300vh"></div><p id="far">PRIVATE_OFFSCREEN</p>`;
const waitOptions = { polling: 50, timeout: 6_000 };

const run = async () => {
  const calls = [];
  const prefix = translated + ' ';
  const mock = mockTranslator((source) => readingTranslation(source) ?? prefix + source);
  const pages = new Map([[pagePath, body], [shortcutPagePath, shortcutHtml], [readingPagePath, readingHtml]]);
  const server = createServer(async (request, response) => {
    const pathname = request.url.split('?')[0];
    if (request.method === 'GET' && pages.has(pathname)) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'fixture=PRIVATE_COOKIE',
      }).end(pages.get(pathname));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let payload = '';
      for await (const chunk of request) payload += chunk;
      const body = JSON.parse(payload);
      const decoded = mock.decode(body);
      calls.push({ body, headers: request.headers, sources: decoded.sources });
      const content = await mock.complete(decoded);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }
    response.writeHead(404).end();
  });
  const profile = await mkdtemp(join(tmpdir(), 'dualread-personal-ui-'));
  let context;
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    const endpoint = `http://127.0.0.1:${port}/v1`;
    const articleUrl = `http://localhost:${port}${pagePath}`;
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      channel: 'chromium',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`,
        '--enable-unsafe-extension-debugging',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      ],
    });
    context.setDefaultTimeout(7_000);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    // Keep Chrome's real content, popup and service-worker paths, replacing the native host
    // boundary inside this temporary profile. Never open a real host or user credentials.
    await worker.evaluate(({ translation, endpoint, catalog }) => {
      globalThis.planTestCatalog = catalog;
      globalThis.nativeTestCalls = [];
      globalThis.testRequests = [];
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        globalThis.testRequests.push(url);
        if (url !== endpoint) throw new Error('Unexpected HTTP endpoint in browser test');
        return originalFetch(input, init);
      };
      chrome.runtime.sendNativeMessage = () => { throw new Error('Unexpected native transport'); };
      chrome.runtime.connectNative = (host) => {
        let onMessage;
        let onDisconnect;
        return {
          onMessage: { addListener: (callback) => { onMessage = callback; } },
          onDisconnect: { addListener: (callback) => { onDisconnect = callback; } },
          disconnect: () => queueMicrotask(() => onDisconnect()),
          postMessage: (message) => {
            globalThis.nativeTestCalls.push({ host, message });
            if (message.action === 'status') {
              queueMicrotask(() => onMessage({ ok: true, connected: true }));
            } else if (message.action === 'list-models') {
              queueMicrotask(() => onMessage(globalThis.planTestCatalog));
            } else if (message.action === 'translate-batch') {
              queueMicrotask(() => onMessage({ ok: true, translations: message.texts.map(() => translation) }));
            } else if (message.action === 'translate' && message.stream && message.text === globalThis.bodyStreamTest?.source) {
              globalThis.bodyStreamTest.reply = onMessage;
              queueMicrotask(() => onMessage({ event: 'delta', text: globalThis.bodyStreamTest.first }));
            } else if (message.action === 'translate') {
              queueMicrotask(() => onMessage({ ok: true, translation }));
            } else {
              throw new Error('Unexpected native command in UI smoke test');
            }
          },
        };
      };
    }, { translation: nativeTranslation, endpoint: `${endpoint}/chat/completions`, catalog: planCatalog });
    const nativeCalls = () => worker.evaluate(() => globalThis.nativeTestCalls);
    assert.deepEqual(await nativeCalls(), []);
    assert.deepEqual(await worker.evaluate(() => globalThis.testRequests), []);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.waitForFunction(() => !document.querySelector('#save').disabled);
    assert.equal(await options.locator('#provider').inputValue(), 'plan');
    assert.equal(await options.locator('#model').inputValue(), '');

    const article = await context.newPage();
    await article.goto(articleUrl);
    await article.bringToFront();
    const browser = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await browser.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const target = targetInfos.find(({ url }) => url === articleUrl);
    assert.ok(target, 'Could not find the article tab for a native toolbar action');
    const popupClosed = () => options.waitForFunction(
      () => chrome.extension.getViews({ type: 'popup' }).length === 0, undefined, waitOptions,
    );
    const command = async (id) => {
      await article.bringToFront();
      await browser.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
      await options.waitForFunction((buttonId) => {
        const button = chrome.extension.getViews({ type: 'popup' })[0]?.document.getElementById(buttonId);
        return Boolean(button && !button.disabled);
      }, id, waitOptions);
      const before = await options.evaluate((buttonId) => {
        const popup = chrome.extension.getViews({ type: 'popup' })[0];
        const prior = popup.document.getElementById('status').textContent;
        popup.document.getElementById(buttonId).click();
        return prior;
      }, id);
      if (!['pick', 'all'].includes(id)) {
        await options.waitForFunction(({ id: buttonId, before: previous }) => {
          const popup = chrome.extension.getViews({ type: 'popup' })[0];
          return popup && !popup.document.getElementById(buttonId).disabled &&
            popup.document.getElementById('status').textContent !== previous;
        }, { id, before }, waitOptions);
        await options.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].close());
      }
      await popupClosed();
    };
    const passiveReading = async () => {
      await article.locator('#click-target').hover();
      await article.locator('#far').scrollIntoViewIfNeeded();
      await article.locator('#click-target').scrollIntoViewIfNeeded();
      // Let timers and intersection observers scheduled by hover/scroll run.
      await new Promise((done) => setTimeout(done, 500));
    };
    const assertRendered = async (text) => {
      const block = article.locator(translatedBlock).first();
      await block.waitFor({ state: 'visible' });
      assert.ok((await block.innerText()).includes(text));
      assert.equal(await article.locator('#click-target').innerText(), original);
      const sourceBox = await article.locator('#click-target').boundingBox();
      const translationBox = await block.boundingBox();
      const neighborBox = await article.locator('#partial').boundingBox();
      assert.ok(translationBox.y >= sourceBox.y + sourceBox.height - 1, 'Translation is above the original');
      assert.ok(translationBox.y < neighborBox.y, 'Translation appeared after the next paragraph');
    };

    await passiveReading();
    assert.equal((await nativeCalls()).filter(({ message }) => message.action === 'translate').length, 0);
    assert.equal(calls.length, 0);
    assert.equal(await article.locator(translatedBlock).count(), 0);
    await command('pick');
    await article.locator(instruction).waitFor({ state: 'visible' });
    assert.equal((await nativeCalls()).filter(({ message }) => message.action === 'translate').length, 0);
    await article.locator('#click-target').click();
    await assertRendered(nativeTranslation);
    const [native] = (await nativeCalls()).filter(({ message }) => message.action === 'translate');
    assert.equal(native.host, 'dev.dualread.personal');
    assert.equal(native.message.text, original);
    assert.equal(native.message.model, undefined);
    assert.equal(calls.length, 0);
    await command('clear');
    assert.equal(await article.locator(translatedBlock).count(), 0);

    await verifyPlanModelSettings({ options, worker });
    await command('all');
    await article.waitForFunction((selector) => document.querySelectorAll(selector).length >= 3, translatedBlock);
    await article.waitForFunction((selector) => {
      const line = document.querySelector('section p:last-of-type');
      return Boolean(line.querySelector(selector) ?? line.nextElementSibling?.matches(selector));
    }, translatedBlock);
    const planCalls = (await nativeCalls()).filter(({ message }) => message.action.startsWith('translate'));
    const planBatch = planCalls.find(({ message }) => message.action === 'translate-batch');
    assert.equal(planBatch?.host, 'dev.dualread.personal');
    assert.equal(planBatch.message.language, '한국어');
    assert.equal(planBatch.message.model, 'plan-quick');
    assert.equal(planBatch.message.effort, 'low');
    assert.ok(planBatch.message.texts.length > 1);
    await command('all');
    await article.waitForFunction(() => !document.querySelector('.llm-bilingual-translation'));
    assert.equal(calls.length, 0);
    await verifyBodyStream({ context, worker, origin: new URL(articleUrl).origin });
    const expectedNativeTranslations = (await nativeCalls()).filter(({ message }) => message.action.startsWith('translate'));

    // Chrome's own site settings preapprove only this disposable mock endpoint.
    const permissions = await context.newPage();
    await permissions.goto('chrome://extensions');
    await permissions.evaluate((id) =>
      chrome.developerPrivate.addHostPermission(id, 'http://127.0.0.1/*'), extensionId);
    await permissions.close();
    await options.bringToFront();
    await options.locator('#provider').selectOption('custom');
    await options.locator('#endpoint').fill(endpoint);
    await options.locator('#model').fill(signature);
    await options.locator('#customEffort').selectOption('high');
    await options.locator('#save').click();
    await options.waitForFunction(() => document.querySelector('#status').textContent.includes('저장했습니다'));
    await options.reload();
    await options.waitForFunction((url) => document.querySelector('#endpoint').value === url, endpoint);
    assert.equal(await options.locator('#model').inputValue(), signature);
    assert.equal(await options.locator('#provider').inputValue(), 'custom');
    await verifyRetainedModelControls(options, endpoint, signature);

    await command('pick');
    await article.locator(instruction).waitFor({ state: 'visible' });
    await passiveReading();
    await article.locator('#menu').click();
    await article.locator('input').click();
    await article.locator('[contenteditable] p').click();
    await article.locator('#click-target').dispatchEvent('click');
    assert.equal(calls.length, 0, 'A protected control, synthetic click or passive reading sent text');
    await article.locator('#click-target').click();
    await assertRendered(translated);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, signature);
    assert.equal(calls[0].body.reasoning_effort, 'high');
    const paragraphPayload = JSON.stringify(calls[0].body);
    assert.ok(paragraphPayload.includes(original));
    assert.ok(!paragraphPayload.includes(selectedWord));
    for (const token of excluded) assert.ok(!paragraphPayload.includes(token), `Unexpected source ${token}`);
    assert.equal(calls[0].headers.referer, undefined);
    assert.equal(calls[0].headers.cookie, undefined);
    assert.equal(calls[0].headers.authorization, undefined);
    await command('pick');
    await article.locator('#click-target').click();
    await passiveReading();
    assert.equal(calls.length, 1, 'Repeat selection or passive page activity sent text');
    assert.equal(await article.locator(translatedBlock).count(), 1);
    await command('clear');
    assert.equal(await article.locator(translatedBlock).count(), 0);

    await command('pick');
    await article.keyboard.press('Escape');
    await article.locator('#menu').click();
    await article.locator('#click-target').click();
    await article.locator('#one-word').dblclick();
    assert.equal(await article.evaluate(() => window.getSelection().toString().trim()), selectedWord);
    assert.equal(calls.length, 1, 'An ordinary click or drag selection sent text without confirmation');
    await command('selected');
    await article.locator(translatedBlock).waitFor({ state: 'visible' });
    assert.equal(calls.length, 2);
    const selectionPayload = JSON.stringify(calls[1].body);
    assert.ok(selectionPayload.includes(selectedWord));
    assert.ok(!selectionPayload.includes(original));
    for (const token of excluded) assert.ok(!selectionPayload.includes(token), `Unexpected selection context ${token}`);
    const allNative = await nativeCalls();
    assert.deepEqual(allNative.filter(({ message }) => message.action.startsWith('translate')), expectedNativeTranslations);
    assert.deepEqual(await worker.evaluate(() => globalThis.testRequests),
      [`${endpoint}/chat/completions`, `${endpoint}/chat/completions`]);
    await verifyPageShortcuts({ context, worker, origin: new URL(articleUrl).origin, calls, mock, prefix });
    await verifyReadingLayout({ context, origin: new URL(articleUrl).origin, calls });
    await verifyProgressivePage({ context, origin: new URL(articleUrl).origin, mock, calls, prefix });
    await verifyEditorialUnits({ context, origin: new URL(articleUrl).origin, calls, mock, prefix });
    console.log('Chrome UI passed: default plan stub, opt-in paragraph and selection, bilingual rendering, deduplication, clear, and data exclusions. Only the loopback provider received HTTP translation requests.');
  } finally {
    await context?.close();
    server.closeAllConnections();
    server.close();
    await rm(profile, { recursive: true, force: true });
  }
};

await run();
