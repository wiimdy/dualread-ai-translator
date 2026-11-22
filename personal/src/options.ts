import { normalizeEndpoint, permissionPattern } from './routing.js';

const provider = document.querySelector<HTMLSelectElement>('#provider')!;
const plan = document.querySelector<HTMLElement>('#plan')!;
const custom = document.querySelector<HTMLElement>('#custom')!;
const endpoint = document.querySelector<HTMLInputElement>('#endpoint')!;
const model = document.querySelector<HTMLInputElement>('#model')!;
const apiKey = document.querySelector<HTMLInputElement>('#apiKey')!;
const status = document.querySelector<HTMLElement>('#status')!;
const accountStatus = document.querySelector<HTMLElement>('#accountStatus')!;
const installHelp = document.querySelector<HTMLDetailsElement>('#installHelp')!;
const login = document.querySelector<HTMLButtonElement>('#login')!;
const logout = document.querySelector<HTMLButtonElement>('#logout')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
const form = document.querySelector<HTMLFormElement>('#config')!;
const welcome = document.querySelector<HTMLDialogElement>('#welcome')!;
let activeProvider = 'plan';
let confirmedAccount = false;
let accountCheck = 0;

const showStatus = (element: HTMLElement, message: string, error = false): void => {
  element.textContent = message;
  element.dataset.error = String(error);
};

const confirmFirstLogin = (): void => {
  if (activeProvider !== 'plan' || !confirmedAccount || localStorage.getItem('dualreadPlanWelcome')) return;
  welcome.showModal();
  localStorage.setItem('dualreadPlanWelcome', '1');
};

const checkAccount = async (action: 'status' | 'login' | 'logout'): Promise<void> => {
  const request = ++accountCheck;
  login.disabled = true;
  logout.disabled = true;
  showStatus(accountStatus, action === 'login' ? '브라우저에서 ChatGPT 로그인을 완료해 주세요.' : '연결 상태를 확인하는 중…');
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'personal-account', action });
    if (request !== accountCheck) return;
    if (!reply?.ok) throw new Error(reply?.error || 'Mac 연결 프로그램을 확인해 주세요.');
    confirmedAccount = reply.connected === true;
    login.hidden = confirmedAccount;
    logout.hidden = !confirmedAccount;
    installHelp.open = false;
    showStatus(accountStatus, confirmedAccount ? 'ChatGPT 플랜에 연결되었습니다.' : 'ChatGPT 로그인이 필요합니다.');
    if (action === 'login') confirmFirstLogin();
  } catch (error: unknown) {
    if (request !== accountCheck) return;
    confirmedAccount = false;
    login.hidden = false;
    logout.hidden = true;
    installHelp.open = true;
    showStatus(accountStatus, error instanceof Error ? error.message : 'Mac 연결 프로그램을 확인해 주세요.', true);
  } finally {
    if (request === accountCheck) {
      login.disabled = false;
      logout.disabled = false;
    }
  }
};

const displayProvider = (): void => {
  const customRoute = provider.value === 'custom';
  plan.hidden = customRoute;
  custom.hidden = !customRoute;
  endpoint.disabled = model.disabled = apiKey.disabled = !customRoute;
  endpoint.required = model.required = customRoute;
};

const submit = async (): Promise<void> => {
  save.disabled = true;
  try {
    const route = provider.value;
    const customRoute = route === 'custom';
    const data = {
      type: 'personal-save',
      provider: route,
      endpoint: customRoute ? endpoint.value.trim() : '',
      model: customRoute ? model.value.trim() : '',
      apiKey: customRoute ? apiKey.value.trim() : '',
    };
    if (customRoute) {
      data.endpoint = normalizeEndpoint(data.endpoint);
      if (!data.model) throw new Error('서버에 등록된 모델 ID를 입력하세요.');
      const granted = await chrome.permissions.request({ origins: [permissionPattern(data.endpoint)] });
      if (!granted) throw new Error('저장하려면 선택한 서버에 대한 접근을 허용해 주세요.');
    }
    const reply = await chrome.runtime.sendMessage(data);
    if (!reply?.ok) throw new Error(reply?.error || '설정을 저장할 수 없습니다.');
    activeProvider = route;
    apiKey.value = '';
    showStatus(status, '설정을 저장했습니다.');
    if (!customRoute) confirmFirstLogin();
  } catch (error: unknown) {
    showStatus(status, error instanceof Error ? error.message : '설정을 저장할 수 없습니다.', true);
  } finally {
    save.disabled = false;
  }
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!save.disabled) void submit();
});
form.addEventListener('input', () => showStatus(status, ''));
endpoint.addEventListener('input', () => { apiKey.value = ''; });
provider.addEventListener('change', () => {
  apiKey.value = '';
  displayProvider();
  if (provider.value === 'plan') void checkAccount('status');
  else ++accountCheck;
});
login.addEventListener('click', () => void checkAccount('login'));
logout.addEventListener('click', () => void checkAccount('logout'));

const load = async (): Promise<void> => {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'personal-state' });
    if (!state?.ok) throw new Error(state?.error || '설정을 불러올 수 없습니다.');
    activeProvider = state.provider;
    provider.value = activeProvider;
    endpoint.value = state.endpoint || '';
    model.value = state.model || '';
    displayProvider();
    if (provider.value === 'plan') void checkAccount('status');
    save.disabled = false;
  } catch (error: unknown) {
    showStatus(status, error instanceof Error ? error.message : '설정을 불러올 수 없습니다.', true);
  }
};
void load();
