const fs = require('fs');
const path = require('path');

const metricsPath = path.join(__dirname, '..', 'data', 'metrics.json');
const day = new Date().toISOString().slice(0, 10);

const raw = fs.readFileSync(metricsPath, 'utf8');
const data = JSON.parse(raw);
const counts = {};
for (const lead of data.latestLeadsToday || []) {
  const created = lead.createdTime || '';
  if (!created.startsWith(day)) continue;
  const owner = lead.owner || 'Unassigned';
  counts[owner] = (counts[owner] || 0) + 1;
}
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
console.log(JSON.stringify({
  generatedAt: data.generatedAt,
  todaysLeadsCount: data.kpis?.todaysLeadsCount ?? null,
  breakdown: sorted
}, null, 2));
