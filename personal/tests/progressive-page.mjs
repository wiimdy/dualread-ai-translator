import assert from 'node:assert/strict';
import { shortcutDriver } from './page-shortcuts.mjs';

const sources = ['Reading order', 'The first paragraph is still translating.', 'The next paragraph is still translating.'];
const labels = ['Subscribe', 'Sign in', 'UPDATES', 'Published Monday'];
const visibleTail = 'This paragraph is still on the first screen.';
const upcoming = ['A paragraph just below the screen.', 'The following paragraph also belongs to this section.'];
const article = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0 5vw; font: 16px/1.5 system-ui; }
  h1 { margin: 0; font: bold 20px/1.2 system-ui; }
  p { margin: 0; min-height: 32vh; }
</style><nav><a href="#subscribe">${labels[0]}</a> <a href="#account">${labels[1]}</a></nav>
<main><h3><a href="#updates">${labels[2]}</a></h3>
<h1>${sources[0]}</h1><div><time>${labels[3]}</time></div>
<div><a href="#story">${sources[1]}</a></div><p>${sources[2]}</p>
<p style="min-height:0">${visibleTail}</p>
<section style="margin-block-start:105vh">${upcoming.map((text) => `<p style="min-height:0">${text}</p>`).join('')}</section></main>`;

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
    assert.deepEqual(calls.slice(start, start + sources.length).map((call) => call.sources), sources.map((source) => [source]),
      'Visible editorial content should start individually in reading order, ahead of navigation and timestamps');
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
