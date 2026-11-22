import assert from 'node:assert/strict';
import { shortcutDriver } from './page-shortcuts.mjs';

const sources = ['The first paragraph is still translating.', 'Reading order', 'The next article is still translating.'];
const labels = ['Subscribe', 'Sign in', 'UPDATES', 'Published Monday'];
const visibleTail = 'This paragraph is still on the first screen.';
const upcoming = ['A paragraph just below the screen.', 'The following paragraph also belongs to this section.'];
const article = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0 5vw; font: 16px/1.5 system-ui; }
  h1 { margin: 0; font: bold 20px/1.2 system-ui; }
  p { margin: 0; min-height: 32vh; }
</style><nav><a href="#subscribe">${labels[0]}</a> <a href="#account">${labels[1]}</a></nav>
<main><h3><a href="#updates">${labels[2]}</a></h3>
<h1>${sources[1]}</h1><div><time>${labels[3]}</time></div>
<article><p>${sources[0]}</p><div><a href="#story">${sources[2]}</a></div>
<div>${visibleTail}</div></article>
<section style="margin-block-start:105vh">${upcoming.map((text) => `<p style="min-height:0">${text}</p>`).join('')}</section></main>`;

export const verifyBodyStream = async ({ context, worker, origin }) => {
  const page = await context.newPage();
  const body = 'The cache_size setting limits how many records the service can retain. ' +
    'The service keeps recent records in memory so that readers can return to a document without waiting for another download.';
  const first = '서비스가 보관할 수 있는 레코드 수는 ';
  const second = 'cache_size 설정으로 제한합니다.';
  const partial = page.locator('.llm-bilingual-translation.is-streaming');
  const final = page.locator('.llm-bilingual-translation.is-done').filter({ hasText: first.trim() });
  const send = (frame) => worker.evaluate((value) => globalThis.bodyStreamTest.reply(value), frame);
  const press = await shortcutDriver(context, page);
  const renderer = await context.newCDPSession(page);
  try {
    for (const outcome of ['toggle', 'route', 'failure', 'complete']) {
      const url = `${origin}/article-streaming/${outcome}`;
      const marker = `Fixture ${outcome}: `;
      const source = marker + body;
      // A large offscreen menu can keep initial DOM discovery busy while the heading is already observed.
      const offscreen = outcome === 'toggle' ? `<div class="offscreen-menu">${Array.from({ length: 2400 },
        (_, index) => `<span>${marker}Offscreen entry ${index}</span>`).join('')}</div>` : '';
      const html = `<!doctype html><meta charset="utf-8"><style>
        html { overflow-anchor: none; } body { min-height: 300vh; } header { padding-top: 32vh; }
        .offscreen-menu { position:fixed; top:-500vh; left:-500vw; height:20px; width:200px; overflow:hidden; }
        .offscreen-menu span { display:block; }
      </style><nav>${marker}News and updates</nav>
        <main><article><header><h1>${marker}A guide to local storage</h1><p>${marker}Written by the editorial team</p></header>
        ${offscreen}<p id="body">${source.replace('cache_size', '<code>cache_size</code>')}</p>
        <p id="following">${marker}Another paragraph also explains local storage.</p></article></main>`;
      await page.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
      await page.goto(url);
      await page.bringToFront();
      const offset = await worker.evaluate(({ source, first }) => {
        globalThis.bodyStreamTest = { source, first };
        return globalThis.nativeTestCalls.length;
      }, { source, first });
      if (outcome === 'toggle') await renderer.send('Emulation.setCPUThrottlingRate', { rate: 8 });
      await press('A');
      await partial.waitFor({ state: 'visible' });
      if (outcome === 'toggle') await renderer.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      assert.equal((await partial.innerText()).trim(), first.trim());
      assert.equal(await final.count(), 0);
      const currentRequests = () => worker.evaluate(({ offset, marker }) => globalThis.nativeTestCalls.slice(offset)
        .map(({ message }) => message).filter((message) => (message.texts ?? [message.text])
          .some((text) => text?.includes(marker))), { offset, marker });
      const started = await currentRequests();
      assert.ok(started[0]?.stream && started[0].text === source,
        `Expected the lead paragraph first in ${outcome}, received ${JSON.stringify(started[0])}`);
      assert.equal(started.filter((request) => request.text === source || request.texts?.includes(source)).length, 1);
      if (outcome === 'complete') {
        await send({ event: 'delta', text: second });
        await page.waitForFunction((text) => document.querySelector('.is-streaming')?.textContent === text, first + second);
        await page.locator('#following .is-done, #following + .is-done').waitFor();
        const header = page.locator('article header');
        assert.equal(await header.locator('.is-done').count(), 0);
        const beforeHeight = (await header.boundingBox()).height;
        const firstGlyphTop = (node) => {
          const range = document.createRange();
          range.setStart(node.firstChild, 0);
          range.setEnd(node.firstChild, 1);
          return range.getBoundingClientRect().top;
        };
        const before = await partial.evaluate(firstGlyphTop);
        assert.ok(before > 0 && before < page.viewportSize().height);
        await send({ ok: true, translation: first + second });
        await final.waitFor({ state: 'visible' });
        await header.locator('.is-done').first().waitFor();
        assert.ok((await header.boundingBox()).height > beforeHeight + 10, 'The deferred header translations must expand the article');
        const after = await final.evaluate(firstGlyphTop);
        assert.ok(after > 0 && after < page.viewportSize().height && Math.abs(before - after) <= 2,
          `Flushing the header moved the first translated line from ${before}px to ${after}px`);
        assert.equal(await final.locator('code').textContent(), 'cache_size');
        assert.equal(await partial.count(), 0);
        continue;
      }
      if (outcome === 'failure') {
        await send({ ok: false, error: 'Test connection interrupted' });
        await page.locator('.llm-bilingual-page-notice').waitFor();
      } else if (outcome === 'route') {
        await worker.evaluate(async () => {
          const { route } = await chrome.storage.local.get('route');
          await chrome.storage.local.set({ route: { ...route, routeVersion: crypto.randomUUID() } });
        });
      } else {
        await press('A');
      }
      await partial.waitFor({ state: 'detached' });
      if (outcome !== 'failure') {
        await send({ event: 'delta', text: second });
        await send({ ok: true, translation: first + second });
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      }
      assert.equal(await partial.count(), 0);
      assert.equal(await final.count(), 0);
      assert.equal(await page.locator('#body code').textContent(), 'cache_size');
      assert.ok(!(await currentRequests()).some((request) => (request.texts ?? [request.text]).some((text) => text.includes('Offscreen entry'))),
        'The offscreen menu should never reach the provider');
    }
  } finally {
    await worker.evaluate(() => { delete globalThis.bodyStreamTest; });
    await page.close();
  }
};

export const verifyProgressivePage = async ({ context, origin, mock, calls, prefix }) => {
  const page = await context.newPage();
  const url = origin + '/progressive-reading';
  await page.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: article }));
  await page.goto(url);
  await page.bringToFront();
  const start = calls.length;
  const gates = sources.map(mock.hold);
  const tailGate = mock.hold(visibleTail);
  const aheadGate = mock.hold(upcoming[0]);
  try {
    const press = await shortcutDriver(context, page);
    await press('A');
    await Promise.all(gates.map((gate) => gate.wait()));
    const firstWave = calls.slice(start, start + sources.length).map((call) => call.sources);
    assert.deepEqual(firstWave[0], [sources[0]], 'The first article paragraph should go before its heading');
    assert.deepEqual(firstWave.slice(1).map((group) => group.join(' ')).sort(), sources.slice(1).sort(),
      'Visible editorial content should start individually, ahead of navigation and timestamps');
    for (const [index, gate] of gates.entries()) {
      gate.release();
      await page.getByText(prefix + sources[index], { exact: true }).waitFor({ state: 'visible' });
      if (index === 0) {
        await aheadGate.wait();
        assert.deepEqual(calls[start + sources.length].sources, upcoming,
          'One free slot should prepare upcoming paragraphs while visible responses are pending');
        aheadGate.release();
        await page.getByText(prefix + upcoming[0], { exact: true }).waitFor({ state: 'attached' });
        assert.ok(await page.getByText(upcoming[0], { exact: true }).evaluate((e) =>
          scrollY === 0 && e.getBoundingClientRect().top >= innerHeight), 'Prefetch did not happen before scrolling');
        tailGate.release();
      }
      for (const pending of sources.slice(index + 1)) {
        assert.equal(await page.getByText(prefix + pending, { exact: true }).count(), 0);
      }
    }
    for (const label of labels) await page.getByText(prefix + label, { exact: true }).waitFor();
    assert.ok(calls.slice(start).some(({ sources: group }) => group.length > 1 && group.every((text) => labels.includes(text))),
      'Compact navigation labels should share a request');
  } finally {
    for (const gate of gates) gate.release();
    tailGate.release();
    aheadGate.release();
    await page.close();
  }
};
