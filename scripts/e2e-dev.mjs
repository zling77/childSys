import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testRoot = mkdtempSync(join(tmpdir(), 'previsit-portals-'));
const children = [];
let stopping = false;

const server = start('api', process.execPath, ['server/index.mjs'], {
  HOST: '127.0.0.1',
  PORT: '4276',
  PREVISIT_DB_PATH: join(testRoot, 'portals.db'),
  PREVISIT_MEDIA_ROOT: join(testRoot, 'media'),
  PREVISIT_LLM_MODE: 'off',
  PREVISIT_CLINICIAN_LLM_MODE: 'off',
  PREVISIT_LLM_PROVIDER: 'mock',
  PREVISIT_OLLAMA_SSH_HOST: '',
});

const web = start('web', process.execPath, [
  join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  'web', '--host', '127.0.0.1', '--port', '5276', '--strictPort',
], {
  VITE_API_URL: 'http://127.0.0.1:4276/api',
});

children.push(server, web);

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`portal test service exited unexpectedly: ${signal ?? code}`);
    stop(code ?? 1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal === 'SIGINT' ? 130 : 0));
}

process.on('exit', () => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best-effort test cleanup */
  }
});

function start(name, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  return child;
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 150).unref();
}
