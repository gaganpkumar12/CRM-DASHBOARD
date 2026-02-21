let retentionChart, callChart, complianceChart, ncTrendChart, ncFunnelChart, ncFunnelDirectChart;

function triggerSparkle() {
  const fx = document.getElementById('sparkleFx');
  if (!fx) return;
  fx.classList.remove('sparkle-run');
  void fx.offsetWidth;
  fx.classList.add('sparkle-run');
}

function fmtDate(s) {
  if (!s) return "--";
  return new Date(s).toLocaleString();
}

function buildKpis(kpis) {
  const map = [
    ["Today's Leads", kpis.todaysLeadsCount ?? 0],
    ["NC 1 Leads (30d)", kpis.nc1Count ?? 0],
    ["NC 2 Leads (30d)", kpis.nc2Count ?? 0],
    ["NC 3 Leads (30d)", kpis.nc3Count ?? 0],
    ["Lead to Deal Conversion", `${Number(kpis.leadToDealConversionPercent ?? 0).toFixed(1)}%`],
    ["Total Deals", kpis.totalDealsCount ?? 0],
    ["Total Tasks", kpis.totalTasksCount ?? 0],
    ["Task Completion", `${Number(kpis.taskCompletionPercent ?? 0).toFixed(1)}%`],
    ["Avg Call Duration", `${Math.round(kpis.avgCallDurationSec ?? 0)} sec`]
  ];

  document.getElementById("kpiGrid").innerHTML = map.map(([label, value]) => `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>
  `).join("");
}

function destroyCharts() {
  [retentionChart, callChart, complianceChart, ncTrendChart, ncFunnelChart, ncFunnelDirectChart].forEach(c => c && c.destroy());
}

