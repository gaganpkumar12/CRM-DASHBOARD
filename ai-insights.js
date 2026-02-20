let talkTimeChart;

function fmtDate(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString();
}

function percent(val) {
  return `${Number(val ?? 0).toFixed(1)}%`;
}

function buildKpis(analysis = {}, sampleSize = 0) {
  const zeroShare = (analysis.bucketSummary || []).find(b => b.bucket === "0s")?.percent ?? 0;
  const outboundShare = (analysis.typeSummary || []).find(t => t.type === "Outbound")?.percent ?? 0;
  const inboundShare = (analysis.typeSummary || []).find(t => t.type === "Inbound")?.percent ?? 0;

  const kpis = [
    ["Total Calls", sampleSize],
    ["Connected Calls", analysis.connectedCalls ?? 0],
    ["Avg Duration", `${Number(analysis.avgDurationSec ?? 0).toFixed(1)} s`],
    ["Median Duration", `${Number(analysis.medianDurationSec ?? 0).toFixed(0)} s`],
    ["Zero-duration Share", percent(zeroShare)],
    ["Outbound vs Inbound", `${percent(outboundShare)} / ${percent(inboundShare)}`]
  ];

  document.getElementById("aiKpiGrid").innerHTML = kpis.map(([label, value]) => `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>
  `).join("");
}

function buildList(targetId, rows = []) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.innerHTML = rows.map(r => `
    <li>
      <strong>${r.label}</strong>
      <span>${r.value}</span>
    </li>
  `).join("");
}

function buildTalkTime(analysis = {}) {
  const canvas = document.getElementById("talkTimeChart");
  if (!canvas) return;
  const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);
  const talkSeconds = analysis.hourlyTalkSeconds || Array(24).fill(0);
  const minutes = labels.map((_, idx) => Number(((talkSeconds[idx] || 0) / 60).toFixed(1)));

  if (talkTimeChart) talkTimeChart.destroy();
  talkTimeChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Talk Minutes",
        data: minutes,
        backgroundColor: "rgba(100, 181, 255, 0.5)",
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { title: { display: true, text: "Minutes" } }
      }
    }
  });

  const totalTalkSeconds = analysis.totalTalkSeconds || 0;
  const totalTalkHours = (totalTalkSeconds / 3600).toFixed(1);
  const avgConnectMinutes = analysis.connectedCalls ? ((totalTalkSeconds / analysis.connectedCalls) / 60).toFixed(1) : "0.0";
  const peakIndex = talkSeconds.reduce((best, value, idx, arr) => value > arr[best] ? idx : best, 0);
  const peakLabel = labels[peakIndex];

  buildList("talkTimeStats", [
    { label: "Total Talk Time", value: `${totalTalkHours} hrs` },
    { label: "Avg Talk / Connect", value: `${avgConnectMinutes} min` },
    { label: "Peak Talk Hour", value: peakLabel }
  ]);
}

function buildTalkLeaderboard(analysis = {}) {
  const tbody = document.getElementById("talkLeaderboard");
  if (!tbody) return;
  const rows = (analysis.ownerSummary || [])
    .map(owner => {
      const totalTalkMinutes = ((owner.avgDurationSec ?? 0) * (owner.connectedCalls ?? 0)) / 60;
      const avgMinutes = (owner.avgDurationSec ?? 0) / 60;
      return {
        owner: owner.owner,
        talkMinutes: totalTalkMinutes,
        connected: owner.connectedCalls ?? 0,
        avgMinutes
      };
    })
    .sort((a, b) => b.talkMinutes - a.talkMinutes)
    .map(row => `
      <tr>
        <td>${row.owner}</td>
        <td>${row.talkMinutes.toFixed(1)}</td>
        <td>${row.connected}</td>
        <td>${row.avgMinutes.toFixed(2)}</td>
      </tr>`)
    .join("");
  tbody.innerHTML = rows;
}

function normalizePhoneNumber(value) {
  if (!value) return null;
  return String(value).replace(/\D/g, '').slice(-10);
}

