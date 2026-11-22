import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export const shortcutPagePath = '/private-shortcut-page';
const heading = 'An example article';
const nested = 'Nested emphasis stays together.';
const selected = 'emphasis';
const distant = 'An item below the fold.';
const duplicate = 'Repeated item';
const slowItem = 'A slow response';
const near = [heading, 'Navigation label', 'Sidebar note', nested, 'Show details', 'Table cell', slowItem];
const paragraphs = Array.from({ length: 14 }, (_, i) => `Paragraph number ${i + 1}.`);
const units = [...near, ...paragraphs, distant, duplicate, duplicate, 'Footer label'];
const forbidden = ['PRIVATE_TITLE', 'PRIVATE_SUMMARY', 'PRIVATE_QUERY', 'PRIVATE_COOKIE',
  'PRIVATE_HIDDEN', 'PRIVATE_EDIT', 'PRIVATE_INPUT', 'PRIVATE_LINK_PATH', shortcutPagePath];
const doneSelector = '.llm-bilingual-translation.is-done';
const allResults = '.llm-bilingual-translation';
export const shortcutHtml = `<!doctype html><meta charset="utf-8"><title>PRIVATE_TITLE</title>
<meta name="description" content="PRIVATE_SUMMARY"><h1 id="top">${heading}</h1>
<nav><a href="/PRIVATE_LINK_PATH">Navigation label</a></nav><aside><p>Sidebar note</p></aside>
<article><blockquote><p id="nested">Nested <em>${selected}</em> stays together.</p></blockquote>
<p hidden>PRIVATE_HIDDEN</p><input value="PRIVATE_INPUT"><div contenteditable>PRIVATE_EDIT</div>
<button>Show details</button><table><tr><td>Table cell</td></tr></table>
<p>${slowItem}</p><div style="height:650vh"></div>
${paragraphs.map((s) => `<p>${s}</p>`).join('')}
<p id="far">${distant}</p><p>${duplicate}</p><p>${duplicate}</p>
</article><footer><p>Footer label</p></footer>`;
export const mockTranslator = (translate) => {
  const holds = new Map();
  let active = 0;
  let highWater = 0;
  const hold = (text) => {
    const started = Promise.withResolvers();
    const released = Promise.withResolvers();
    holds.set(text, { started, released });
    return {
      wait: () => Promise.race([started.promise, delay(7000, 'timeout', { ref: false }).then(() => {
        throw new Error(`Timed out waiting for the local model request for "${text}"`);
      })]),
      release: () => { released.resolve(); holds.delete(text); },
    };
  };
  const decode = (body) => {
    const user = body.messages.at(-1).content;
    const items = user.startsWith('[{') ? JSON.parse(user) : null;
    return { items, sources: items ? items.map((item) => item.text) : [user] };
  };
  const complete = async ({ items, sources }) => {
    highWater = Math.max(highWater, ++active);
    try {
      await Promise.all(sources.map((source) => {
        const gate = holds.get(source);
        if (gate) { gate.started.resolve(); return gate.released.promise; }
      }));
      await delay(25);
      return items ? JSON.stringify(items.map(({ id, text }) => ({ id, translation: translate(text) }))) : translate(sources[0]);
    } finally { active--; }
  };
  return { hold, decode, complete, peak: () => highWater };
};

export const shortcutDriver = async (context, page) => {
  const client = await context.newCDPSession(page);
  return async (letter) => {
    // A nonzero native virtual key code makes CDP send a browser accelerator, as a physical
    // shortcut would. Plain renderer keyboard events do not activate chrome.commands.
    for (const type of ['rawKeyDown', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', { type, modifiers: 1, key: letter.toLowerCase(),
        code: 'Key' + letter, windowsVirtualKeyCode: letter.charCodeAt(0),
        nativeVirtualKeyCode: letter.charCodeAt(0), isSystemKey: true });
    }
  };
};

