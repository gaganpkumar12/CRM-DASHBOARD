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

const nowIso = () => new Date().toISOString();
const toNum = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function pick(obj, keys = []) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null && obj?.[k] !== '') return obj[k];
  }
  return null;
}

function normalizePhone(v) {
  return String(v || '').replace(/\D/g, '').slice(-10);
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

function isWithinLastDays(ts, days = 30) {
  if (!ts) return false;
  const ms = new Date(ts).getTime();
  if (!Number.isFinite(ms)) return false;
  return (Date.now() - ms) <= (days * 24 * 60 * 60 * 1000);
}

function istHour(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hour12: false
  }).format(d);
  return Number(h);
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

function hasCallActivityFromLead(lead = {}) {
  const callCount = toNum(pick(lead, ['Call_Count', 'Number_of_Calls', 'Calls']), 0);
  const lastCall = pick(lead, ['Last_Call_Time', 'Last_Call', 'Last_Activity_Time']);
  const duration = toNum(pick(lead, ['Call_Duration', 'Total_Call_Duration', 'Last_Call_Duration']), 0);
  return callCount > 0 || !!lastCall || duration > 0;
}

function buildCallPhoneSet(calls = []) {
  const set = new Set();
  for (const c of calls) {
    [pick(c, ['Dialled_Number', 'Caller_ID', 'Phone', 'Mobile'])]
      .flat()
      .filter(Boolean)
      .map(normalizePhone)
      .filter(Boolean)
      .forEach(p => set.add(p));
  }
  return set;
}

async function fetchRecentLeadsForLookback(cfg, token, lookbackDays = 7, maxPages = 10) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const resp = await zohoGet(cfg, token, '/crm/v2/Leads', { page, per_page: 200, sort_by: 'Created_Time', sort_order: 'desc' });
    const batch = resp?.data || [];
    if (!batch.length) break;
    all.push(...batch);

    const oldestInBatch = pick(batch[batch.length - 1], ['Created_Time']);
    if (oldestInBatch && !isWithinLastDays(oldestInBatch, lookbackDays)) break;
    if (batch.length < 200) break;
  }
  return all;
}

async function fetchAllDeals(cfg, token, maxPages = 10) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const resp = await zohoGet(cfg, token, '/crm/v2/Deals', { page, per_page: 200, sort_by: 'Created_Time', sort_order: 'desc' });
    const batch = resp?.data || [];
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 200) break;
  }
  return all;
}

async function fetchData(cfg, token) {
  const lookbackDays = toNum(cfg.dashboard?.lookbackDays, 7);
  const maxLeadPages = toNum(cfg.dashboard?.maxLeadPages, 10);
  const [leads, callsResp, dealsResp, tasksResp] = await Promise.all([
    fetchRecentLeadsForLookback(cfg, token, lookbackDays, maxLeadPages),
    zohoGet(cfg, token, '/crm/v2/Calls', { page: 1, per_page: 200 }).catch(() => ({ data: [] })),
    fetchAllDeals(cfg, token, 50),
    zohoGet(cfg, token, '/crm/v2/Tasks', { page: 1, per_page: 200, sort_by: 'Created_Time', sort_order: 'desc' }).catch(() => ({ data: [] }))
  ]);

  return {
    leads: leads || [],
    calls: callsResp?.data || [],
    deals: dealsResp || [],
    tasks: tasksResp?.data || []
  };
}

function ownerName(record = {}) {
  return pick(record, ['Owner'])?.name || '--';
}

function isTaskCompleted(task = {}) {
  const status = String(pick(task, ['Status', 'Task_Status']) || '').toLowerCase();
  return status.includes('complete') || status.includes('closed') || status.includes('done');
}

function ncStage(raw) {
  const t = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t === 'NC1') return 'NC1';
  if (t === 'NC2') return 'NC2';
  if (t === 'NC3') return 'NC3';
  return null;
}

function extractFieldValue(lead, field) {
  const v = lead?.[field];
  if (v === undefined || v === null) return '';
  // Handle array fields like I_am_looking_for: ["Cleaning Services"]
  if (Array.isArray(v)) return v.filter(Boolean).join(', ').trim();
  return String(v).trim();
}

