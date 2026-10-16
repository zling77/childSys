import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';
const viteBin = resolveBin('vite');

const child = spawn(viteBin, ['web', '--host', '127.0.0.1', '--port', '5176', '--strictPort'], {
  stdio: 'inherit',
  shell: isWindows,
});

child.on('exit', (code) => process.exit(code ?? 0));

function resolveBin(name) {
  const suffix = isWindows ? '.cmd' : '';
  const candidates = [
    join('node_modules', '.bin', `${name}${suffix}`),
    join('node_modules', '.bin', name),
    join('web', 'node_modules', '.bin', `${name}${suffix}`),
    join('web', 'node_modules', '.bin', name),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
