import assert from 'node:assert/strict';
import { shortcutDriver } from './page-shortcuts.mjs';

const headline = 'A second life for unused office space';
const deck = 'Vacant offices are becoming studios.';
const credit = 'By Jordan Lee, Metro Desk';
const links = ['West District', 'East District'];
const notice = 'Please read our access rules and contact details before sending a request.';
const secondCredit = 'By Casey Hart, Guest Editor';
const pageHtml = `<!doctype html><meta charset="utf-8"><style>
  .credit { display:inline-block }
  .prefix { margin-inline-end:4px }
  .contributors { display:flex }
</style><article><a id="card" href="/unused"><h2>${headline}</h2><p>${deck}</p></a>
<div class="credit"><span class="prefix">By</span><a id="author" href="/writer">Jordan Lee</a><span>, Metro Desk</span></div>
<div>Please read our <a href="/rules">access rules</a> and <span><a href="/contact">contact details</a></span> before sending a request.</div>
<div class="contributors"><span>By </span><a href="/editor"><span>Casey Hart</span></a><span>, </span><span>Guest Editor</span><span><svg width="12" height="12"></svg></span><span>Eight views this morning</span></div>
<div>+1 day ago</div><div>22 hours ago</div><div id="rank">4.</div>
<p>Re<em>use</em> existing buildings.</p><nav><a href="/west">${links[0]}</a> | <a href="/east">${links[1]}</a></nav></article>`;

export const verifyEditorialUnits = async ({ context, origin, calls, mock, prefix }) => {
  const page = await context.newPage();
  try {
    const url = origin + '/editorial-units';
    await page.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml }));
    await page.goto(url);
    await page.bringToFront();
    const press = await shortcutDriver(context, page);
    const select = (selector) => page.locator(selector).evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    const start = calls.length;
    const heldHeadline = mock.hold(headline);
    try {
      await press('A');
      await heldHeadline.wait();
      await select('#card h2');
      await press('C');
      await page.locator('.llm-bilingual-translation.is-loading').waitFor();
    } finally {
      heldHeadline.release();
    }
    const units = [headline, deck, credit, secondCredit, 'Eight views this morning', notice, 'Reuse existing buildings.', ...links];
    for (const source of units) await page.getByText(prefix + source, { exact: true }).waitFor();
    for (const time of ['1일 이상 전', '22시간 전']) await page.getByText(time, { exact: true }).waitFor();
    const sent = calls.slice(start).flatMap((call) => call.sources);
    for (const source of units) assert.equal(sent.filter((value) => value === source).length, 1, source);
    for (const fragment of ['Jordan Lee', 'Casey Hart', 'access rules', 'contact details']) {
      assert.ok(!sent.includes(fragment), 'A full source sent an embedded link separately');
    }
    for (const local of ['+1 day ago', '22 hours ago', '4.']) assert.ok(!sent.includes(local));
    assert.equal(await page.locator('#rank > .llm-bilingual-translation, #rank + .llm-bilingual-translation').count(), 0);
    await press('A');
    await page.waitForFunction(() => !document.querySelector('.llm-bilingual-translation'));
    const selectionStart = calls.length;
    await select('#card p');
    await press('C');
    await page.getByText(prefix + deck, { exact: true }).waitFor();
    assert.equal(calls.length, selectionStart, 'An exact selection resent a cached page unit');
    await select('#author');
    await press('C');
    await page.getByText(prefix + 'Jordan Lee', { exact: true }).waitFor();
    assert.deepEqual(calls.slice(selectionStart).flatMap((call) => call.sources), ['Jordan Lee']);
    await press('A');
    await page.getByText(prefix + headline, { exact: true }).waitFor();
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(async () => {
      const { route } = await chrome.storage.local.get('route');
      await chrome.storage.local.set({ route: { ...route, model: 'another-model', routeVersion: crypto.randomUUID() } });
    });
    await page.waitForFunction(() => !document.querySelector('.llm-bilingual-translation'));
    const changedStart = calls.length;
    await select('#card h2');
    await press('C');
    await page.getByText(prefix + headline, { exact: true }).waitFor();
    assert.deepEqual(calls.slice(changedStart).flatMap((call) => call.sources), [headline]);
    assert.equal(calls.at(-1).body.model, 'another-model');
  } finally {
    await page.close();
  }
};
