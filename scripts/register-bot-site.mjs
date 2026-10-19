import fs from 'node:fs';
import path from 'node:path';

function parse(text) {
  const lines = text.split(/\r?\n/);
  const values = new Map();
  for (const line of lines) {
    const index = line.indexOf('=');
    if (index > 0 && !line.trimStart().startsWith('#')) values.set(line.slice(0, index), line.slice(index + 1));
  }
  return { lines, values };
}

function setValue(document, key, value) {
  const index = document.lines.findIndex((line) => line.startsWith(`${key}=`));
  const line = `${key}=${value}`;
  if (index >= 0) document.lines[index] = line; else document.lines.push(line);
  document.values.set(key, value);
}

const site = parse(fs.readFileSync('.env', 'utf8'));
const token = site.values.get('BOT_INTEGRATION_TOKEN');
if (!token || token.startsWith('replace-')) throw new Error('Run npm run setup:env first');
const botEnvPath = process.env.BOT_ENV_PATH || path.resolve('..', 'tg-posting-integration', '.env');
if (!fs.existsSync(botEnvPath)) throw new Error(`Bot env not found: ${botEnvPath}`);
const bot = parse(fs.readFileSync(botEnvPath, 'utf8'));
let sites;
try { sites = JSON.parse(bot.values.get('SITES_JSON') || '[]'); }
catch { throw new Error('Bot SITES_JSON is not valid JSON'); }
const entry = { id: 'sorenwinslow', name: 'Soren Winslow Review', api_base: 'https://api.sorenwinslow.com/api/bot/v1/', token_env: 'SORENWINSLOW_INTEGRATION_TOKEN' };
const existing = sites.findIndex((item) => item?.id === entry.id);
if (existing >= 0) sites[existing] = entry; else sites.push(entry);
setValue(bot, 'SITES_JSON', JSON.stringify(sites));
setValue(bot, entry.token_env, token);
fs.writeFileSync(botEnvPath, `${bot.lines.filter((line, index, all) => line || index < all.length - 1).join('\n')}\n`);
console.log('Bot .env updated for sorenwinslow; token value was not printed.');
