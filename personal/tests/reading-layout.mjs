import assert from 'node:assert/strict';
import { join } from 'node:path';
import { shortcutDriver } from './page-shortcuts.mjs';

export const readingPagePath = '/choosing-a-cache-size';
const done = '.llm-bilingual-translation.is-done';
const title = 'Choosing a cache size';
const intro = 'A small cache keeps recently opened pages close at hand. Start with the pages you read most often.';
const heading = 'How much should you keep?';
const detail = 'The cache_size setting limits how many pages stay on your device. A smaller value leaves more room for other files.';
const byline = 'Field notes';
const hardBreak = 'Open settings.\nChoose a folder.';
const pre = 'profile = local\n    cache_size = 32';
const label = 'Storage';
const cell = 'Local files';
const empty = 'Empty the cache before measuring again.';
const translatedDetail = 'cache_size 설정은 기기에 보관할 페이지 수를 정합니다. 값을 줄이면 다른 파일을 위한 공간이 늘어납니다.';
const translations = new Map([
  [title, '캐시 크기 정하기'], [heading, '얼마나 보관하면 좋을까요?'],
  [intro, '작은 캐시만 있어도 최근에 연 페이지를 금방 다시 볼 수 있습니다. 자주 읽는 페이지부터 담아 보세요.'],
  [detail, translatedDetail.replace(' 값을', '\n       값을')],
  [byline, '작업 노트'], [hardBreak, '설정을 엽니다.\n폴더를 선택합니다.'],
  [pre, pre], [label, '저장 공간'], [cell, '로컬 파일'],
  [empty, '캐시를 비우고 다시 측정하세요.'], ['cache_size', 'cache_size'],
  ['Reading settings', '읽기 설정'],
  ['Local storage policy', '로컬 저장 정책'], ['Keep recent items.', '최근 항목을 보관합니다.'],
  ['Choose stable mode.', 'stable 모드를 선택합니다.'],
  ['Markup example', '태그 예시는 <b>로컬</b>입니다.'],
]);
// Accept irregular source formatting here so the assertions can independently check the wire text.
export const readingTranslation = (source) =>
  translations.get(source) ?? translations.get(source.replace(/\s+/gu, ' ').trim());

