import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getCachedToken } from './token-cache.mjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config.json');
const fallbackConfigPath = path.join(root, 'config.example.json');

const toNum = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
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
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`${endpoint} failed: ${json?.code || `HTTP_${res.status}`}`);
  return json;
}

async function fetchCalls(cfg, token, minRecords = 1200) {
  const perPage = 200;
  const calls = [];
  for (let page = 1; page <= 50; page++) {
    const resp = await zohoGet(cfg, token, '/crm/v2/Calls', {
      page,
      per_page: perPage,
      sort_by: 'Created_Time',
      sort_order: 'desc'
    });
    const batch = resp?.data || [];
    if (!batch.length) break;
    calls.push(...batch);
    if (calls.length >= minRecords) break;
    if (batch.length < perPage) break;
  }
  return calls;
}

function ownerName(record = {}) {
  const owner = record?.Owner;
  if (owner && typeof owner === 'object' && owner.name) return owner.name;
  return owner?.name || '--';
}

function durationBucket(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 30) return '<30s';
  if (seconds < 60) return '30-60s';
  if (seconds < 120) return '60-120s';
  if (seconds < 180) return '120-180s';
  if (seconds < 300) return '180-300s';
  return '300s+';
}

function analyzeCalls(calls = []) {
  const total = calls.length;
  const durations = [];
  const buckets = new Map();
  const statusCounts = new Map();
  const typeCounts = new Map();
  const ownerStats = new Map();
  const hourlyCounts = Array(24).fill(0);
  const hourlyTalkSeconds = Array(24).fill(0);
  let totalTalkSeconds = 0;

  for (const call of calls) {
    const duration = toNum(call.Call_Duration_in_seconds ?? call.Duration_in_seconds ?? call.Call_Duration, 0);
    const bucket = durationBucket(duration);
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);

    if (duration > 0) {
      durations.push(duration);
      totalTalkSeconds += duration;
    }

    const status = (call.Call_Status || 'Unknown').trim() || 'Unknown';
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);

    const type = (call.Call_Type || 'Unknown').trim() || 'Unknown';
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);

    const owner = ownerName(call);
    if (!ownerStats.has(owner)) {
      ownerStats.set(owner, {
        owner,
        calls: 0,
        connected: 0,
        durationSum: 0,
        bucketCounts: new Map(),
        statusCounts: new Map(),
        hourCounts: new Map()
      });
    }
    const stat = ownerStats.get(owner);
    stat.calls += 1;
    stat.bucketCounts.set(bucket, (stat.bucketCounts.get(bucket) || 0) + 1);
    stat.statusCounts.set(status, (stat.statusCounts.get(status) || 0) + 1);
    if (duration > 0) {
      stat.connected += 1;
      stat.durationSum += duration;
    }

    const startTime = call.Call_Start_Time || call.Created_Time;
    if (startTime) {
      const date = new Date(startTime);
      const hour = Number.isFinite(date.getHours()) ? date.getHours() : null;
      if (hour !== null) {
        hourlyCounts[hour] += 1;
        stat.hourCounts.set(hour, (stat.hourCounts.get(hour) || 0) + 1);
        if (duration > 0) {
          hourlyTalkSeconds[hour] += duration;
        }
      }
    }
  }

  durations.sort((a, b) => a - b);
  const avgDuration = durations.length ? (durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const medianDuration = durations.length
    ? (durations.length % 2 === 1
      ? durations[Math.floor(durations.length / 2)]
      : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2)
    : 0;

  const ownerSummary = [...ownerStats.values()].map(stat => {
    const peakHourEntry = [...stat.hourCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const peakHour = peakHourEntry ? `${String(peakHourEntry[0]).padStart(2, "0")}:00` : null;
    const avgBookingSeconds = stat.connected ? Number((stat.durationSum / stat.connected).toFixed(1)) : 0;
    return ({
      owner: stat.owner,
      totalCalls: stat.calls,
      connectedCalls: stat.connected,
      avgDurationSec: avgBookingSeconds,
      connectionRatePercent: stat.calls ? Number(((stat.connected / stat.calls) * 100).toFixed(1)) : 0,
      avgBookingSeconds,
      peakHour,
      bucketBreakdown: [...stat.bucketCounts.entries()].map(([bucket, count]) => ({ bucket, count, percent: Number(((count / stat.calls) * 100).toFixed(1)) })).sort((a, b) => b.count - a.count),
      statusBreakdown: [...stat.statusCounts.entries()].map(([status, count]) => ({ status, count, percent: Number(((count / stat.calls) * 100).toFixed(1)) })).sort((a, b) => b.count - a.count)
    });
  }).sort((a, b) => b.totalCalls - a.totalCalls);

  const bucketSummary = [...buckets.entries()].map(([bucket, count]) => ({ bucket, count, percent: Number(((count / total) * 100).toFixed(1)) }))
    .sort((a, b) => b.count - a.count);

  const statusSummary = [...statusCounts.entries()].map(([status, count]) => ({ status, count, percent: Number(((count / total) * 100).toFixed(1)) }))
    .sort((a, b) => b.count - a.count);

  const typeSummary = [...typeCounts.entries()].map(([type, count]) => ({ type, count, percent: Number(((count / total) * 100).toFixed(1)) }))
    .sort((a, b) => b.count - a.count);

  return {
    generatedAt: new Date().toISOString(),
    totalCalls: total,
    connectedCalls: durations.length,
    avgDurationSec: Number(avgDuration.toFixed(1)),
    medianDurationSec: Number(medianDuration.toFixed(1)),
    bucketSummary,
    statusSummary,
    typeSummary,
    totalTalkSeconds,
    hourlyTalkSeconds,
    ownerSummary,
    hourlyCounts
  };
}

function filterCallsByLookback(calls = [], days = 0) {
  if (!days) return calls;
  const since = Date.now() - (days * 24 * 60 * 60 * 1000);
  return calls.filter(call => {
    const timestamp = call.Call_Start_Time || call.Created_Time || call.Modified_Time;
    const ms = timestamp ? new Date(timestamp).getTime() : NaN;
    return Number.isFinite(ms) && ms >= since;
  });
}

function parseArg(flag) {
  const arg = process.argv.slice(2).find(a => a.startsWith(`${flag}=`));
  if (!arg) return null;
  return arg.split('=')[1];
}

async function main() {
  const cfg = await readConfig();
  const token = await getCachedToken(cfg);
  const positionalMinRecords = Number(process.argv[2]);
  const minRecordsArg = parseArg('minRecords');
  const minRecords = Number(minRecordsArg) || positionalMinRecords || 1200;
  const lookbackDays = Number(parseArg('lookback')) || Number(process.env.CALL_LOOKBACK_DAYS) || 0;
  const outputFile = parseArg('output') || process.env.BULK_CALL_ANALYSIS_OUTPUT || 'bulk-call-analysis.json';
  const calls = await fetchCalls(cfg, token, minRecords);
  const filteredCalls = filterCallsByLookback(calls, lookbackDays);
  const analysis = analyzeCalls(filteredCalls);
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', outputFile), JSON.stringify({ analysis, sampleSize: filteredCalls.length }, null, 2), 'utf8');
  console.log(`Saved ${filteredCalls.length.toLocaleString()} calls (${lookbackDays || 'all history'} days lookback) to ${outputFile}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
