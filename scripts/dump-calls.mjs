import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config.json');

const raw = await fs.readFile(configPath, 'utf8');
const cfg = JSON.parse(raw);
const body = new URLSearchParams({
  refresh_token: process.env.ZOHO_REFRESH_TOKEN || cfg.zoho.refreshToken,
  client_id: process.env.ZOHO_CLIENT_ID || cfg.zoho.clientId,
  client_secret: process.env.ZOHO_CLIENT_SECRET || cfg.zoho.clientSecret,
  grant_type: 'refresh_token'
});

const tokenRes = await fetch(`https://accounts.zoho.${cfg.zoho.region || 'in'}/oauth/v2/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body
});
const tokenJson = await tokenRes.json();
if (!tokenRes.ok) {
  console.error(tokenJson);
  process.exit(1);
}

const api = async (endpoint, params = {}) => {
  const url = new URL(`https://www.zohoapis.${cfg.zoho.region || 'in'}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${tokenJson.access_token}` } });
  const json = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(json));
  return json;
};

const calls = await api('/crm/v2/Calls', { page: 1, per_page: 5, sort_by: 'Created_Time', sort_order: 'desc' });
console.log(JSON.stringify(calls.data?.slice(0, 3), null, 2));
