import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createChatGPT } from '../vendor/siwc/packages/local/src/index.js';
import { handleRequest } from './operations.js';
import { frameResponse, readRequest } from './protocol.js';

const EXTENSION_ORIGIN = 'chrome-extension://kbdnibfjndljjlghoooplbholpkehpao/';
const MAX_PREVIEW_CHARS = 32 * 1024;
const helper = join(dirname(process.argv[1]), 'keychain-helper');
const crypt = (action: 'encrypt' | 'decrypt', input: Uint8Array | string): Buffer => {
  return execFileSync(helper, [action], {
    input, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 3 * 1024 * 1024,
  });
};

const createClient = () => createChatGPT({
  appName: 'DualRead Personal',
  appId: 'dev.dualread.personal',
  storageDir: join(homedir(), 'Library', 'Application Support', 'DualRead Personal', 'account'),
  redirectPort: 0,
  sendHostId: true,
  openBrowser(url) {
    execFileSync(helper, ['open-browser'], { input: url, stdio: ['pipe', 'ignore', 'ignore'] });
  },
  credentialEncryption: {
    id: 'dualread-macos-keychain-aes256gcm-v1',
    isAvailable: () => process.platform === 'darwin',
    encrypt: (plaintext) => crypt('encrypt', plaintext),
    decrypt: (ciphertext) => crypt('decrypt', ciphertext).toString('utf8'),
  },
});

const run = async () => {
  const invalid = { ok: false, error: '브라우저의 번역 확장에서 연결을 다시 시도해 주세요.' };
  let result: unknown = invalid;
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort();
  process.stdout.on('error', () => { cancel(); process.stdin.destroy(); });
  try {
    if (process.argv[2] === EXTENSION_ORIGIN) {
      const request = await readRequest(process.stdin);
      process.stdin.once('end', cancel);
      process.stdin.once('error', cancel);
      process.stdin.resume();
      let previewChars = 0;
      let previewWritable = true;
      result = await handleRequest(request, createClient(), lifetime.signal, (text) => {
        if (!text || !previewWritable || lifetime.signal.aborted) return;
        previewChars += text.length;
        // A slow reader can keep the last prefix until the authoritative final frame arrives.
        previewWritable = previewChars <= MAX_PREVIEW_CHARS && process.stdout.write(frameResponse({ event: 'delta', text }));
      });
    }
  } catch { result = invalid; }
  if (!process.stdout.destroyed) process.stdout.write(frameResponse(result), () => process.stdin.destroy());
};
void run();
