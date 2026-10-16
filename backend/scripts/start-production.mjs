import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

const root = process.env.DATA_ROOT || '/data';
const envPath = `${root}/backend/.env.production`;
const defaults = {
  CORS_ORIGIN: 'https://sorenwinslow.com',
  SITE_URL: 'https://sorenwinslow.com',
  TZ: 'Europe/Sofia',
};

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

const owner = await fs.stat(root);
let contents;
try {
  contents = await fs.readFile(envPath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const generated = {
    ...defaults,
    JWT_SECRET: randomBytes(48).toString('base64url'),
    REFRESH_TOKEN_SECRET: randomBytes(48).toString('base64url'),
  };
  const body = Object.entries(generated).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  try {
    const file = await fs.open(envPath, 'wx', 0o600);
    try {
      await file.writeFile(body);
      await file.chown(owner.uid, owner.gid);
      await file.sync();
    } finally {
      await file.close();
    }
    contents = body;
    console.log('Created backend/.env.production with persistent authentication secrets');
  } catch (createError) {
    if (createError.code !== 'EEXIST') throw createError;
    contents = await fs.readFile(envPath, 'utf8');
  }
}

for (const [key, value] of Object.entries(defaults)) process.env[key] ||= value;
const fixedByCompose = new Set(['NODE_ENV', 'SQLITE_PATH', 'UPLOAD_DIR', 'REDIS_URL', 'DATA_ROOT']);
for (const [key, value] of Object.entries(parseEnv(contents))) {
  if (!fixedByCompose.has(key)) process.env[key] = value;
}
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
