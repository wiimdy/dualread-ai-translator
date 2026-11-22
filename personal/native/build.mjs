import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = fileURLToPath(new URL('.', import.meta.url));
const runtime = join(directory, 'runtime');
await mkdir(runtime, { recursive: true });
await build({
  entryPoints: [join(directory, 'src', 'host.ts')],
  outfile: join(runtime, 'host.cjs'),
  platform: 'node', target: 'node22', format: 'cjs', bundle: true,
  legalComments: 'eof',
});
const staging = await mkdtemp(join(tmpdir(), 'dualread-build-'));
try {
  const helper = join(runtime, 'keychain-helper');
  const builds = ['arm64', 'x86_64'].map((arch) => {
    const output = join(staging, arch);
    execFileSync('/usr/bin/xcrun', [
      'swiftc', '-O', '-module-name', 'DualReadKeychain', '-target', arch + '-apple-macosx13.0',
      join(directory, 'src', 'keychain.swift'), '-o', output,
    ], { stdio: 'inherit' });
    return output;
  });
  execFileSync('/usr/bin/lipo', ['-create', ...builds, '-output', helper]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'dev.dualread.personal.keychain', helper]);
  await chmod(helper, 0o755);
} finally {
  await rm(staging, { recursive: true, force: true });
}
