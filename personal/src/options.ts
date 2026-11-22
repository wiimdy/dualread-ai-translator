import { CUSTOM_EFFORTS, normalizeEndpoint, permissionPattern, type PlanModel } from './routing.js';

const provider = document.querySelector<HTMLSelectElement>('#provider')!;
const plan = document.querySelector<HTMLElement>('#plan')!;
const custom = document.querySelector<HTMLElement>('#custom')!;
const endpoint = document.querySelector<HTMLInputElement>('#endpoint')!;
const model = document.querySelector<HTMLInputElement>('#model')!;
const planModel = document.querySelector<HTMLSelectElement>('#planModel')!;
const planEffort = document.querySelector<HTMLSelectElement>('#planEffort')!;
const customEffort = document.querySelector<HTMLSelectElement>('#customEffort')!;
const catalogStatus = document.querySelector<HTMLElement>('#catalogStatus')!;
const apiKey = document.querySelector<HTMLInputElement>('#apiKey')!;
const status = document.querySelector<HTMLElement>('#status')!;
const accountStatus = document.querySelector<HTMLElement>('#accountStatus')!;
const installHelp = document.querySelector<HTMLDetailsElement>('#installHelp')!;
const login = document.querySelector<HTMLButtonElement>('#login')!;
const logout = document.querySelector<HTMLButtonElement>('#logout')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
const form = document.querySelector<HTMLFormElement>('#config')!;
const welcome = document.querySelector<HTMLDialogElement>('#welcome')!;
const previewToggle = document.querySelector<HTMLInputElement>('#previewToggle')!;
const previewTranslation = document.querySelector<HTMLElement>('#previewTranslation')!;
let activeProvider = 'plan';
let confirmedAccount = false;
let accountCheck = 0;
let catalog: { models: PlanModel[]; defaultModel: string } | undefined;
const effortLabels: Record<string, string> = {
  none: '사용 안 함', minimal: '최소', low: '낮음', medium: '중간', high: '높음', xhigh: '매우 높음', max: '최대',
};

const effortOption = (value: string): HTMLOptionElement =>
  new Option(effortLabels[value] ? `${effortLabels[value]} (${value})` : value, value);

const renderPlanEffort = (value: string, keepSaved: boolean): void => {
  const modelId = planModel.value || catalog?.defaultModel;
  const efforts = catalog?.models.find((item) => item.id === modelId)?.efforts ?? [];
  planEffort.replaceChildren(new Option('모델 기본값', ''), ...efforts.map(effortOption));
  if (value && !efforts.includes(value) && keepSaved) {
    planEffort.add(new Option(catalog ? `${value} (현재 사용 불가)` : value, value));
  }
  planEffort.value = keepSaved || efforts.includes(value) ? value : '';
  planEffort.disabled = provider.value !== 'plan' || planEffort.options.length <= 1;
  planEffort.setCustomValidity(catalog && planEffort.value && !efforts.includes(planEffort.value)
    ? '이 모델에서 사용할 추론 강도를 다시 선택해 주세요.' : '');
};

const renderPlanModels = (id = planModel.value, effort = planEffort.value, keepSavedEffort = true): void => {
  const models = catalog?.models ?? [];
  const preferred = models.find((item) => item.id === catalog?.defaultModel);
  const automatic = preferred ? `자동 선택 · ${preferred.label}` : '자동 선택';
  planModel.replaceChildren(new Option(automatic, ''), ...models.map((item) => new Option(item.label, item.id)));
  const unavailable = Boolean(id && !models.some((item) => item.id === id));
  if (unavailable) planModel.add(new Option(catalog ? `${id} (현재 사용 불가)` : id, id));
  planModel.value = id;
  planModel.disabled = provider.value !== 'plan' || planModel.options.length <= 1;
  planModel.setCustomValidity(catalog && unavailable ? '이 계정에서 사용할 모델을 다시 선택해 주세요.' : '');
  renderPlanEffort(effort, keepSavedEffort);
};

const showStatus = (element: HTMLElement, message: string, error = false): void => {
  element.textContent = message;
  element.dataset.error = String(error);
};

const confirmFirstLogin = (): void => {
  if (activeProvider !== 'plan' || !confirmedAccount || localStorage.getItem('dualreadPlanWelcome')) return;
  welcome.showModal();
  localStorage.setItem('dualreadPlanWelcome', '1');
};

