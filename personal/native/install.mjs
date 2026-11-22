import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_ID = 'kbdnibfjndljjlghoooplbholpkehpao';
const HOST_NAME = 'dev.dualread.personal';
const source = dirname(fileURLToPath(import.meta.url));

export const install = async (homeDirectory, executable, browser = 'chrome') => {
  const browserFolder = { chrome: 'Google/Chrome', edge: 'Microsoft Edge' }[browser];
  if (typeof browserFolder !== 'string') throw new Error('Choose chrome or edge.');
  try {
    await Promise.all(['host.cjs', 'keychain-helper'].map((name) => access(join(source, 'runtime', name))));
  } catch {
    throw new Error('Build the host from the repository root: npm ci && npm run build -w dualread-personal-native');
  }
  const { key } = JSON.parse(await readFile(join(source, '..', 'static', 'manifest.json'), 'utf8'));
  const fingerprint = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  const id = Array.from(fingerprint, (c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  if (id !== EXTENSION_ID) throw new Error('The extension key does not match this native host.');
  const support = join(homeDirectory, 'Library', 'Application Support');
  const runtime = join(support, 'DualRead Personal', 'native');
  const registry = join(support, browserFolder, 'NativeMessagingHosts');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  await mkdir(registry, { recursive: true });
  const replaceFile = async (path, write, mode) => {
    const staging = path + '.' + randomUUID();
    await write(staging);
    await chmod(staging, mode);
    await rename(staging, path);
  };
  for (const name of ['host.cjs', 'keychain-helper']) {
    await replaceFile(join(runtime, name), (staging) => copyFile(join(source, 'runtime', name), staging), name === 'host.cjs' ? 0o600 : 0o700);
  }
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const launcher = join(runtime, 'start');
  const shell = ['#!/bin/sh', 'unset NODE_OPTIONS NODE_PATH OPENAI_CUSTOM_HEADERS OPENAI_LOG', 'exec ' + quote(executable) + ' ' + quote(join(runtime, 'host.cjs')) + ' "$@"', ''].join('\n');
  await replaceFile(launcher, (staging) => writeFile(staging, shell), 0o700);
  const manifest = {
    name: HOST_NAME, description: 'DualRead Personal ChatGPT connection',
    path: launcher, type: 'stdio', allowed_origins: ['chrome-extension://' + EXTENSION_ID + '/'],
  };
  const registered = join(registry, HOST_NAME + '.json');
  await replaceFile(registered, (staging) => writeFile(staging, JSON.stringify(manifest, null, 2) + '\n'), 0o600);
  return registered;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 22) {
      throw new Error('This helper requires macOS 13 or later and Node.js 22 or later.');
    }
    const browser = process.argv[2] ?? 'chrome';
    if (!['chrome', 'edge'].includes(browser) || process.argv.length > 3) throw new Error('Usage: node install.mjs [chrome|edge]');
    const registered = await install(homedir(), process.execPath, browser);
    console.log(`Installed the local native host at ${registered}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Native host installation failed.');
    process.exitCode = 1;
  }
}
