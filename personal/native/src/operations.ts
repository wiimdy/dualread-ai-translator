import { INVALID_BATCH_INPUT, INVALID_BATCH_OUTPUT, translatedItems, translationInput, validSourceBatch } from '../../src/translation-prompt.js';
import type { ChatGPTClient } from '../vendor/siwc/packages/local/src/types.js';

const LANGUAGES = new Map(Object.entries({
  ko: 'Korean', korean: 'Korean', '한국어': 'Korean',
}));
const MISSING_CONSENT = 'ChatGPT 계정에서 이 앱의 플랜 사용을 허용해야 합니다. 설정에서 ChatGPT 연결을 다시 눌러 주세요.';

interface NativeRequest { action: unknown; language?: unknown; text?: unknown; texts?: unknown }
type NativeResult = { ok: true; connected?: boolean; translation?: string; translations?: string[] } | { ok: false; error: string };

const failure = (error: string): NativeResult => ({ ok: false, error });

const safeError = (error: unknown): string => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return 'ChatGPT 플랜의 앱 사용 한도에 도달했습니다. ChatGPT의 사용량 설정을 확인해 주세요.';
    case 'subscription_sharing_user_not_eligible':
    case 'subscription_sharing_v2_client_not_enabled':
      return '이 계정·워크스페이스 또는 앱에는 ChatGPT 플랜 사용 권한이 없습니다.';
    case 'sharing_not_enabled':
    case 'chatpass_v2_scope_not_authorized':
      return MISSING_CONSENT;
    case 'invalid_grant':
    case 'sign_in_required':
    case 'reauth_required':
      return '설정에서 ChatGPT 계정을 다시 연결해 주세요.';
    case 'access_denied':
    case 'cancelled':
      return 'ChatGPT 요청이 취소되었거나 인증 시간이 만료되었습니다.';
    case 'revocation_failed':
      return '로컬 연결을 해제했습니다. ChatGPT 설정에서 앱 권한 해제를 확인해 주세요.';
    case 'storage_encryption_unavailable':
    case 'storage_error':
    case 'storage_invalid':
    case 'storage_unsafe':
      return 'macOS 키체인 또는 로컬 연결 저장소를 열 수 없습니다. 키체인 잠금과 접근 권한을 확인해 주세요.';
    case 'network_error':
    case 'connection_error':
      return 'OpenAI에 연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.';
    default:
      return 'ChatGPT 요청을 완료하지 못했습니다. 연결 상태와 계정 권한을 확인해 주세요.';
  }
};

export const handleRequest = async (request: unknown, client: ChatGPTClient, signal: AbortSignal): Promise<NativeResult> => {
  if (!request || typeof request !== 'object' || !('action' in request)) {
    return failure('지원하지 않는 요청입니다.');
  }
  const { action, text, texts, language } = request as NativeRequest;
  try {
    switch (action) {
      case 'status': {
        const session = await client.getSession();
        if (session.error) return failure(safeError(session.error));
        return { ok: true, connected: session.status === 'connected' && session.sharing };
      }
      case 'login': {
        const current = await client.getSession();
        if (current.status === 'connected' && current.sharing) return { ok: true, connected: true };
        const session = await client.signIn({
          reconsent: current.status === 'connected' && !current.sharing,
          signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60 * 1000)]),
        });
        return session.sharing ? { ok: true, connected: true } : failure(MISSING_CONSENT);
      }
      case 'logout': {
        await client.disconnect();
        const session = await client.getSession();
        return session.error ? failure(safeError(session.error)) : { ok: true, connected: false };
      }
      case 'translate':
      case 'translate-batch': {
        const target = typeof language === 'string' ? LANGUAGES.get(language.trim().toLowerCase()) : undefined;
        if (!target) return failure('지원하는 대상 언어를 선택해 주세요.');
        const source = action === 'translate' ? [text] : texts;
        if (!validSourceBatch(source)) return failure(INVALID_BATCH_INPUT);
        const session = await client.getSession();
        if (session.error) return failure(safeError(session.error));
        if (session.status !== 'connected') return failure('설정에서 먼저 ChatGPT 계정을 연결해 주세요.');
        if (!session.sharing) return failure(MISSING_CONSENT);
        const models = await client.listModels({ signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
        const model = models.find((item) => item.slug === 'gpt-6.1-terra') ?? models.find((item) =>
          !/audio|speech|transcrib|whisper|tts|image|realtime|embedding|moderation|video|sora/i.test(item.slug));
        if (!model) return failure('이 계정에서 사용할 수 있는 텍스트 모델을 찾지 못했습니다.');
        const { instructions, content } = translationInput(source, target);
        const result = await client.streamResponse({
          model: model.slug,
          instructions,
          input: [{ role: 'user', content }],
          signal,
        });
        const translations = translatedItems(result.text, source.length);
        if (!translations) return failure(source.length === 1 ? '모델이 빈 번역문을 반환했습니다.' : INVALID_BATCH_OUTPUT);
        return action === 'translate' ? { ok: true, translation: translations[0] } : { ok: true, translations };
      }
      default:
        return failure('지원하지 않는 요청입니다.');
    }
  } catch (error: unknown) {
    return failure(safeError(error));
  }
};