function buildCategoryConversions(leads = [], deals = [], categoryFields = ['I_am_looking_for', 'Service_Category_n', 'Lead_Source', 'Whatsapp_Category_Service', 'sub_service_category', 'Category', 'Lead_Type', 'Product', 'Service'], lookbackDays = 7) {
  // Filter leads & deals to the lookback window (last N days including today)
  const lookbackLeads = leads.filter(l => isWithinLastDays(pick(l, ['Created_Time']), lookbackDays));
  const lookbackDeals = deals.filter(d => isWithinLastDays(pick(d, ['Created_Time']), lookbackDays));

  // Determine which category field is actually populated in the lead data
  let chosenField = null;
  for (const field of categoryFields) {
    const hasData = lookbackLeads.some(l => extractFieldValue(l, field) !== '');
    if (hasData) { chosenField = field; break; }
  }
  if (!chosenField) {
    console.log('[categoryConversions] No category field found on leads. Checked:', categoryFields.join(', '));
    return [];
  }
  console.log(`[categoryConversions] Using field: "${chosenField}" (last ${lookbackDays} days incl. today)`);

  // Build a set of deal phones/names for matching leads → deals
  const dealPhones = new Set();
  const dealNames = new Set();
  for (const d of lookbackDeals) {
    const phone = normalizePhone(pick(d, ['Phone', 'Mobile', 'Contact_Phone']));
    if (phone) dealPhones.add(phone);
    const rawName = pick(d, ['Contact_Name', 'Deal_Name', 'Account_Name']);
    const name = (typeof rawName === 'object' && rawName !== null ? rawName.name : String(rawName || '')).toLowerCase().trim();
    if (name) dealNames.add(name);
  }

  // Group leads by category and count conversions
  const catMap = new Map();

  for (const l of lookbackLeads) {
    const rawCat = extractFieldValue(l, chosenField);
    const cat = rawCat || 'Uncategorized';
    if (!catMap.has(cat)) catMap.set(cat, { leads: 0, deals: 0 });
    catMap.get(cat).leads += 1;

    // Check if this lead converted to a deal
    const leadPhone = normalizePhone(pick(l, ['Phone', 'Mobile']));
    const leadName = (`${pick(l, ['First_Name']) || ''} ${pick(l, ['Last_Name']) || ''}`.trim()).toLowerCase();
    const status = String(pick(l, ['Lead_Status', 'Status']) || '').toLowerCase();
    const isConverted = status.includes('converted') || status.includes('won') || status.includes('deal');
    const phoneMatch = leadPhone && dealPhones.has(leadPhone);
    const nameMatch = leadName && dealNames.has(leadName);

    if (isConverted || phoneMatch || nameMatch) {
      catMap.get(cat).deals += 1;
    }
  }

  // Build sorted result array
  const result = [...catMap.entries()]
    .map(([category, { leads: leadCount, deals: dealCount }]) => ({
      category,
      leads: leadCount,
      deals: dealCount,
      conversionPercent: leadCount > 0 ? Number(((dealCount / leadCount) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.leads - a.leads);

  console.log(`[categoryConversions] ${result.length} categories found (${lookbackDays}d): ${result.map(r => `${r.category}(${r.leads})`).join(', ')}`);
  return result;
}

/* ---------- Top Booking Areas (from Deal address field) ---------- */
const KNOWN_AREAS = [
  // Sort longest-first so "Sarjapur Road" beats "Sarjapur", etc.
  'Ramagondanahalli','Basaveshwaranagar','Somasundarapalya','CV Raman Nagar',
  'Ramamurthy Nagar','Kumaraswamy Layout','Rajarajeshwari Nagar',
  'Kadubeesanahalli','Vidyaranyapura','Old Airport Road','Outer Ring Road',
  'Kanakapura Road','Sarjapura Road','Sarjapur Road','Old Madras Road',
  'Electronic City','Sahakara Nagar','Kasavanahalli','Doddanekundi',
  'Bommanahalli','Bannerghatta','Banashankari','Basavanagudi','Murugeshpalya',
  'Kaggadasapura','Dommasandra','Kundalahalli','Thanisandra','Devanahalli',
  'Brookefield','Bellary Road','Magadi Road','Tumkur Road','Mysore Road',
  'Hosur Road','Hosa Road','Haralur Road','Kudlu Gate','Silk Board',
  'Marathahalli','Mahadevapura','Whitefield','HSR Layout','BTM Layout',
  'Indiranagar','Koramangala','Bellandur','Yelahanka','Jayanagar',
  'JP Nagar','RT Nagar','RR Nagar','Rajajinagar','Malleshwaram',
  'Vijayanagar','Yeshwanthpur','Uttarahalli','Nagarbhavi',
  'Puttenahalli','Kanakapura','Chandapura','Bommasandra',
  'Carmelaram','Choodasandra','Immadihalli','Seegehalli',
  'HAL Layout','Horamavu','Sarjapur','Haralur','Kadugodi',
  'Panathur','Hebbal','Varthur','Hennur','Bagalur',
  'Hoskote','Attibele','Anekal','Mandur','Medahalli','Virgonagar',
  'Budigere','Nagavara','Manyata','Gunjur','Peenya',
  'Kengeri','Dasarahalli','Madiwala','Gottigere','Hulimavu',
  'Arekere','Ambalipura','Kogilu','Jakkur','Iblur','Agara',
  'Domlur','KR Puram','Hoodi','Kudlu','Begur','ITPL'
].sort((a, b) => b.length - a.length);

function extractArea(street) {
  if (!street) return null;
  const addr = street.toLowerCase();
  for (const area of KNOWN_AREAS) {
    const escaped = area.replace(/[.*+?^()|[\]\\]/g, '\\$&');
    if (new RegExp('\\b' + escaped + '\\b', 'i').test(addr)) return area;
  }
  return null;
}

function buildTopBookingAreas(deals = [], top = 5) {
  const areaCounts = new Map();
  let matched = 0;
  for (const d of deals) {
    const area = extractArea(d.Street);
    if (area) {
      areaCounts.set(area, (areaCounts.get(area) || 0) + 1);
      matched++;
    }
  }
  const sorted = [...areaCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([area, bookings], idx) => ({ rank: idx + 1, area, bookings }));
  console.log(`[topBookingAreas] ${matched}/${deals.length} deals matched to an area. Top ${top}: ${sorted.map(r => `${r.area}(${r.bookings})`).join(', ')}`);
  return sorted;
}

function analyze(leads = [], calls = [], deals = [], tasks = [], overdueMin = 30, lookbackDays = 30, ncSlaHours = { nc1ToNc2: 4, nc2ToNc3: 24 }, categoryFields = undefined) {
  const todaysLeads = leads.filter(l => isTodayIST(pick(l, ['Created_Time'])));
  const todaysDeals = deals.filter(d => isTodayIST(pick(d, ['Created_Time'])));
  const todaysTasks = tasks.filter(t => isTodayIST(pick(t, ['Created_Time'])));

  const ncLookbackLeads = leads.filter(l => isWithinLastDays(pick(l, ['Created_Time']), lookbackDays));

  const nc1Count = ncLookbackLeads.filter(l => ncStage(pick(l, ['Sub_Lead_Status', 'Lead_Sub_Status'])) === 'NC1').length;
  const nc2Count = ncLookbackLeads.filter(l => ncStage(pick(l, ['Sub_Lead_Status', 'Lead_Sub_Status'])) === 'NC2').length;
  const nc3Count = ncLookbackLeads.filter(l => ncStage(pick(l, ['Sub_Lead_Status', 'Lead_Sub_Status'])) === 'NC3').length;

  const callPhones = buildCallPhoneSet(calls);

  const mapLead = (l) => {
    const leadPhone = normalizePhone(pick(l, ['Phone', 'Mobile']));
    const called = hasCallActivityFromLead(l) || (leadPhone && callPhones.has(leadPhone));
    return {
      name: `${pick(l, ['First_Name']) || ''} ${pick(l, ['Last_Name']) || pick(l, ['Full_Name']) || 'Lead'}`.trim(),
      phone: pick(l, ['Phone', 'Mobile']),
      owner: ownerName(l),
      leadStatus: pick(l, ['Lead_Status', 'Status']) || '--',
      leadSubStatus: pick(l, ['Sub_Lead_Status', 'Lead_Sub_Status']) || '--',
      createdTime: pick(l, ['Created_Time']),
      called: !!called,
      modifiedTime: pick(l, ['Modified_Time'])
    };
  };

  const latestAllLeads = leads
    .filter(l => isWithinLastDays(pick(l, ['Created_Time']), lookbackDays))
    .slice(0, 200)
    .map(mapLead);
  const todaysLeadRows = todaysLeads.map(mapLead);

  const calledCount = latestAllLeads.filter(x => x.called).length;
  const notCalledCount = Math.max(0, latestAllLeads.length - calledCount);
  const modifiedWithoutCall = latestAllLeads.filter(x => !x.called && x.modifiedTime).length;
  const followupComplianceRate = latestAllLeads.length ? (calledCount / latestAllLeads.length) * 100 : 0;

  const now = Date.now();
  const overdueFollowups = latestAllLeads
    .filter(l => !l.called && l.createdTime)
    .map(l => ({ ...l, minutesSinceCreated: Math.floor((now - new Date(l.createdTime).getTime()) / 60000) }))
    .filter(l => l.minutesSinceCreated >= overdueMin)
    .slice(0, 25)
    .map(({ name, owner, phone, minutesSinceCreated }) => ({ name, owner, phone, minutesSinceCreated }));

  const callDurations = calls.map(c => toNum(pick(c, ['Call_Duration_in_seconds', 'Call_Duration', 'Duration_in_seconds', 'Duration']), 0)).filter(n => n > 0);
  const avgCallDurationSec = callDurations.length ? callDurations.reduce((a, b) => a + b, 0) / callDurations.length : 0;

  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const callCountsByDay = Array(7).fill(0);
  const durationByDay = Array(7).fill(0);
  calls.forEach(c => {
    const dt = new Date(pick(c, ['Created_Time', 'Call_Start_Time', 'Modified_Time']) || Date.now());
    const idx = (dt.getDay() + 6) % 7;
    const dur = toNum(pick(c, ['Call_Duration_in_seconds', 'Call_Duration', 'Duration_in_seconds', 'Duration']), 0);
    callCountsByDay[idx] += 1;
    durationByDay[idx] += dur;
  });
  const avgDurationByDay = durationByDay.map((sum, i) => (callCountsByDay[i] ? Math.round(sum / callCountsByDay[i]) : 0));

  const leadToDealConversion = (todaysLeads.length + todaysDeals.length)
    ? (todaysDeals.length / (todaysLeads.length + todaysDeals.length)) * 100
    : 0;
  const totalTasksCount = todaysTasks.length;
  const completedTasksCount = todaysTasks.filter(isTaskCompleted).length;
  const taskCompletionPercent = totalTasksCount ? (completedTasksCount / totalTasksCount) * 100 : 0;


  // --- Most accurate owner-wise conversion logic ---
  // 1. All leads created in last 7 days (including those already converted)
  // 2. All deals created in last 7 days whose Original_Created_Time_1 is within the same window
  // 3. Group both by owner
  const leads7d = leads.filter(l => isWithinLastDays(pick(l, ['Created_Time']), lookbackDays));
  const deals7d = deals.filter(d => isWithinLastDays(pick(d, ['Created_Time']), lookbackDays));

  // Map: owner → all leads created in last 7 days
  const ownerLeadMap = new Map();
  for (const l of leads7d) {
    const o = ownerName(l);
    if (!ownerLeadMap.has(o)) ownerLeadMap.set(o, []);
    ownerLeadMap.get(o).push(l);
  }

  // Map: owner → all deals created in last 7 days whose Original_Created_Time_1 is within last 7 days
  const ownerConvertedMap = new Map();
  for (const d of deals7d) {
    const o = ownerName(d);
    const origTime = pick(d, ['Original_Created_Time_1', 'Original_Created_Time']);
    if (origTime && isWithinLastDays(origTime, lookbackDays)) {
      if (!ownerConvertedMap.has(o)) ownerConvertedMap.set(o, []);
      ownerConvertedMap.get(o).push(d);
    }
  }

  // Owners to ignore (case-insensitive, trimmed)
  const IGNORED_OWNERS = [
    'Pardeep Kumar',
    'Vineeth Wankhade',
    'Kedar dharmarajan'
  ].map(x => x.trim().toLowerCase());

  // Build owner stats, excluding ignored owners
  const allOwners = new Set([
    ...Array.from(ownerLeadMap.keys()),
    ...Array.from(ownerConvertedMap.keys()),
    ...todaysLeadRows.map(l => l.owner || '--'),
    ...todaysDeals.map(d => ownerName(d)),
    ...todaysTasks.map(t => ownerName(t))
  ]);

  const ownerStats = Array.from(allOwners)
    .filter(o => !IGNORED_OWNERS.includes(String(o || '').trim().toLowerCase()))
    .map(o => {
      const leads7dArr = ownerLeadMap.get(o) || [];
      const convertedArr = ownerConvertedMap.get(o) || [];
      const todaysLeadsCount = todaysLeadRows.filter(l => (l.owner || '--') === o).length;
      const calledLeads = todaysLeadRows.filter(l => (l.owner || '--') === o && l.called).length;
      const todaysDealsCount = todaysDeals.filter(d => ownerName(d) === o).length;
      const totalTasksCount = todaysTasks.filter(t => ownerName(t) === o).length;
      const completedTasksCount = todaysTasks.filter(t => ownerName(t) === o && isTaskCompleted(t)).length;
      return {
        owner: o,
        todaysLeads: todaysLeadsCount,
        calledLeads,
        leads7d: leads7dArr.length,
        todaysDeals: todaysDealsCount,
        convertedLeads: convertedArr.length,
        leadToDealConversionPercent: leads7dArr.length ? Number(((convertedArr.length / leads7dArr.length) * 100).toFixed(1)) : 0,
        totalTasks: totalTasksCount,
        completedTasks: completedTasksCount,
        taskCompletionPercent: totalTasksCount ? Number(((completedTasksCount / totalTasksCount) * 100).toFixed(1)) : 0,
        retentionPercent: todaysLeadsCount ? Number(((calledLeads / todaysLeadsCount) * 100).toFixed(1)) : 0
      };
    })
    .sort((a, b) => b.todaysLeads - a.todaysLeads);

  // Real retention trend (hourly): for each IST hour, retention% = called leads / leads created in that hour.
  const currentHour = istHour(new Date());
  const hourBuckets = Array.from({ length: (Number.isFinite(currentHour) ? currentHour + 1 : 24) }, (_, i) => i);
  const retentionLabels = hourBuckets.map(h => `${String(h).padStart(2, '0')}:00`);
  const retentionSeries = hourBuckets.map(h => {
    const leadsInHour = todaysLeadRows.filter(l => istHour(l.createdTime) === h);
    if (!leadsInHour.length) return 0;
    const calledInHour = leadsInHour.filter(l => l.called).length;
    return Number(((calledInHour / leadsInHour.length) * 100).toFixed(1));
  });

  // NC time intelligence (past 30 days): NC1/NC2/NC3 hourly counts across all leads in lookback window.
  const ncHourlyMap = new Map(Array.from({ length: 24 }, (_, h) => [h, { nc1: 0, nc2: 0, nc3: 0, total: 0 }]));
  for (const l of ncLookbackLeads) {
    // Peak NC time should reflect when lead is currently marked as NC in CRM,
    // so we bucket by Modified_Time (status update time), not Created_Time.
    const h = istHour(pick(l, ['Modified_Time', 'Created_Time']));
    if (!Number.isInteger(h) || !ncHourlyMap.has(h)) continue;
    const s = ncStage(pick(l, ['Sub_Lead_Status', 'Lead_Sub_Status']));
    const row = ncHourlyMap.get(h);
    if (s === 'NC1') row.nc1 += 1;
    if (s === 'NC2') row.nc2 += 1;
    if (s === 'NC3') row.nc3 += 1;
    row.total = row.nc1 + row.nc2 + row.nc3;
  }

  const allHours = Array.from({ length: 24 }, (_, i) => i);
  const callHourStats = new Map(allHours.map(h => [h, { calls: 0, durSum: 0, connectedLike: 0 }]));
  for (const c of calls) {
    const h = istHour(pick(c, ['Call_Start_Time', 'Created_Time', 'Modified_Time']));
    if (!Number.isInteger(h) || !callHourStats.has(h)) continue;
    const stat = callHourStats.get(h);
    const dur = toNum(pick(c, ['Call_Duration_in_seconds', 'Call_Duration', 'Duration_in_seconds', 'Duration']), 0);
    stat.calls += 1;
    stat.durSum += dur;
    if (dur >= 30) stat.connectedLike += 1; // proxy for successful connection
  }

  const maxCallsInHour = Math.max(1, ...allHours.map(h => callHourStats.get(h).calls));
  const ncTimeRows = allHours.map(h => {
    const nc = ncHourlyMap.get(h);
    const c = callHourStats.get(h);
    const avgDur = c.calls ? c.durSum / c.calls : 0;
    const connectLikeRate = c.calls ? (c.connectedLike / c.calls) : 0;
    const volumeNorm = c.calls / maxCallsInHour;
    // Ideal contact score is based on CALL EFFECTIVENESS (all leads/calls), not NC volume.
    const score = (connectLikeRate * 0.55) + ((Math.min(avgDur, 180) / 180) * 0.30) + (volumeNorm * 0.15);
    return {
      hour: h,
      label: `${String(h).padStart(2, '0')}:00`,
      nc1: nc.nc1,
      nc2: nc.nc2,
      nc3: nc.nc3,
      total: nc.total,
      avgDur: Math.round(avgDur),
      connectLikeRate: Number((connectLikeRate * 100).toFixed(1)),
      score: Number(score.toFixed(3))
    };
  });

  const peakNC1 = [...ncTimeRows].sort((a, b) => b.nc1 - a.nc1)[0] || { label: '--', nc1: 0 };
  const peakNC2 = [...ncTimeRows].sort((a, b) => b.nc2 - a.nc2)[0] || { label: '--', nc2: 0 };
  const ideal = [...ncTimeRows]
    .filter(x => callHourStats.get(x.hour).calls >= 20)
    .sort((a, b) => b.score - a.score)[0] || { label: '--', score: 0, total: 0 };

  // NC ladder analytics (NC1 -> NC2 -> NC3)
  const ncLookbackRows = ncLookbackLeads.map(l => {
    const stage = ncStage(pick(l, ['Sub_Lead_Status', 'Lead_Sub_Status']));
    const created = pick(l, ['Created_Time']);
    const modified = pick(l, ['Modified_Time', 'Created_Time']);
    const elapsedHours = created && modified
      ? Math.max(0, (new Date(modified).getTime() - new Date(created).getTime()) / (1000 * 60 * 60))
      : null;
    return { stage, created, modified, elapsedHours, phone: normalizePhone(pick(l, ['Phone', 'Mobile'])) };
  }).filter(x => x.stage);

  const ncCounts = {
    nc1: ncLookbackRows.filter(x => x.stage === 'NC1').length,
    nc2: ncLookbackRows.filter(x => x.stage === 'NC2').length,
    nc3: ncLookbackRows.filter(x => x.stage === 'NC3').length
  };

  const progression = {
    nc1ToNc2Percent: ncCounts.nc1 ? Number(((ncCounts.nc2 / ncCounts.nc1) * 100).toFixed(1)) : 0,
    nc2ToNc3Percent: ncCounts.nc2 ? Number(((ncCounts.nc3 / ncCounts.nc2) * 100).toFixed(1)) : 0,
    avgHoursNc1ToNc2: (() => {
      const arr = ncLookbackRows.filter(x => x.stage === 'NC2' && Number.isFinite(x.elapsedHours)).map(x => x.elapsedHours);
      return arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : 0;
    })(),
    avgHoursNc2ToNc3: (() => {
      const arr = ncLookbackRows.filter(x => x.stage === 'NC3' && Number.isFinite(x.elapsedHours)).map(x => x.elapsedHours);
      return arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : 0;
    })()
  };

  const nc1ToNc2Sla = toNum(ncSlaHours?.nc1ToNc2, 4);
  const nc2ToNc3Sla = toNum(ncSlaHours?.nc2ToNc3, 24);
  const overdueNc1 = ncLookbackRows.filter(x => x.stage === 'NC1' && Number.isFinite(x.elapsedHours) && x.elapsedHours > nc1ToNc2Sla).length;
  const overdueNc2 = ncLookbackRows.filter(x => x.stage === 'NC2' && Number.isFinite(x.elapsedHours) && x.elapsedHours > nc2ToNc3Sla).length;

  const stageIdeal = {
    nc1: [...ncTimeRows].sort((a, b) => b.nc1 - a.nc1 || b.score - a.score)[0] || { label: '--', nc1: 0, score: 0 },
    nc2: [...ncTimeRows].sort((a, b) => b.nc2 - a.nc2 || b.score - a.score)[0] || { label: '--', nc2: 0, score: 0 },
    nc3: [...ncTimeRows].sort((a, b) => b.nc3 - a.nc3 || b.score - a.score)[0] || { label: '--', nc3: 0, score: 0 }
  };

  return {
    generatedAt: nowIso(),
    kpis: {
      todaysLeadsCount: todaysLeads.length,
      nc1Count,
      nc2Count,
      nc3Count,
      leadToDealConversionPercent: Number(leadToDealConversion.toFixed(1)),
      totalDealsCount: todaysDeals.length,
      totalTasksCount,
      taskCompletionPercent: Number(taskCompletionPercent.toFixed(1)),
      retentionRate: Number((retentionSeries.length ? retentionSeries[retentionSeries.length - 1] : 0).toFixed(1)),
      avgCallDurationSec: Math.round(avgCallDurationSec),
      followupComplianceRate: Number(followupComplianceRate.toFixed(1))
    },
    retention: {
      labels: retentionLabels,
      values: retentionSeries
    },
    calls: {
      labels: dayLabels,
      avgDurationSec: avgDurationByDay,
      callCounts: callCountsByDay
    },
    compliance: {
      called: calledCount,
      notCalled: notCalledCount,
      modifiedWithoutCall
    },
    ncTime: {
      lookbackDays,
      idealHour: ideal.label,
      idealScore: ideal.score,
      peakNC1Hour: peakNC1.label,
      peakNC1Count: peakNC1.nc1,
      peakNC2Hour: peakNC2.label,
      peakNC2Count: peakNC2.nc2,
      labels: ncTimeRows.map(r => r.label),
      nc1: ncTimeRows.map(r => r.nc1),
      nc2: ncTimeRows.map(r => r.nc2)
    },
    ncLadder: {
      lookbackDays,
      // Requested cumulative funnel:
      // NC1 bucket = NC1 + NC2 + NC3
      // NC2 bucket = NC2 + NC3
      // NC3 bucket = NC3
      funnel: {
        nc1: ncCounts.nc1 + ncCounts.nc2 + ncCounts.nc3,
        nc2: ncCounts.nc2 + ncCounts.nc3,
        nc3: ncCounts.nc3
      },
      directFunnel: {
        nc1: ncCounts.nc1,
        nc2: ncCounts.nc2,
        nc3: ncCounts.nc3
      },
      progression,
      sla: {
        nc1ToNc2Hours: nc1ToNc2Sla,
        nc2ToNc3Hours: nc2ToNc3Sla,
        overdueNc1,
        overdueNc2
      },
      idealByStage: {
        nc1: { hour: stageIdeal.nc1.label, count: stageIdeal.nc1.nc1 ?? 0, score: stageIdeal.nc1.score ?? 0 },
        nc2: { hour: stageIdeal.nc2.label, count: stageIdeal.nc2.nc2 ?? 0, score: stageIdeal.nc2.score ?? 0 },
        nc3: { hour: stageIdeal.nc3.label, count: stageIdeal.nc3.nc3 ?? 0, score: stageIdeal.nc3.score ?? 0 }
      }
    },
    categoryConversions: buildCategoryConversions(leads, deals, categoryFields, lookbackDays),
    topBookingAreas: buildTopBookingAreas(deals, 5),
    latestLeadsToday: latestAllLeads,
    overdueFollowups,
    ownerStats
  };
}

async function main() {
  const cfg = await readConfig();
  const token = await getCachedToken(cfg);
  const { leads, calls, deals, tasks } = await fetchData(cfg, token);
  const lookbackDays = toNum(cfg.dashboard?.lookbackDays, 7);
  // Category fields: user can override with cfg.dashboard.categoryFields
  // Default order prefers service-type fields (I_am_looking_for, Service_Category_n) over generic Lead_Source
  const categoryFields = cfg.dashboard?.categoryFields || ['I_am_looking_for', 'Service_Category_n', 'Lead_Source', 'Whatsapp_Category_Service', 'sub_service_category', 'Category', 'Lead_Type', 'Product', 'Service'];
  const metrics = analyze(
    leads,
    calls,
    deals,
    tasks,
    toNum(cfg.dashboard?.overdueMinutes, 30),
    lookbackDays,
    cfg.dashboard?.ncSlaHours || { nc1ToNc2: 4, nc2ToNc3: 24 },
    categoryFields
  );

  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
  const catCount = (metrics.categoryConversions || []).length;
  const areaCount = (metrics.topBookingAreas || []).length;
  console.log(`Dashboard data updated at ${metrics.generatedAt}. Today leads: ${metrics.kpis.todaysLeadsCount}, Today deals: ${metrics.kpis.totalDealsCount}, Today tasks: ${metrics.kpis.totalTasksCount}, Categories: ${catCount}, Top areas: ${areaCount}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});