function groupLeadsByPhone(leads = []) {
  const map = new Map();
  leads.forEach(lead => {
    const phone = normalizePhoneNumber(lead.phone);
    if (!phone) return;
    if (!map.has(phone)) map.set(phone, []);
    map.get(phone).push(lead);
  });
  return map;
}

function buildRepeatLossSection(metrics = {}) {
  const container = document.getElementById("repeatLossContent");
  if (!container) return;
  const leads = metrics.latestLeadsToday || [];
  const rejected = leads.filter(l => {
    const status = (l.leadStatus || l.leadSubStatus || "").toLowerCase();
    return status.includes("reject");
  });
  const phoneGroups = groupLeadsByPhone(leads);
  const summary = { new: 0, returning: 0, repeat: 0 };
  const agentMap = new Map();
  const reasonCounts = new Map();

  rejected.forEach(lead => {
    const phone = normalizePhoneNumber(lead.phone);
    const groupSize = phone && phoneGroups.get(phone) ? phoneGroups.get(phone).length : 1;
    const kind = groupSize <= 1 ? "new" : (groupSize === 2 ? "returning" : "repeat");
    summary[kind] += 1;
    const agent = lead.owner || "Unassigned";
    if (!agentMap.has(agent)) {
      agentMap.set(agent, { total: 0, repeat: 0, reasons: new Map(), calls: 0 });
    }
    const agentRow = agentMap.get(agent);
    agentRow.total += 1;
    if (kind === "repeat") agentRow.repeat += 1;
    const reason = lead.leadSubStatus || lead.leadStatus || "Unknown";
    agentRow.reasons.set(reason, (agentRow.reasons.get(reason) || 0) + 1);
    agentRow.calls += lead.called ? 1 : 0;
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  });

  const totalRejected = rejected.length;
  const repeatLossPercent = totalRejected ? ((summary.returning + summary.repeat) / totalRejected * 100).toFixed(1) : 0;
  const topReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Data pending";
  const repeatStage = metrics.ncLadder?.progression || {};
  const dropStage = Object.entries(repeatStage)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => (a.value || 0) - (b.value || 0))[0];
  const stageMessage = dropStage ? `${dropStage.key.replace(/([A-Z])/g, ' $1').trim()} (${dropStage.value}%)` : "Waiting for CRM data";

  const agentRows = [...agentMap.entries()].sort(([, a], [, b]) => (b.repeat / Math.max(b.total, 1)) - (a.repeat / Math.max(a.total, 1))).slice(0, 4);
  const agentTable = agentRows.length ? `
    <table>
      <thead><tr><th>Agent</th><th>Repeat Loss %</th><th>Top Repeat Reason</th></tr></thead>
      <tbody>
        ${agentRows.map(([name, row]) => {
          const rate = row.total ? ((row.repeat / row.total) * 100).toFixed(1) : "0.0";
          const reason = [...row.reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";
          return `<tr><td>${name}</td><td>${rate}%</td><td>${reason}</td></tr>`;
        }).join("")}
      </tbody>
    </table>
  ` : `<p class="muted">Agent-level repeat loss data will surface after the next fetch.</p>`;

  container.innerHTML = `
    <div class="insight-grid">
      <div class="insight-block">
        <strong>Company KPIs</strong>
        <p>Total rejected leads: <strong>${totalRejected}</strong></p>
        <p>Repeat losses (returning + repeat): <strong>${summary.returning + summary.repeat}</strong> (${repeatLossPercent}%)</p>
        <p>Split: New ${summary.new} / Returning ${summary.returning} / Repeat ${summary.repeat}</p>
      </div>
      <div class="insight-block">
        <strong>Agent ranking</strong>
        ${agentTable}
      </div>
      <div class="insight-block">
        <strong>Patterns</strong>
        <p>Drop stage: ${stageMessage}</p>
        <p>Top repeat rejection reason: ${topReason}</p>
        <ul>
          <li>Average call touches before repeat rejection: ~${totalRejected ? Math.max(1, (summary.returning + summary.repeat)) : 0}</li>
          <li>Most rejected status: ${topReason}</li>
        </ul>
      </div>
      <div class="insight-block">
        <strong>Recommendations</strong>
        <ul>
          <li>Triage repeat leads with ${topReason} substatus within 4h.</li>
          <li>Give returning customers a dedicated agent (top agent: ${agentRows[0]?.[0] || 'TBD'}).</li>
          <li>Normalize lead sources and tag them before repeat assignments.</li>
          <li>Document call scripts per stage drop (see ${stageMessage}).</li>
          <li>Cross-train teams on repeat/service patterns (data captured via repeated phone numbers).</li>
        </ul>
      </div>
    </div>
  `;
}