const loadModels = async (request: number): Promise<void> => {
  showStatus(catalogStatus, '사용 가능한 모델을 불러오는 중…');
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'personal-models' });
    if (request !== accountCheck) return;
    if (!reply?.ok || !Array.isArray(reply.models)) throw new Error(reply?.error || '모델 목록을 불러올 수 없습니다.');
    catalog = { models: reply.models, defaultModel: reply.defaultModel };
    renderPlanModels();
    showStatus(catalogStatus, catalog.models.length ? '' : '이 계정에서 사용할 수 있는 번역 모델이 없습니다.');
  } catch (error: unknown) {
    if (request !== accountCheck) return;
    showStatus(catalogStatus, error instanceof Error ? error.message : '모델 목록을 불러올 수 없습니다.', true);
  }
};

const checkAccount = async (action: 'status' | 'login' | 'logout'): Promise<void> => {
  const request = ++accountCheck;
  delete accountStatus.dataset.connected;
  login.disabled = true;
  logout.disabled = true;
  showStatus(accountStatus, action === 'login' ? '브라우저에서 ChatGPT 로그인을 완료해 주세요.' : '연결 상태를 확인하는 중…');
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'personal-account', action });
    if (request !== accountCheck) return;
    if (!reply?.ok) throw new Error(reply?.error || 'Mac 연결 프로그램을 확인해 주세요.');
    confirmedAccount = reply.connected === true;
    accountStatus.dataset.connected = String(confirmedAccount);
    login.hidden = confirmedAccount;
    logout.hidden = !confirmedAccount;
    installHelp.open = false;
    showStatus(accountStatus, confirmedAccount ? '연결됨' : '로그인 필요');
    if (confirmedAccount) void loadModels(request);
    else {
      catalog = undefined;
      renderPlanModels();
      showStatus(catalogStatus, 'ChatGPT에 연결하면 사용 가능한 모델이 표시됩니다.');
    }
    if (action === 'login') confirmFirstLogin();
  } catch (error: unknown) {
    if (request !== accountCheck) return;
    confirmedAccount = false;
    login.hidden = false;
    logout.hidden = true;
    installHelp.open = true;
    catalog = undefined;
    renderPlanModels();
    showStatus(catalogStatus, '');
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
  endpoint.disabled = model.disabled = customEffort.disabled = apiKey.disabled = !customRoute;
  renderPlanModels();
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
      model: customRoute ? model.value.trim() : planModel.value,
      effort: customRoute ? customEffort.value : planEffort.value,
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
planModel.addEventListener('change', () => renderPlanModels(planModel.value, planEffort.value, false));
planEffort.addEventListener('change', () => renderPlanEffort(planEffort.value, true));
endpoint.addEventListener('input', () => { apiKey.value = ''; });
provider.addEventListener('change', () => {
  apiKey.value = '';
  displayProvider();
  if (provider.value === 'plan') void checkAccount('status');
  else ++accountCheck;
});
previewToggle.addEventListener('change', () => {
  previewTranslation.hidden = !previewToggle.checked;
});
login.addEventListener('click', () => void checkAccount('login'));
logout.addEventListener('click', () => void checkAccount('logout'));

const load = async (): Promise<void> => {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'personal-state' });
    if (!state?.ok) throw new Error(state?.error || '설정을 불러올 수 없습니다.');
    activeProvider = state.provider;
    provider.value = activeProvider;
    const savedPlan = state.preferences?.plan ?? (activeProvider === 'plan' ? state : {});
    const savedCustom = state.preferences?.custom ?? (activeProvider === 'custom' ? state : {});
    endpoint.value = savedCustom.endpoint || '';
    model.value = savedCustom.model || '';
    customEffort.append(...CUSTOM_EFFORTS.map(effortOption));
    customEffort.value = savedCustom.effort || '';
    renderPlanModels(savedPlan.model || '', savedPlan.effort || '');
    displayProvider();
    if (provider.value === 'plan') void checkAccount('status');
    save.disabled = false;
  } catch (error: unknown) {
    showStatus(status, error instanceof Error ? error.message : '설정을 불러올 수 없습니다.', true);
  }
};
void load();
