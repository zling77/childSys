import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';
const viteBin = resolveBin('vite');

const specs = [
  ...(process.env.PREVISIT_OLLAMA_SSH_HOST
    ? [['ollama', 'node', ['scripts/ollama-tunnel.mjs'], {}]]
    : []),
  ['server', 'node', ['server/index.mjs'], {}],
  ['web', viteBin, ['web', '--host', process.env.WEB_HOST ?? '0.0.0.0', '--port', '5176', '--strictPort'], { shell: isWindows }],
];

const running = [];

for (const [name, cmd, args, options] of specs) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, ...options });
  running.push(child);
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code) => {
    console.log(`[${name}] exited ${code}`);
    for (const proc of running) {
      if (proc !== child) proc.kill();
    }
    process.exit(code ?? 0);
  });
}

process.on('SIGINT', () => {
  for (const proc of running) proc.kill('SIGINT');
  process.exit(130);
});

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
