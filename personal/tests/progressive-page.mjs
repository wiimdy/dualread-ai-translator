import assert from 'node:assert/strict';
import { shortcutDriver } from './page-shortcuts.mjs';

const sources = ['Reading order', 'The first paragraph is still translating.', 'The next paragraph is still translating.'];
const article = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0 5vw; font: 16px/1.5 system-ui; }
  h1 { margin: 0; font: bold 20px/1.2 system-ui; }
  p { margin: 0; min-height: 32vh; }
</style><h1>${sources[0]}</h1><p>${sources[1]}</p><p>${sources[2]}</p>`;

export const verifyProgressivePage = async ({ context, origin, mock, calls, prefix }) => {
  const page = await context.newPage();
  const url = origin + '/progressive-reading';
  await page.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: article }));
  await page.goto(url);
  await page.bringToFront();
  const start = calls.length;
  const gates = sources.map(mock.hold);
  try {
    const press = await shortcutDriver(context, page);
    await press('A');
    await Promise.all(gates.map((gate) => gate.wait()));
    assert.deepEqual(calls.slice(start).map((call) => call.sources), sources.map((source) => [source]),
      'Visible headings and paragraphs should start individually in reading order');
    for (const [index, gate] of gates.entries()) {
      gate.release();
      await page.getByText(prefix + sources[index], { exact: true }).waitFor({ state: 'visible' });
      assert.equal(await page.locator('.llm-bilingual-translation.is-done').count(), index + 1,
        'Each visible translation should paint while later requests are held');
    }
  } finally {
    for (const gate of gates) gate.release();
    await page.close();
  }
};