function buildCharts(data) {
  destroyCharts();

  retentionChart = new Chart(document.getElementById("retentionChart"), {
    type: "line",
    data: {
      labels: data.retention.labels,
      datasets: [{ label: "Retention %", data: data.retention.values, borderColor: "#4ea1ff", backgroundColor: "rgba(78,161,255,.2)", fill: true, tension: .35 }]
    },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });

  callChart = new Chart(document.getElementById("callChart"), {
    data: {
      labels: data.calls.labels,
      datasets: [
        { type: "bar", label: "Call Count", data: data.calls.callCounts, backgroundColor: "rgba(78,161,255,.35)" },
        { type: "line", label: "Avg Duration (sec)", data: data.calls.avgDurationSec, borderColor: "#26c281", tension: .3 }
      ]
    },
    options: { responsive: true }
  });

  // Follow-up Compliance chart removed as requested.

  const nc = data.ncTime || {};
  const ncTitleEl = document.getElementById("ncTitle");
  const ncKpisEl = document.getElementById("ncTimeKpis");
  if (ncTitleEl && ncKpisEl) {
    const lookback = Number(nc.lookbackDays ?? 30);
    ncTitleEl.textContent = `NC's Best Time Insights (Overall NC1/NC2/NC3 - Last ${lookback} Days)`;
    ncKpisEl.innerHTML = `
      <div class="kpi"><div class="label">Ideal Contact Time</div><div class="value">${nc.idealHour ?? "--"}</div></div>
      <div class="kpi"><div class="label">Ideal Score</div><div class="value">${Number(nc.idealScore ?? 0).toFixed(2)}</div></div>
      <div class="kpi"><div class="label">Peak NC1 Time</div><div class="value">${nc.peakNC1Hour ?? "--"} (${nc.peakNC1Count ?? 0})</div></div>
      <div class="kpi"><div class="label">Peak NC2 Time</div><div class="value">${nc.peakNC2Hour ?? "--"} (${nc.peakNC2Count ?? 0})</div></div>
    `;
  }

  const ncTrendCanvas = document.getElementById("ncTrendChart");
  if (ncTrendCanvas) {
    ncTrendChart = new Chart(ncTrendCanvas, {
      type: "line",
      data: {
        labels: nc.labels || [],
        datasets: [
          { label: "NC 1", data: nc.nc1 || [], borderColor: "#4ea1ff", tension: 0.3 },
          { label: "NC 2", data: nc.nc2 || [], borderColor: "#ffb020", tension: 0.3 }
        ]
      },
      options: { responsive: true }
    });
  }

  const ladder = data.ncLadder || {};
  document.getElementById("ncLadderTitle").textContent = `NC Ladder Intelligence (Last ${Number(ladder.lookbackDays ?? 30)} Days)`;
  document.getElementById("ncLadderKpis").innerHTML = `
    <div class="kpi"><div class="label">NC1 → NC2 Progression</div><div class="value">${Number(ladder.progression?.nc1ToNc2Percent ?? 0).toFixed(1)}%</div></div>
    <div class="kpi"><div class="label">NC2 → NC3 Progression</div><div class="value">${Number(ladder.progression?.nc2ToNc3Percent ?? 0).toFixed(1)}%</div></div>
    <div class="kpi"><div class="label">Avg Hrs NC1 → NC2</div><div class="value">${Number(ladder.progression?.avgHoursNc1ToNc2 ?? 0).toFixed(1)}h</div></div>
    <div class="kpi"><div class="label">Avg Hrs NC2 → NC3</div><div class="value">${Number(ladder.progression?.avgHoursNc2ToNc3 ?? 0).toFixed(1)}h</div></div>
    <div class="kpi"><div class="label">Overdue NC1 (SLA)</div><div class="value">${ladder.sla?.overdueNc1 ?? 0}</div></div>
    <div class="kpi"><div class="label">Overdue NC2 (SLA)</div><div class="value">${ladder.sla?.overdueNc2 ?? 0}</div></div>
  `;

  ncFunnelChart = new Chart(document.getElementById("ncFunnelChart"), {
    type: "bar",
    data: {
      labels: ["NC1", "NC2", "NC3"],
      datasets: [{
        label: "Lead Count",
        data: [ladder.funnel?.nc1 || 0, ladder.funnel?.nc2 || 0, ladder.funnel?.nc3 || 0],
        backgroundColor: ["rgba(100,181,255,.7)", "rgba(255,176,32,.75)", "rgba(255,93,115,.75)"]
      }]
    },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });

  ncFunnelDirectChart = new Chart(document.getElementById("ncFunnelDirectChart"), {
    type: "bar",
    data: {
      labels: ["NC1", "NC2", "NC3"],
      datasets: [{
        label: "Direct Count",
        data: [ladder.directFunnel?.nc1 || 0, ladder.directFunnel?.nc2 || 0, ladder.directFunnel?.nc3 || 0],
        backgroundColor: ["rgba(78,161,255,.75)", "rgba(255,176,32,.75)", "rgba(255,93,115,.75)"]
      }]
    },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
}

function buildTables(data) {
  document.getElementById("latestLeadsBody").innerHTML = (data.latestLeadsToday || []).map(l => `
    <tr>
      <td>${l.name ?? "--"}</td>
      <td>${l.phone ?? "--"}</td>
      <td>${l.owner ?? "--"}</td>
      <td>${l.leadStatus ?? "--"}</td>
      <td>${l.leadSubStatus ?? "--"}</td>
      <td><span class="status-badge ${l.called ? "called-yes" : "called-no"}">${l.called ? "Yes" : "No"}</span></td>
      <td>${fmtDate(l.modifiedTime)}</td>
    </tr>
  `).join("");

  document.getElementById("ownerRetentionBody").innerHTML = (data.ownerStats || []).map(r => `
    <tr>
      <td>${r.owner ?? "--"}</td>
      <td>${r.todaysLeads ?? 0}</td>
      <td>${r.calledLeads ?? 0}</td>
      <td>${Number(r.retentionPercent ?? 0).toFixed(1)}%</td>
    </tr>
  `).join("");

  const stageIdeal = data.ncLadder?.idealByStage || {};
  document.getElementById("ncIdealStageBody").innerHTML = [
    ["NC1", stageIdeal.nc1],
    ["NC2", stageIdeal.nc2],
    ["NC3", stageIdeal.nc3]
  ].map(([stage, row]) => `
    <tr>
      <td>${stage}</td>
      <td>${row?.hour ?? "--"}</td>
      <td>${row?.count ?? 0}</td>
      <td>${Number(row?.score ?? 0).toFixed(3)}</td>
    </tr>
  `).join("");

  document.getElementById("ownerStatsBody").innerHTML = (data.ownerStats || []).map(r => `
    <tr>
      <td>${r.owner ?? "--"}</td>
      <td>${r.todaysLeads ?? 0}</td>
      <td>${r.todaysDeals ?? 0}</td>
      <td>${Number(r.leadToDealConversionPercent ?? 0).toFixed(1)}%</td>
      <td>${r.totalTasks ?? 0}</td>
      <td>${r.completedTasks ?? 0}</td>
      <td>${Number(r.taskCompletionPercent ?? 0).toFixed(1)}%</td>
      <td>${Number(r.retentionPercent ?? 0).toFixed(1)}%</td>
    </tr>
  `).join("");
}

async function loadData() {
  const r = await fetch(`data/metrics.json?t=${Date.now()}`);
  const data = await r.json();
  const updatedAt = data.generatedAt;
  const ageMinutes = updatedAt ? Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000) : null;
  const freshness = ageMinutes === null ? '' : ageMinutes <= 5 ? '🟢' : ageMinutes <= 30 ? '🟡' : '🔴';
  const ageLabel = ageMinutes === null ? '' : ageMinutes <= 1 ? ' (just now)' : ageMinutes < 60 ? ` (${ageMinutes}m ago)` : ` (${(ageMinutes / 60).toFixed(1)}h ago)`;
  document.getElementById("lastUpdated").textContent = `${freshness} Last updated: ${fmtDate(data.generatedAt)}${ageLabel}`;
  buildKpis(data.kpis || {});
  buildCharts(data);
  buildTables(data);
}

const manualRefreshBtn = document.getElementById('manualRefreshBtn');
if (manualRefreshBtn) {
  manualRefreshBtn.addEventListener('click', async () => {
    try {
      manualRefreshBtn.disabled = true;
      manualRefreshBtn.textContent = 'Refreshing...';
      triggerSparkle();
      await loadData();
    } finally {
      manualRefreshBtn.disabled = false;
      manualRefreshBtn.textContent = '↻ Refresh';
    }
  });
}

triggerSparkle();
loadData();

// Auto-refresh every 6 hours so cards stay up to date
setInterval(() => {
  loadData().then(() => {
    const ts = document.getElementById('lastUpdated')?.textContent || '';
    console.log('[auto-refresh]', ts);
  }).catch(err => console.error('Auto-refresh failed:', err));
}, 6 * 60 * 60 * 1000);
