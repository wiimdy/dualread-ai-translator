import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { normalizeEndpoint, readRoute, saveRoute, translate } from '../dist/routing.js';

const endpoint = 'http://127.0.0.1:10081/v1';
const origin = 'http://127.0.0.1/*';
const sample = 'One selected paragraph.';
const area = () => {
  const state = {};
  return {
    state,
    get: async (key) => ({ [key]: state[key] }),
    set: async (items) => Object.assign(state, items),
    remove: async (key) => { delete state[key]; },
  };
};
let local;
let session;
let allowed;
let locks;
beforeEach(() => {
  local = area();
  session = area();
  allowed = new Set([origin]);
  globalThis.chrome = {
    permissions: { contains: async ({origins}) => origins.every((value) => allowed.has(value)) },
    storage: { local, session },
  };
  locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name, save) => save() } });
});
afterEach(() => {
  delete globalThis.chrome;
  if (locks) Object.defineProperty(navigator, 'locks', locks);
  else delete navigator.locks;
  mock.restoreAll();
});

test('first launch selects the subscription without a model, key, or network request', async () => {
  mock.method(globalThis, 'fetch', () => assert.fail('Unexpected network access'));
  const route = await readRoute();
  assert.equal(route.provider, 'plan');
  assert.equal(route.model, '');
  assert.deepEqual(local.state, {});
  assert.deepEqual(session.state, {});
});

test('custom routing sends only selected text, instructions and chosen model to a single destination', async () => {
  const fetch = mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({
    choices: [{ finish_reason: 'stop', message: { content: '번역 결과' } }],
  })));
  await saveRoute({ provider: 'custom', endpoint, model: 'my-model', apiKey: 'unit-test-key' });
  const route = await readRoute();
  assert.equal(await translate(sample, route.routeVersion), '번역 결과');
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, endpoint + '/chat/completions');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, 'Bearer unit-test-key');
  const body = JSON.parse(options.body);
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model']);
  assert.equal(body.model, 'my-model');
  assert.equal(body.messages.length, 2);
  assert.deepEqual(body.messages[1], { role: 'user', content: sample });
  assert.ok(!JSON.stringify(local.state).includes('unit-test-key'));
});

test('changing the destination invalidates the pending selection and drops old keys', async () => {
  const fetch = mock.method(globalThis, 'fetch', () => assert.fail('Unexpected network access'));
  await saveRoute({ provider:'custom', endpoint, model:'old', apiKey:'unit-test-key' });
  const old = await readRoute();
  await saveRoute({ provider:'custom', endpoint:endpoint+'/new', model:'new', apiKey:'' });
  assert.equal(session.state.credential.key, '');
  await assert.rejects(translate(sample,old.routeVersion), /전송 대상/);
  await saveRoute({ provider:'plan' });
  assert.equal(session.state.credential, undefined);
  assert.equal(fetch.mock.callCount(),0);
});

test('invalid settings, withdrawn permission and oversized text stop before network access', async () => {
  mock.method(globalThis, 'fetch', () => assert.fail('Unexpected network access'));
  for (const url of ['http://remote.invalid/v1','https://u:p@remote.invalid/v1','https://*/v1','https://server.invalid/v1?key=x']) {
    assert.throws(() => normalizeEndpoint(url));
  }
  await assert.rejects(saveRoute({provider:'custom', endpoint, model:'  '}), /모델/);
  await saveRoute({provider:'custom', endpoint, model:'test'});
  const route = await readRoute();
  allowed.clear();
  await assert.rejects(translate(sample, route.routeVersion), /접근/);
  await assert.rejects(translate('x'.repeat(5001), route.routeVersion), /5,000/);
  await assert.rejects(saveRoute({provider:'custom', endpoint, model:'test'}), /접근/);
});