export const verifyPageShortcuts = async ({ context, worker, origin, calls, mock, prefix }) => {
  const page = await context.newPage();
  const url = `${origin}${shortcutPagePath}?q=PRIVATE_QUERY`;
  await page.goto(url);
  await page.bringToFront();
  const press = await shortcutDriver(context, page);
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  for (const [name, letter] of [['translate-page', 'A'], ['translate-selection', 'C']]) {
    assert.match(commands.find((command) => command.name === name)?.shortcut ?? '', new RegExp('^(⌥|Alt\\+)' + letter + '$', 'i'));
  }
  const start = calls.length;
  await press('C');
  await page.locator('.llm-bilingual-page-notice').waitFor();
  assert.equal(calls.length, start, 'An empty Option+C selection sent text');
  const word = await page.locator('#nested em').boundingBox();
  await page.mouse.move(word.x + 1, word.y + word.height / 2);
  await page.mouse.down();
  await page.mouse.move(word.x + word.width - 1, word.y + word.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  await press('C');
  await page.locator(doneSelector).waitFor();
  assert.deepEqual(calls.slice(start).flatMap((call) => call.sources), [selected]);
  await press('C');
  await delay(150);
  assert.equal(calls.length, start + 1, 'Translating the same selection twice created an extra request');

  await page.reload();
  const sourceRect = await page.locator('#far').boundingBox();
  assert.ok(sourceRect.y > page.viewportSize().height);
  const pageStart = calls.length;
  const slow = mock.hold(slowItem);
  await page.evaluate((selector) => {
    const startTime = performance.now();
    new MutationObserver((_, observer) => {
      if (document.querySelector(selector)) {
        document.documentElement.dataset.firstTranslationMs = String(Math.round(performance.now() - startTime));
        observer.disconnect();
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true });
  }, doneSelector);
  await press('A');
  try {
    await slow.wait();
    await page.waitForFunction((selector) => Array.from(document.querySelectorAll(selector)).some((node) => {
      const { top, bottom } = node.getBoundingClientRect();
      return bottom > 0 && top < innerHeight;
    }), doneSelector);
    assert.ok(near.includes(calls[pageStart].sources[0]), JSON.stringify(calls[pageStart].sources));
    assert.equal(calls[pageStart].sources.length, 1, 'The first visible item waited for a batch');
    assert.equal(await page.getByText(prefix + slowItem, { exact: true }).count(), 0);
  } finally { slow.release(); }
  await page.getByText(prefix + slowItem, { exact: true }).waitFor({ state: 'attached' });
  assert.ok(!calls.slice(pageStart).some((call) => call.sources.includes(distant)), 'A distant unread paragraph was sent before scrolling');
  await page.locator('#far').scrollIntoViewIfNeeded();
  await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count,
    { selector: doneSelector, count: units.length }, { timeout: 7500 });
  const initial = calls.slice(pageStart);
  assert.deepEqual(initial.flatMap((call) => call.sources).sort(), [...new Set(units)].sort());
  assert.ok(initial.some((call) => call.sources.length > 1), 'Page mode sent only single-item requests');
  assert.ok(initial.every((call) => call.sources.length <= 5));
  assert.ok(mock.peak() >= 2 && mock.peak() <= 3, `Unexpected concurrent model requests: ${mock.peak()}`);
  for (const id of ['top', 'nested', 'far']) {
    const below = await page.locator('#' + id).evaluate((element, selector) => {
      const range = document.createRange();
      range.selectNodeContents(element.firstChild);
      const block = element.querySelector(selector) ?? element.nextElementSibling;
      return block?.matches(selector) && block.getBoundingClientRect().top >= range.getBoundingClientRect().bottom - 1;
    }, doneSelector);
    assert.ok(below, `The translation is not below its original at #${id}`);
  }
  const firstMs = await page.locator('html').getAttribute('data-first-translation-ms');
  assert.ok(firstMs !== null);
  console.log(`Chrome page mode: ${units.length} source blocks in ${initial.length} loopback requests, peak concurrency ${mock.peak()}, first render ${firstMs}ms with a 25ms mock model.`);

  await page.evaluate(() => {
    addEventListener('scroll', () => {
      const p = document.createElement('p');
      p.id = 'dynamic';
      p.textContent = 'Loaded on scroll';
      document.querySelector('article').append(p);
    }, { once: true });
  });
  await page.mouse.wheel(0, -180);
  await page.getByText(prefix + 'Loaded on scroll', { exact: true }).waitFor({ state: 'attached' });
  await page.evaluate(() => {
    history.pushState({}, '', '#next');
    document.querySelector('#dynamic').textContent = 'Replaced by the site';
  });
  await page.getByText(prefix + 'Replaced by the site', { exact: true }).waitFor({ state: 'attached' });
  const pendingText = 'Pending during restore';
  const pending = mock.hold(pendingText);
  try {
    await page.evaluate((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      document.body.append(p);
    }, pendingText);
    await pending.wait();
    await press('A');
    await page.waitForFunction((selector) => !document.querySelector(selector), allResults);
    assert.equal(await page.locator('#nested').innerText(), nested);
    assert.equal(await page.locator('#far').innerText(), distant);
  } finally { pending.release(); }
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.textContent = 'Added after turning off';
    document.body.append(p);
  });
  await delay(600);
  assert.equal(await page.locator(allResults).count(), 0, 'A late response restored a translation after mode was disabled');
  const pageCalls = calls.slice(pageStart);
  assert.deepEqual(pageCalls.flatMap((call) => call.sources).sort(),
    [...new Set(units), 'Loaded on scroll', 'Replaced by the site', pendingText].sort());
  for (const { headers, body } of calls.slice(start)) {
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.referer, undefined);
    const payload = JSON.stringify(body);
    for (const token of forbidden) assert.ok(!payload.includes(token), `A shortcut sent private context: ${token}`);
  }
  await page.locator('#top').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#top').getBoundingClientRect().top >= 0);
  const beforeCachedToggle = calls.length;
  await press('A');
  await page.getByText(prefix + heading, { exact: true }).waitFor({ state: 'visible' });
  await page.getByText(prefix + nested, { exact: true }).waitFor({ state: 'visible' });
  assert.equal(calls.length, beforeCachedToggle, 'A second page toggle resent cached visible source text');
  await press('A');
  await page.waitForFunction((selector) => !document.querySelector(selector), allResults);
  await page.close();
};