function buildEngagementSection(metrics = {}) {
  const container = document.getElementById("engagementContent");
  if (!container) return;
  const leads = metrics.latestLeadsToday || [];
  const phoneGroups = groupLeadsByPhone(leads);
  const now = Date.now();
  const customers = [...phoneGroups.entries()].map(([phone, records]) => {
    const recency = records[0]?.createdTime ? Math.max(0, (now - new Date(records[0].createdTime).getTime()) / (1000 * 60 * 60 * 24)) : 0;
    const connectedCalls = records.filter(r => r.called).length;
    const diversity = new Set(records.map(r => r.leadStatus)).size;
    const score = Math.min(100, Math.round(40 + connectedCalls * 15 + (records.length > 1 ? 15 : 0) + (recency <= 7 ? 15 : 0) + (diversity > 1 ? 10 : 0)));
    const status = records[0]?.leadStatus || "Open";
    return { phone, records, score, recencyDays: Math.round(recency), status };
  });
  const classification = { high: 0, stable: 0, atRisk: 0, weak: 0 };
  customers.forEach(customer => {
    if (customer.score >= 80) classification.high += 1;
    else if (customer.score >= 60) classification.stable += 1;
    else if (customer.score >= 40) classification.atRisk += 1;
    else classification.weak += 1;
  });
  const highActive = customers.filter(c => !c.status.toLowerCase().includes("reject")).sort((a, b) => b.score - a.score).slice(0, 20);
  const highRejected = customers.filter(c => c.status.toLowerCase().includes("reject")).sort((a, b) => b.score - a.score).slice(0, 20);
  const servicePattern = leads.reduce((acc, lead) => {
    const key = lead.leadSubStatus || lead.leadStatus || "Unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const topService = Object.entries(servicePattern).sort((a, b) => b[1] - a[1])[0]?.[0] || "TBD";

  const totalCustomers = customers.length;

  container.innerHTML = `
    <div class="insight-grid">
      <div class="insight-block">
        <strong>Engagement Distribution</strong>
        <p class="metric-how">How we score: Every unique phone number gets a score out of 100 based on — calls connected (+15 per call), seen more than once (+15), contacted in last 7 days (+15), and multiple lead stages (+10). Customers are then grouped into buckets below.</p>
        <p>Total customers scored: <strong>${totalCustomers}</strong></p>
        <p>🟢 Highly Engaged (80–100): <strong>${classification.high}</strong></p>
        <p>🔵 Stable (60–79): <strong>${classification.stable}</strong></p>
        <p>🟡 At Risk (40–59): <strong>${classification.atRisk}</strong></p>
        <p>🔴 Weak / Low (&lt;40): <strong>${classification.weak}</strong></p>
      </div>
      <div class="insight-block">
        <strong>Top Active High-Engagement Leads</strong>
        <p class="metric-how">These are the top 20 highest-scored customers whose current status is <em>not</em> Rejected — i.e., warm leads still in play. Higher score = more calls answered, recent activity, and repeat interest.</p>
        <ul>
          ${highActive.map(c => `<li>${c.phone} — Score ${c.score} (last seen ${c.recencyDays}d ago)</li>`).join('') || '<li class="muted">No high-engagement active leads yet.</li>'}
        </ul>
      </div>
      <div class="insight-block">
        <strong>Top Rejected High-Engagement Leads</strong>
        <p class="metric-how">These are the top 20 highest-scored customers who are currently marked Rejected. A high score here means the customer was engaged (answered calls, came back multiple times) but still got rejected — prime candidates for a win-back attempt.</p>
        <ul>
          ${highRejected.map(c => `<li>${c.phone} — Score ${c.score} (last seen ${c.recencyDays}d ago)</li>`).join('') || '<li class="muted">No rejected high-engagement leads yet.</li>'}
        </ul>
      </div>
      <div class="insight-block">
        <strong>Patterns & Recommendations</strong>
        <p class="metric-how">Patterns are found by counting which service sub-status appears most often across all leads. The trend compares Highly Engaged vs At Risk counts to gauge overall momentum.</p>
        <p>Top service theme: <strong>${topService}</strong></p>
        <p>Trend: ${classification.high >= classification.atRisk ? '📈 Engagement skewing positive — more highly engaged than at-risk' : '📉 Re-engagement needed — at-risk customers outnumber highly engaged'}</p>
        <ul>
          <li>Prioritize callbacks for ${highActive.length || '0'} high-engagement active leads.</li>
          <li>Share the winning approach with ${metrics.ownerStats?.[0]?.owner || 'top agents'}.</li>
          <li>Track monthly engagement score changes to spot trends early.</li>
        </ul>
      </div>
    </div>
  `;
}

function buildWinBackSection(metrics = {}) {
  const container = document.getElementById("winBackContent");
  if (!container) return;
  const leads = metrics.latestLeadsToday || [];
  const phoneGroups = groupLeadsByPhone(leads);
  const rejected = leads.filter(l => {
    const status = (l.leadStatus || l.leadSubStatus || "").toLowerCase();
    return status.includes("reject");
  });
  const repeatCandidates = rejected.filter(lead => {
    const phone = normalizePhoneNumber(lead.phone);
    const group = phone && phoneGroups.get(phone) ? phoneGroups.get(phone) : [];
    return group.length >= 2;
  });
  const now = Date.now();
  const scored = repeatCandidates.map(lead => {
    const phone = normalizePhoneNumber(lead.phone) || "unknown";
    const group = phone && phoneGroups.get(phone) ? phoneGroups.get(phone) : [];
    const recency = lead.createdTime ? Math.max(0, (now - new Date(lead.createdTime).getTime()) / (1000 * 60 * 60 * 24)) : 0;
    const engaged = group.filter(r => r.called).length;
    const repeats = group.length;
    const base = 40 + engaged * 10 + (repeats > 2 ? 10 : 0) + Math.max(0, 30 - recency) * 0.5;
    const penalty = (recency > 90 ? 10 : 0) + ((lead.leadSubStatus || "").toLowerCase().includes("price") ? 10 : 0);
    const score = Math.max(0, Math.min(100, Math.round(base - penalty)));
    return {
      phone,
      score,
      agent: lead.owner || "Unassigned",
      service: lead.leadSubStatus || "Service TBD",
      recencyDays: Math.round(recency)
    };
  }).sort((a, b) => b.score - a.score).slice(0, 10);

  const highCount = scored.filter(c => c.score >= 80).length;
  const recoverableRate = repeatCandidates.length ? Math.round((highCount / repeatCandidates.length) * 100) : 0;

  container.innerHTML = `
    <div class="insight-grid">
      <div class="insight-block">
        <strong>Win-back company metrics</strong>
        <p>Repeat rejects (last 7d slice): ${repeatCandidates.length}</p>
        <p>Immediate targets (score ≥80): ${highCount}</p>
        <p>Recoverable chance: ${recoverableRate}%</p>
      </div>
      <div class="insight-block">
        <strong>Top win-back targets</strong>
        <ul>
          ${scored.map(target => `<li>${target.phone} — Score ${target.score} • ${target.service} • Agent ${target.agent}</li>`).join('') || '<li class="muted">No high-probability targets right now.</li>'}
        </ul>
      </div>
      <div class="insight-block">
        <strong>Patterns</strong>
        <p>Service types present: ${[...new Set(scored.map(c => c.service))].join(', ') || 'TBD'}</p>
        <p>Stage drop signals derived from NC ladder (use existing NC insight section).</p>
      </div>
      <div class="insight-block">
        <strong>Recovery recommendations</strong>
        <ul>
          <li>Sequence WhatsApp + call within 24h for the top ${highCount} leads.</li>
          <li>Use the “Trusted repeat” script referencing prior service.</li>
          <li>Route recoverable leads to low repeat-loss agents.</li>
          <li>Log rejection reason + service type for future automation.</li>
          <li>Monitor NC drop stage for each win-back attempt.</li>
        </ul>
      </div>
    </div>
  `;
}

function buildAgentTable(analysis = {}) {
  const body = document.getElementById('agentInsightsBody');
  if (!body) return;
  const rows = (analysis.ownerSummary || []).map(owner => {
    const zeroBucket = owner.bucketBreakdown?.find(b => b.bucket === '0s')?.percent ?? 0;
    const insights = generateAgentInsightDetails(owner, zeroBucket);
    return `
      <tr>
        <td>${owner.owner}</td>
        <td>${owner.totalCalls}</td>
        <td>${owner.connectedCalls}</td>
        <td>${percent(owner.connectionRatePercent)}</td>
        <td>${Number(owner.avgDurationSec ?? 0).toFixed(1)}</td>
        <td>${percent(zeroBucket)}</td>
        <td>${((owner.avgBookingSeconds ?? 0) / 60).toFixed(2)} min</td>
        <td>
          <div class="insight-card">
            <div class="insight-detail">
              <strong>Pros</strong>
              ${insights.pros.length ? `<p>${insights.pros.join('<br>')}</p>` : `<p class="muted">No obvious advantages yet.</p>`}
            </div>
            <div class="insight-detail">
              <strong>Cons</strong>
              ${insights.cons.length ? `<p>${insights.cons.join('<br>')}</p>` : `<p class="muted">No immediate alerts.</p>`}
            </div>
            <div class="insight-detail">
              <strong>Action</strong>
              <p>${insights.action}</p>
            </div>
          </div>
        </td>
        <td>
          <div class="insight-evidence">
            <strong>How we know</strong>
            <p>${insights.evidence.join(' • ')}</p>
          </div>
        </td>
        <td>${owner.peakHour ?? '--'}</td>
      </tr>`;
  }).join('');
  body.innerHTML = rows;
}

function generateAgentInsightDetails(owner, zeroShare) {
  const pros = [];
  const cons = [];
  const evidence = [];

  const avgDuration = Number(owner.avgDurationSec ?? 0);
  const connectedRate = Number(owner.connectionRatePercent ?? 0);
  const zeroPct = Number(zeroShare ?? 0);
  const bucketTop = owner.bucketBreakdown?.[0];

  if (connectedRate >= 60) {
    pros.push("High connect rate; keeps pipeline moving.");
  }
  if (avgDuration >= 110) {
    pros.push("Calls stay deep (avg ≥ 110s), good discoverability.");
  }
  if (bucketTop && bucketTop.bucket !== "0s" && bucketTop.percent > 15) {
    pros.push(`Strong share in ${bucketTop.bucket} bucket (${bucketTop.percent}% of attempts).`);
  }
  if (connectedRate < 45) {
    cons.push("Connect % is low — consider cleaner lists or tighter callback SLAs.");
  }
  if (zeroPct >= 50) {
    cons.push(`Over ${zeroPct.toFixed(1)}% zero-duration dials — audit the dialer or scripts.`);
  }
  if (avgDuration < 70) {
    cons.push("Calls feel rushed; add discovery prompts to extend talk time.");
  }
  if (avgDuration > 180) {
    cons.push("Super long calls; make sure every conversation closes with an ask.");
  }

  const actions = [];
  if (cons.length) {
    actions.push("Address the top red flag (e.g., list quality or pacing).");
  }
  if (pros.length) {
    actions.push("Document this playbook and replicate across reps.");
  }
  if (!actions.length) {
    actions.push("Continue monitoring; no immediate shifts needed.");
  }

  evidence.push(`Connect rate ${connectedRate}%`);
  evidence.push(`Avg duration ${avgDuration.toFixed(1)}s`);
  evidence.push(`Zero-duration ${zeroPct.toFixed(1)}%`);
  if (owner.connectedCalls) evidence.push(`${owner.connectedCalls} connects logged`);
  if (bucketTop) evidence.push(`Top bucket ${bucketTop.bucket} (${bucketTop.percent}%)`);

  return {
    pros,
    cons,
    action: actions.join(' '),
    evidence
  };
}

const DEFAULT_CALLS_FILE = 'data/bulk-call-analysis-7d-full.json';
const DEFAULT_METRICS_FILE = 'data/metrics.json';

function callsFilePath() {
  const params = new URLSearchParams(window.location.search);
  const overrideFile = params.get('callsFile');
  return `${overrideFile || DEFAULT_CALLS_FILE}?t=${Date.now()}`;
}

function metricsFilePath() {
  const params = new URLSearchParams(window.location.search);
  const overrideFile = params.get('metricsFile');
  return `${overrideFile || DEFAULT_METRICS_FILE}?t=${Date.now()}`;
}

async function loadAiInsights() {
  const [callsRes, metricsRes] = await Promise.all([
    fetch(callsFilePath()),
    fetch(metricsFilePath())
  ]);

  if (!callsRes.ok) throw new Error("Unable to load call analytics");
  if (!metricsRes.ok) throw new Error("Unable to load CRM metrics");

  const callsPayload = await callsRes.json();
  const metrics = await metricsRes.json();

  const callAnalysis = callsPayload.analysis || {};
  const sampleSize = callsPayload.sampleSize ?? callAnalysis.totalCalls ?? 0;
  const updatedAt = callAnalysis.generatedAt && !Number.isNaN(new Date(callAnalysis.generatedAt).getTime())
    ? callAnalysis.generatedAt
    : new Date().toISOString();

  document.getElementById("aiLastUpdated").textContent = `Last updated: ${fmtDate(updatedAt)}`;
  document.getElementById("aiMeta").textContent = `Live aggregation of the most recent ${sampleSize.toLocaleString()} calls.`;

  // Call analytics (from bulk-call-analysis)
  buildKpis(callAnalysis, sampleSize);
  buildList("aiBucketList", (callAnalysis.bucketSummary || []).map(item => ({
    label: item.bucket,
    value: `${item.count.toLocaleString()} • ${percent(item.percent)}`
  })));
  buildList("aiStatusList", (callAnalysis.statusSummary || []).map(item => ({
    label: item.status,
    value: `${item.count.toLocaleString()} • ${percent(item.percent)}`
  })));
  buildTalkTime(callAnalysis);
  buildTalkLeaderboard(callAnalysis);
  buildAgentTable(callAnalysis);

  // CRM-derived analytics (Repeat Loss, Engagement, Win-Back) from metrics.json
  buildRepeatLossSection(metrics);
  buildEngagementSection(metrics);
  buildWinBackSection(metrics);
}

const aiRefreshBtn = document.getElementById("aiRefreshBtn");
if (aiRefreshBtn) {
  aiRefreshBtn.addEventListener("click", async () => {
    try {
      aiRefreshBtn.disabled = true;
      aiRefreshBtn.textContent = "Refreshing...";
      await loadAiInsights();
    } catch (err) {
      console.error(err);
      alert("Unable to refresh AI insights right now.");
    } finally {
      aiRefreshBtn.disabled = false;
      aiRefreshBtn.textContent = "↻ Refresh Insights";
    }
  });
}

loadAiInsights().catch(err => console.error(err));
