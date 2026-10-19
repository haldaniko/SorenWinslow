import crypto from 'node:crypto';
import fs from 'node:fs';

const target = '.env';
const template = '.env.sample';
const generatedKeys = new Set(['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'ADMIN_PASSWORD', 'JWT_SECRET', 'REFRESH_TOKEN_SECRET', 'BOT_INTEGRATION_TOKEN']);
const placeholder = (value = '') => !value || /change-me|replace-with|generated-password|generated-secret/i.test(value);
const secret = () => crypto.randomBytes(48).toString('base64url');

function parse(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

const sample = parse(fs.readFileSync(template, 'utf8'));
const values = fs.existsSync(target) ? parse(fs.readFileSync(target, 'utf8')) : new Map();
for (const [key, value] of sample) if (!values.has(key)) values.set(key, value);
for (const key of generatedKeys) if (placeholder(values.get(key))) values.set(key, secret());
fs.writeFileSync(target, `${[...sample.keys()].map((key) => `${key}=${values.get(key) ?? ''}`).join('\n')}\n`, { mode: 0o600 });
console.log('.env is ready; existing non-placeholder secrets were preserved.');
