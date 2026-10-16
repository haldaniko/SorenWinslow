import { writeFileSync } from 'fs';
import { spawn } from 'child_process';

const apiUrl = process.env.VITE_API_URL?.trim() || 'https://api.sorenwinslow.com';
if (!apiUrl || !/^https?:\/\//.test(apiUrl)) {
  throw new Error('VITE_API_URL must be an HTTP(S) URL');
}
writeFileSync('dist/runtime-config.js', `window.__SOREN_CONFIG__ = ${JSON.stringify({
  apiUrl: apiUrl.replace(/\/$/, ''),
  measurementId: process.env.VITE_GA_MEASUREMENT_ID?.trim() || '',
})};\n`);

const server = spawn('./node_modules/.bin/serve', ['-s', 'dist', '-l', '3000'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => { process.exitCode = code ?? 1; });
