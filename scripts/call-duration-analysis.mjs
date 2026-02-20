import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config.json');
const fallbackConfigPath = path.join(root, 'config.example.json');

const toNum = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const normalizePhone = (v) => String(v || '').replace(/\D/g, '').slice(-10);

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function pick(obj, keys = []) {
  for (const k of keys) {
    const value = obj?.[k];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function ownerName(record = {}) {
  const owner = pick(record, ['Owner']);
  if (owner && typeof owner === 'object' && owner.name) return owner.name;
  if (typeof owner === 'string' && owner) return owner;
  return '--';
}

function istDateKey(input = new Date()) {
  const d = new Date(input);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function isTodayIST(ts) {
  if (!ts) return false;
  return istDateKey(ts) === istDateKey(new Date());
}

async function readConfig() {
  const raw = await fs.readFile((await exists(configPath)) ? configPath : fallbackConfigPath, 'utf8');
  const cfg = JSON.parse(raw);
  cfg.zoho.clientId = process.env.ZOHO_CLIENT_ID || cfg.zoho.clientId;
  cfg.zoho.clientSecret = process.env.ZOHO_CLIENT_SECRET || cfg.zoho.clientSecret;
  cfg.zoho.refreshToken = process.env.ZOHO_REFRESH_TOKEN || cfg.zoho.refreshToken;
  cfg.zoho.region = process.env.ZOHO_REGION || cfg.zoho.region || 'in';
  return cfg;
}

async function refreshAccessToken(cfg) {
  const body = new URLSearchParams({
    refresh_token: cfg.zoho.refreshToken,
    client_id: cfg.zoho.clientId,
    client_secret: cfg.zoho.clientSecret,
    grant_type: 'refresh_token'
  });

  const res = await fetch(`https://accounts.zoho.${cfg.zoho.region}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function zohoGet(cfg, token, endpoint, params = {}) {
  const url = new URL(`https://www.zohoapis.${cfg.zoho.region}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { method: 'GET', headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`${endpoint} failed: ${json?.code || `HTTP_${res.status}`}`);
  return json;
}

async function fetchRecentLeads(cfg, token, maxPages = 20) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const resp = await zohoGet(cfg, token, '/crm/v2/Leads', { page, per_page: 200, sort_by: 'Created_Time', sort_order: 'desc' });
    const data = resp?.data || [];
    if (!data.length) break;
    all.push(...data);
    const oldest = pick(data[data.length - 1], ['Created_Time']);
    if (oldest && !isTodayIST(oldest) && page > 3) break;
    if (data.length < 200) break;
  }
  return all;
}

async function fetchRecentCalls(cfg, token, maxPages = 20) {
  const calls = [];
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  for (let page = 1; page <= maxPages; page++) {
    const resp = await zohoGet(cfg, token, '/crm/v2/Calls', { page, per_page: 200, sort_by: 'Created_Time', sort_order: 'desc' });
    const data = resp?.data || [];
    if (!data.length) break;
    calls.push(...data);
    const oldest = pick(data[data.length - 1], ['Created_Time', 'Call_Start_Time']);
    const ts = oldest ? new Date(oldest).getTime() : null;
    if (ts && ts < cutoff) break;
    if (data.length < 200) break;
  }
  return calls;
}

function classifyOutcome(lead = {}) {
  const text = `${lead.leadStatus || ''} ${lead.leadSubStatus || ''}`.toLowerCase();
  const rejectKeywords = ['rejected', 'wrong number', 'duplicate', 'price is high', 'cancelled', 'slot not available', 'looking for job', 'just enquiring'];
  const convertKeywords = ['nc2', 'nc3', 'enrolled', 'won', 'customer', 'call back later'];
  if (convertKeywords.some(k => text.includes(k))) return 'converted';
  if (rejectKeywords.some(k => text.includes(k))) return 'rejected';
  return 'pending';
}

function summarize(agentStats) {
  const result = [];
  for (const [agent, buckets] of agentStats.entries()) {
    let topConversion = null;
    let topRejection = null;
    let sweetSpot = null;
    const bucketDetails = [];

    for (const [bucket, data] of buckets.entries()) {
      const totalPhones = data.phones.size || 1;
      const conversionRate = data.converted.size / totalPhones;
      const rejectionRate = data.rejected.size / totalPhones;
      bucketDetails.push({
        bucket,
        phones: data.phones.size,
        converted: data.converted.size,
        rejected: data.rejected.size,
        conversionRate,
        rejectionRate
      });
      if (!topConversion || conversionRate > topConversion.rate) {
        topConversion = { bucket, rate: conversionRate, count: data.converted.size };
      }
      if (!topRejection || rejectionRate > topRejection.rate) {
        topRejection = { bucket, rate: rejectionRate, count: data.rejected.size };
      }
      const efficiency = conversionRate - rejectionRate;
      if (!sweetSpot || efficiency > sweetSpot.score) {
        sweetSpot = { bucket, score: efficiency, conversionRate, rejectionRate };
      }
    }

    result.push({ agent, topConversion, topRejection, sweetSpot, bucketDetails });
  }
  return result;
}

function bucketFor(duration) {
  if (!Number.isFinite(duration)) return 'Unknown';
  if (duration < 60) return '<60s';
  if (duration < 120) return '60-120s';
  if (duration < 180) return '120-180s';
  if (duration < 300) return '180-300s';
  return '300s+';
}

function extractPhoneFromSubject(subject = '') {
  const match = String(subject || '').match(/(\+?\d[\d\s+-]{7,})/g);
  if (!match) return null;
  const raw = match[match.length - 1];
  return normalizePhone(raw);
}

function phoneFromCall(call = {}) {
  const raw = pick(call, ['Dialled_Number', 'Phone', 'Mobile']) || extractPhoneFromSubject(call.Subject || '');
  if (!raw) return null;
  return normalizePhone(raw);
}

async function main() {
  const cfg = await readConfig();
  const token = await refreshAccessToken(cfg);
  const [leads, calls] = await Promise.all([
    fetchRecentLeads(cfg, token),
    fetchRecentCalls(cfg, token)
  ]);

  const leadById = new Map();
  const leadByPhone = new Map();
  for (const lead of leads) {
    const record = {
      id: pick(lead, ['id']) || pick(lead, ['Id']),
      owner: ownerName(lead),
      leadStatus: pick(lead, ['Lead_Status', 'Status']) || '',
      leadSubStatus: pick(lead, ['Sub_Lead_Status', 'Lead_Sub_Status']) || '',
      phone: normalizePhone(pick(lead, ['Phone', 'Mobile']))
    };
    if (record.id) leadById.set(record.id, record);
    if (record.phone) leadByPhone.set(record.phone, record);
  }

  const agentStats = new Map();

  for (const call of calls) {
    const ts = pick(call, ['Call_Start_Time', 'Created_Time']);
    if (!isTodayIST(ts)) continue;
    const duration = toNum(pick(call, ['Call_Duration_in_seconds', 'Call_Duration', 'Duration_in_seconds', 'Duration']), 0);
    if (!duration) continue;
    const bucket = bucketFor(duration);
    const owner = ownerName(call) || '--';
    const phone = phoneFromCall(call);
    const callModuleId = call?.What_Id?.id || call?.Who_Id?.id;
    let lead = null;
    if (callModuleId && leadById.has(callModuleId)) {
      lead = leadById.get(callModuleId);
    } else if (phone && leadByPhone.has(phone)) {
      lead = leadByPhone.get(phone);
    }
    if (!lead) continue;
    const outcome = classifyOutcome(lead);

    if (!agentStats.has(owner)) agentStats.set(owner, new Map());
    if (!agentStats.get(owner).has(bucket)) agentStats.get(owner).set(bucket, { phones: new Set(), converted: new Set(), rejected: new Set() });

    const bucketStats = agentStats.get(owner).get(bucket);
    bucketStats.phones.add(phone);
    if (outcome === 'converted') bucketStats.converted.add(phone);
    if (outcome === 'rejected') bucketStats.rejected.add(phone);
  }

  const summary = summarize(agentStats);
  await fs.writeFile(path.join(root, 'data', 'call-duration-insights.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
