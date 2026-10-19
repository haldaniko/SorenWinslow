import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

const root = process.env.DATA_ROOT || '/data';
const owner = await fs.stat(root);
const app = spawn('su-exec', [`${owner.uid}:${owner.gid}`, 'node', 'dist/index.js'], {
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.kill(signal));
app.on('error', (error) => {
  console.error('Backend start failed:', error);
  process.exitCode = 1;
});
app.on('exit', (code) => { process.exitCode = code ?? 1; });