export const readingHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Choosing a cache size</title>
<style>
:root {color-scheme:light dark;--paper:#faf7ef;--ink:#292c28;--rule:#aeb4a7;--code:#eae5d8}
@media(prefers-color-scheme:dark){:root{--paper:#202321;--ink:#f2eee3;--rule:#687167;--code:#393e37}}
* {box-sizing:border-box}
body {margin:0;background:var(--paper);color:var(--ink);font:22px/1.52 Georgia,'AppleMyungjo',serif}
main {width:min(100% - 72px, 760px);margin:46px auto 90px;border-top:1px solid var(--rule)}
h1 {font-size:2.5em;font-weight:600;line-height:1.1;letter-spacing:-.045em;margin:.4em 0 .48em}
h2 {font-size:1.5em;font-weight:600;line-height:1.24;letter-spacing:-.025em;margin:1em 0 .5em}
p {margin:.7em 0 1.05em}
p.byline {font:600 13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.03em;margin:1.25em 0 .4em}
code {font:.83em/1.35 Menlo,Consolas,monospace;background:var(--code);border-radius:3px;padding:.06em .23em}
pre {font:16px/1.5 Menlo,Consolas,monospace;background:var(--code);padding:16px}
</style></head><body><main>
<header><p id="byline" class="byline">${byline}</p><h1 id="title">${title}</h1></header>
<p id="intro">${intro}</p><h2 id="heading">${heading}</h2>
<p id="detail">The
           <code>cache_size</code> setting limits how many pages stay on your device.
           A smaller value leaves more room for other files.</p>
<p id="steps">Open settings.<br>Choose a folder.</p><pre id="pre">${pre}</pre>
<ul><li id="li">${label}</li></ul><table><tbody><tr><td id="cell">${cell}</td></tr></tbody></table>
<div id="role-heading" role="heading" aria-level="2"><strong style="font:italic 700 29px/1.4 Georgia,serif">Reading settings</strong></div>
<div id="mixed"><span id="inline-title" style="font-size:30px;font-weight:700">Local storage policy</span><br>Keep recent items.</div>
<p id="emphasis">Choose <em>stable</em> mode.</p>
<p id="markup">Markup example</p></main></body></html>`;

const resultFor = (page, id) => page.locator(`#${id} > ${done}, #${id} + ${done}`);

const verifyTypography = async (page) => {
  const metric = (id) => page.locator('#' + id).evaluate((source, selector) => {
    const result = source.querySelector(selector) ?? source.nextElementSibling;
    const sourceText = document.createRange();
    sourceText.selectNodeContents(source.firstChild);
    const translatedText = document.createRange();
    translatedText.selectNodeContents(result);
    const style = getComputedStyle(result);
    const sourceStyle = getComputedStyle(source);
    const typography = (css) => [css.fontFamily, css.fontSize, css.fontStyle, css.fontWeight,
      css.lineHeight, css.letterSpacing, css.textAlign];
    return { sourceText: sourceText.getBoundingClientRect().toJSON(),
      translation: translatedText.getBoundingClientRect().toJSON(),
      size: parseFloat(style.fontSize), original: typography(sourceStyle), result: typography(style) };
  }, done);
  const [headingStyle, paragraphStyle, titleStyle] = await Promise.all(['heading', 'detail', 'title'].map(metric));
  assert.ok(titleStyle.size > headingStyle.size && headingStyle.size > paragraphStyle.size,
    'Title, section heading and body translations lost their source hierarchy');
  for (const style of [headingStyle, paragraphStyle, titleStyle]) {
    assert.deepEqual(style.result, style.original, 'Translation did not preserve native typography');
    assert.ok(style.translation.top >= style.sourceText.bottom - 1, 'Translation overlapped its source');
  }
  const gapInsidePair = headingStyle.translation.top - headingStyle.sourceText.bottom;
  const gapToNextPair = paragraphStyle.sourceText.top - headingStyle.translation.bottom;
  assert.ok(gapInsidePair < gapToNextPair,
    `Heading and translation belong together: inner gap ${gapInsidePair}px; following prose gap ${gapToNextPair}px`);
};

const verifyInlineCode = async (page) => {
  const styledToken = resultFor(page, 'detail').locator('code');
  assert.equal(await styledToken.textContent(), 'cache_size');
  const style = (el) => {
    const css = getComputedStyle(el);
    return [css.fontFamily, css.fontSize, css.backgroundColor, css.color];
  };
  const sourceStyle = await page.locator('#detail > code').first().evaluate(style);
  assert.deepEqual(await styledToken.evaluate(style), sourceStyle);
};

export const verifyReadingLayout = async ({ context, origin, calls }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(origin + readingPagePath);
  await page.bringToFront();
  const press = await shortcutDriver(context, page);
  const articleMarkup = await page.locator('main').innerHTML();
  const start = calls.length;
  await press('A');
  await resultFor(page, 'detail').waitFor();
  const sent = calls.slice(start).flatMap((call) => call.sources);
  assert.ok(sent.includes(detail), 'Source indentation and formatting line breaks reached the model');
  assert.equal(await resultFor(page, 'detail').innerText(), translatedDetail,
    'Incidental model line wrapping or indentation remained visible in ordinary prose');
  await verifyTypography(page);
  await verifyInlineCode(page);
  const capture = async (name) => {
    if (process.env.DUALREAD_PREVIEW_DIR) {
      const detailBox = await resultFor(page, 'detail').boundingBox();
      const height = Math.min(page.viewportSize().height, Math.ceil(detailBox.y + detailBox.height + 19));
      await page.screenshot({ path: join(process.env.DUALREAD_PREVIEW_DIR, name), animations: 'disabled',
        clip: { x: 0, y: 0, width: page.viewportSize().width, height } });
    }
  };
  await capture('dualread-reading-preview.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction((selector) => {
    const token = document.querySelector('#detail > code');
    const translated = document.querySelector(`#detail > ${selector} code, #detail + ${selector} code`);
    return getComputedStyle(token).backgroundColor === getComputedStyle(translated).backgroundColor;
  }, done);
  await verifyTypography(page);
  await verifyInlineCode(page);
  await capture('dualread-reading-dark.png');
  await page.locator('#heading').evaluate((h2) => { h2.style.fontSize = '38px'; });
  await page.waitForFunction((selector) => {
    const h2 = document.querySelector('#heading');
    return getComputedStyle(h2.querySelector(selector) ?? h2.nextElementSibling).fontSize === '38px';
  }, done);
  await page.locator('#heading').evaluate((h2) => h2.removeAttribute('style'));

  await page.locator('#markup').scrollIntoViewIfNeeded();
  await resultFor(page, 'markup').waitFor();
  assert.equal(await resultFor(page, 'markup').innerText(), translations.get('Markup example'));
  assert.equal(await resultFor(page, 'markup').locator('b').count(), 0, 'Model text became HTML');
  for (const [id, source] of [['steps', hardBreak], ['pre', pre]]) {
    await resultFor(page, id).waitFor();
    assert.ok(calls.slice(start).flatMap((call) => call.sources).includes(source), 'Intentional source layout was lost');
    assert.equal(await resultFor(page, id).innerText(), translations.get(source), 'Intentional line breaks or spacing were lost');
  }
  for (const id of ['li', 'cell']) {
    await page.locator(`#${id} > ${done}`).waitFor({ state: 'attached' });
  }
  const roleHeading = resultFor(page, 'role-heading');
  await roleHeading.waitFor();
  const headingType = (element) => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.fontWeight, style.fontStyle, style.lineHeight];
  };
  assert.deepEqual(await roleHeading.evaluate(headingType),
    await page.locator('#role-heading strong').first().evaluate(headingType),
    'A heading styled through a nested span lost its native typography');
  const inlineTitle = resultFor(page, 'inline-title');
  await inlineTitle.waitFor();
  assert.deepEqual(await inlineTitle.evaluate(headingType), await page.locator('#inline-title').evaluate(headingType));
  assert.equal(await inlineTitle.innerText(), translations.get('Local storage policy'));
  await page.getByText(translations.get('Keep recent items.'), { exact: true }).waitFor();
  assert.equal(await resultFor(page, 'emphasis').locator('em').innerText(), 'stable');
  await page.evaluate((value) => {
    const paragraph = document.createElement('p');
    paragraph.id = 'added';
    paragraph.textContent = value;
    document.querySelector('main').append(paragraph);
  }, empty);
  await resultFor(page, 'added').waitFor();
  assert.equal(await resultFor(page, 'added').innerText(), translations.get(empty));
  await page.locator('#added').evaluate((p) => p.remove());
  await press('A');
  await page.waitForFunction((selector) => !document.querySelector(selector), done);
  assert.equal(await page.locator('main').innerHTML(), articleMarkup, 'Translation modified the source article');
  await page.locator('#title').scrollIntoViewIfNeeded();
  const cachedStart = calls.length;
  await press('A');
  await resultFor(page, 'detail').waitFor();
  await verifyInlineCode(page);
  assert.equal(calls.length, cachedStart, 'Switching page translation on again resent cached source text');
  await press('A');
  await page.waitForFunction((selector) => !document.querySelector(selector), done);
  await page.locator('#detail code').evaluate((code) => {
    const range = document.createRange();
    range.selectNodeContents(code);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await press('C');
  await resultFor(page, 'detail').waitFor();
  assert.deepEqual(calls.slice(cachedStart).flatMap((call) => call.sources), ['cache_size'],
    'The selection request included unselected prose');
  await page.close();
  console.log('Chrome reading layout passed in light and dark modes, including source pairing, inline code, hard breaks, cache and partial selection.');
};
