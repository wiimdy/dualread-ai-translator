import { INVALID_BATCH_INPUT, INVALID_BATCH_OUTPUT, translatedItems, translationInput, validSourceBatch } from './translation-prompt.js';
const initialRoute = { provider: 'plan', endpoint: '', model: '', routeVersion: 'initial-plan' };
const NATIVE_HOST = 'dev.dualread.personal';
export const isRecord = (value) => typeof value === 'object' && value !== null;
export const normalizeEndpoint = (raw) => {
    const value = raw.trim();
    if (!/^https?:\/\//i.test(value) || /[\s\\?#]/.test(value))
        throw new Error('서버의 API 주소를 확인해 주세요.');
    const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
    if (url.username || url.password || url.hostname.includes('*') ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
        throw new Error('HTTPS 서버 주소 또는 이 Mac의 localhost, 127.0.0.1 주소를 사용하세요.');
    }
    return url.href.replace(/\/+$/, '');
};
export const permissionPattern = (endpoint) => {
    const { protocol, hostname } = new URL(endpoint);
    return `${protocol}//${hostname}/*`;
};
export const readRoute = async () => {
    const { route } = await chrome.storage.local.get('route');
    if (route === undefined)
        return { ...initialRoute };
    if (!isRecord(route) || typeof route.routeVersion !== 'string')
        throw new Error('번역 설정을 다시 저장해 주세요.');
    if (route.provider === 'plan')
        return { ...initialRoute, routeVersion: route.routeVersion };
    if (route.provider !== 'custom' || typeof route.endpoint !== 'string' ||
        typeof route.model !== 'string' || !route.model.trim())
        throw new Error('번역 설정을 다시 저장해 주세요.');
    return { provider: 'custom', model: route.model, endpoint: normalizeEndpoint(route.endpoint), routeVersion: route.routeVersion };
};
const readCustomKey = async (endpoint) => {
    const { credential } = await chrome.storage.session.get('credential');
    return isRecord(credential) && credential.endpoint === endpoint && typeof credential.key === 'string' ? credential.key : '';
};
export const saveRoute = async (value) => {
    if (value.provider !== 'plan' && value.provider !== 'custom')
        throw new Error('사용할 번역 방식을 선택하세요.');
    const route = { ...initialRoute, provider: value.provider, routeVersion: crypto.randomUUID() };
    if (route.provider === 'custom') {
        if (typeof value.endpoint !== 'string' || typeof value.model !== 'string' ||
            !value.model.trim() || value.model.length > 200)
            throw new Error('서버 주소와 모델 ID를 입력하세요.');
        route.endpoint = normalizeEndpoint(value.endpoint);
        route.model = value.model.trim();
        if (!(await chrome.permissions.contains({ origins: [permissionPattern(route.endpoint)] }))) {
            throw new Error('설정에서 지정한 모델 서버에 대한 접근을 허용해 주세요.');
        }
    }
    await navigator.locks.request('personal-settings', async () => {
        if (route.provider === 'custom') {
            const key = (typeof value.apiKey === 'string' && value.apiKey.trim()) || await readCustomKey(route.endpoint);
            await chrome.storage.session.set({ credential: { endpoint: route.endpoint, key } });
        }
        else {
            await chrome.storage.session.remove('credential');
        }
        await chrome.storage.local.set({ route });
    });
};
export const nativeRequest = (message) => new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    const timeout = setTimeout(() => {
        port.disconnect();
        reject(new Error('연결 시간이 초과됐습니다. 설정에서 연결 상태를 확인해 주세요.'));
    }, message.action === 'login' ? 300_000 : 120_000);
    let received = false;
    port.onDisconnect.addListener(() => {
        const hostError = chrome.runtime.lastError;
        clearTimeout(timeout);
        if (!received)
            reject(new Error(hostError ? '이 Mac의 ChatGPT 연결 프로그램을 열 수 없습니다. 설치 안내를 확인해 주세요.' : 'ChatGPT 연결이 종료됐습니다.'));
    });
    port.onMessage.addListener((reply) => {
        received = true;
        clearTimeout(timeout);
        port.disconnect();
        if (!isRecord(reply) || reply.ok !== true) {
            reject(new Error(isRecord(reply) && typeof reply.error === 'string' ? reply.error : 'ChatGPT 연결에 실패했습니다.'));
            return;
        }
        if (message.action === 'translate-batch') {
            const translations = reply.translations;
            if (!Array.isArray(translations) || translations.length !== message.texts.length ||
                !translations.every((item) => typeof item === 'string' && item.trim())) {
                reject(new Error(INVALID_BATCH_OUTPUT));
                return;
            }
            resolve({ ok: true, translations });
            return;
        }
        resolve({
            ok: true,
            connected: reply.connected === true,
            translation: typeof reply.translation === 'string' ? reply.translation : undefined,
        });
    });
    port.postMessage(message);
});
export const translateBatch = async (texts, routeVersion) => {
    if (!validSourceBatch(texts))
        throw new Error(INVALID_BATCH_INPUT);
    const route = await readRoute();
    if (route.routeVersion !== routeVersion)
        throw new Error('전송 대상이 바뀌었습니다. 팝업에서 확인하고 다시 시도하세요.');
    if (route.provider === 'plan') {
        if (texts.length > 1) {
            const result = await nativeRequest({ action: 'translate-batch', texts, language: '한국어' });
            if (!result.translations)
                throw new Error(INVALID_BATCH_OUTPUT);
            return result.translations;
        }
        const result = await nativeRequest({ action: 'translate', text: texts[0], language: '한국어' });
        if (!result.translation?.trim())
            throw new Error('ChatGPT가 번역문을 반환하지 않았습니다.');
        return [result.translation.trim()];
    }
    if (!(await chrome.permissions.contains({ origins: [permissionPattern(route.endpoint)] })))
        throw new Error('설정에서 모델 서버 접근을 허용해 주세요.');
    const key = await readCustomKey(route.endpoint);
    const headers = { 'Content-Type': 'application/json' };
    if (key)
        headers.Authorization = `Bearer ${key}`;
    // Match DualRead's OpenAI-compatible base URL and full-endpoint convention.
    const url = route.endpoint.endsWith('/chat/completions') ? route.endpoint : route.endpoint + '/chat/completions';
    const { instructions, content } = translationInput(texts, 'Korean');
    const response = await fetch(url, {
        method: 'POST', headers, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: AbortSignal.timeout(28_000),
        body: JSON.stringify({ model: route.model, messages: [
                { role: 'system', content: instructions },
                { role: 'user', content },
            ] }),
    });
    if (!response.ok)
        throw new Error(`모델 서버가 HTTP ${response.status}로 응답했습니다. 연결 설정을 확인하세요.`);
    const choice = (await response.json())?.choices?.[0];
    if (choice?.finish_reason && choice.finish_reason !== 'stop')
        throw new Error('서버가 번역을 끝내지 못했습니다.');
    if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim())
        throw new Error('서버 응답에서 번역문을 찾지 못했습니다.');
    const translations = translatedItems(choice.message.content, texts.length);
    if (!translations)
        throw new Error(INVALID_BATCH_OUTPUT);
    return translations;
};
export const translate = async (text, routeVersion) => (await translateBatch([text], routeVersion))[0];
