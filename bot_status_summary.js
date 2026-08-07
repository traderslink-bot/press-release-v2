const Database = require("better-sqlite3");
const { INGEST_DATABASE_PATH } = require("./lib/config");

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function ageLabel(value) {
  if (!value) return "n/a";
  const ageMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ageMs)) return "n/a";
  const minutes = Math.max(0, Math.round(ageMs / 60000));
  if (minutes < 1) return "<1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function postedCount(row) {
  const posted = parseJson(row.posted_messages_json, []);
  return Array.isArray(posted) ? posted.length : 0;
}

function reasonLabel(row) {
  const reasons = parseJson(row.reason_codes_json, []);
  if (Array.isArray(reasons) && reasons.length) {
    return reasons.slice(-3).join(", ");
  }
  return row.process_status || "unknown";
}

const db = new Database(INGEST_DATABASE_PATH, { readonly: true });

const counts = db.prepare(`
  select process_status, count(*) as count
  from ingest_events
  group by process_status
  order by process_status
`).all();

const recent = db.prepare(`
  select ticker, route_tag, observed_at, process_status, headline, posted_messages_json, reason_codes_json, processing_error
  from ingest_events
  order by datetime(observed_at) desc
  limit 12
`).all();

const recentFailures = db.prepare(`
  select count(*) as count, max(updated_at) as latest
  from ingest_events
  where process_status = 'failed'
    and datetime(updated_at) > datetime('now', '-2 hours')
`).get();

console.log(`\nTraderLink PR V2 status @ ${new Date().toLocaleString()}`);
console.log(`DB: ${INGEST_DATABASE_PATH}`);
console.log(
  `Queue: ${counts.map(row => `${row.process_status}=${row.count}`).join(" | ") || "empty"}`
);
console.log(
  `Recent failures: ${recentFailures.count || 0}` +
    (recentFailures.latest ? ` latest ${ageLabel(recentFailures.latest)}` : "")
);
console.log("\nLatest observed host messages:");

for (const row of recent) {
  const posts = postedCount(row);
  const status = posts > 0 ? `POSTED x${posts}` : row.process_status === "failed" ? "FAILED" : "not posted";
  const headline = String(row.headline || row.processing_error || "").replace(/\s+/g, " ").slice(0, 90);
  console.log(
    `${ageLabel(row.observed_at).padEnd(8)} ` +
      `${String(row.route_tag || "default").padEnd(20)} ` +
      `${String(row.ticker || "?").padEnd(7)} ` +
      `${status.padEnd(10)} ` +
      `${reasonLabel(row)} ` +
      `${headline ? `- ${headline}` : ""}`
  );
}
