import 'dotenv/config';
import { spawn } from 'node:child_process';

const sshHost = String(process.env.PREVISIT_OLLAMA_SSH_HOST ?? '').trim();
const localPort = parsePort(process.env.PREVISIT_OLLAMA_TUNNEL_LOCAL_PORT ?? 11435, 'PREVISIT_OLLAMA_TUNNEL_LOCAL_PORT');
const remotePort = parsePort(process.env.PREVISIT_OLLAMA_REMOTE_PORT ?? 11434, 'PREVISIT_OLLAMA_REMOTE_PORT');
const localBind = '127.0.0.1';
const remoteBind = '127.0.0.1';

if (!sshHost) {
  throw new Error('PREVISIT_OLLAMA_SSH_HOST is required');
}

const forward = `${localBind}:${localPort}:${remoteBind}:${remotePort}`;
console.log(`ollama tunnel http://${localBind}:${localPort} -> ${sshHost}:${remoteBind}:${remotePort}`);

const child = spawn('ssh', [
  '-N',
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=5',
  '-o', 'ServerAliveCountMax=6',
  '-L', forward,
  sshHost,
], {
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`ollama tunnel failed: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`ollama tunnel stopped by ${signal}`);
    process.exit(0);
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}
