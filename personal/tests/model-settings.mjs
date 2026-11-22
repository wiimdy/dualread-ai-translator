import assert from 'node:assert/strict';

export const planCatalog = {
  ok: true,
  defaultModel: 'plan-detailed',
  models: [
    { id: 'plan-detailed', label: 'Detailed model', efforts: ['low', 'high'] },
    { id: 'plan-quick', label: 'Quick model', efforts: ['low'] },
    { id: 'plan-simple', label: 'Simple model', efforts: [] },
  ],
};

const effortValues = (options) => options.locator('#planEffort option').evaluateAll((items) => items.map((item) => item.value));

export const verifyPlanModelSettings = async ({ options, worker }) => {
  const model = options.locator('#planModel');
  const effort = options.locator('#planEffort');
  const catalogReady = () => options.waitForFunction(() => document.querySelector('#planModel').options.length === 4);
  await options.bringToFront();
  await catalogReady();
  assert.equal(await model.inputValue(), '');
  assert.match(await model.locator('option:checked').textContent(), /Detailed model/);
  assert.deepEqual(await effortValues(options), ['', 'low', 'high']);
  await effort.selectOption('high');
  await model.selectOption('plan-simple');
  assert.equal(await effort.inputValue(), '');
  assert.equal(await effort.isDisabled(), true);
  await model.selectOption('plan-quick');
  assert.deepEqual(await effortValues(options), ['', 'low']);
  await effort.selectOption('low');
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#status').textContent.includes('저장했습니다'));
  await options.locator('#welcome button').click();
  await options.reload();
  await catalogReady();
  assert.equal(await model.inputValue(), 'plan-quick');
  assert.equal(await effort.inputValue(), 'low');

  // An interrupted catalog request must not erase the saved choice.
  await worker.evaluate(() => { globalThis.planTestCatalog = { ok: false, error: '모델 목록에 연결할 수 없습니다.' }; });
  await options.reload();
  await options.waitForFunction(() => document.querySelector('#catalogStatus').dataset.error === 'true');
  assert.equal(await model.inputValue(), 'plan-quick');
  assert.equal(await effort.inputValue(), 'low');

  // A removed catalog entry stays visible so the user can explicitly replace it.
  await worker.evaluate((catalog) => { globalThis.planTestCatalog = catalog; }, {
    ...planCatalog, models: planCatalog.models.filter((item) => item.id !== 'plan-quick'),
  });
  await options.reload();
  await options.waitForFunction(() => document.querySelector('#planModel').validity.customError);
  assert.match(await model.locator('option:checked').textContent(), /현재 사용 불가/);
  assert.equal(await options.locator('#config').evaluate((form) => form.checkValidity()), false);
  await model.selectOption('plan-detailed');
  assert.equal(await options.locator('#config').evaluate((form) => form.checkValidity()), true);

  // Discard the unsaved edit and restore the current catalog for the live plan request.
  await worker.evaluate((catalog) => { globalThis.planTestCatalog = catalog; }, planCatalog);
  await options.reload();
  await catalogReady();
  assert.equal(await model.inputValue(), 'plan-quick');
  assert.equal(await effort.inputValue(), 'low');
};

export const verifyRetainedModelControls = async (options, endpoint, customModel) => {
  await options.locator('#provider').selectOption('plan');
  await options.waitForFunction(() => document.querySelector('#planModel').options.length === 4);
  assert.equal(await options.locator('#planModel').inputValue(), 'plan-quick');
  assert.equal(await options.locator('#planEffort').inputValue(), 'low');
  await options.locator('#provider').selectOption('custom');
  assert.equal(await options.locator('#endpoint').inputValue(), endpoint);
  assert.equal(await options.locator('#model').inputValue(), customModel);
  assert.equal(await options.locator('#customEffort').inputValue(), 'high');
};
