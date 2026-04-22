const fs = require("fs");
const Database = require("better-sqlite3");

const {
  HOST_CHANNEL_URL,
  DISCORD_WEBHOOK_URL,
  SPIKE_WEBHOOK_URL,
  WEBHOOK_OVERRIDE_URL,
  WEBHOOK_OVERRIDE_DILUTION_ONLY,
  ARTICLE_CACHE_DIR,
  ARTICLE_FETCH_LOG_FILE,
  INGEST_DATABASE_PATH,
  ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS,
  resolvedEnvFile,
  REPLAY_FILE
} = require("./lib/config");
const { getWebhookTargets } = require("./lib/discord");
const { getReviewQueueSummary, REVIEW_QUEUE_FILE } = require("./lib/reviewQueue");
const { fetchArticleText, getArticleSelectionMeta } = require("./lib/sec");

function check(condition, label, details = null) {
  return {
    label,
    ok: Boolean(condition),
    details
  };
}

function summarizeChecks(checks) {
  return {
    total: checks.length,
    passed: checks.filter(item => item.ok).length,
    failed: checks.filter(item => !item.ok).length
  };
}

async function run() {
  const checks = [];

  checks.push(check(Boolean(resolvedEnvFile && fs.existsSync(resolvedEnvFile)), "Env file resolved", resolvedEnvFile));
  checks.push(check(Boolean(HOST_CHANNEL_URL), "Host channel URL configured", HOST_CHANNEL_URL || null));
  checks.push(check(Boolean(DISCORD_WEBHOOK_URL || WEBHOOK_OVERRIDE_URL), "Default webhook path configured", WEBHOOK_OVERRIDE_URL || DISCORD_WEBHOOK_URL || null));
  checks.push(check(Boolean(ARTICLE_CACHE_DIR), "Article cache dir configured", ARTICLE_CACHE_DIR));
  checks.push(check(Boolean(ARTICLE_FETCH_LOG_FILE), "Live fetch log path configured", ARTICLE_FETCH_LOG_FILE));
  checks.push(check(Array.isArray(ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS), "Shared-cache host list parsed", ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS));
  checks.push(check(REPLAY_FILE ? fs.existsSync(REPLAY_FILE) : true, "Replay file valid when set", REPLAY_FILE || null));

  fs.mkdirSync(ARTICLE_CACHE_DIR, { recursive: true });
  checks.push(check(fs.existsSync(ARTICLE_CACHE_DIR), "Article cache dir accessible", ARTICLE_CACHE_DIR));

  fs.mkdirSync(require("path").dirname(INGEST_DATABASE_PATH), { recursive: true });
  const db = new Database(INGEST_DATABASE_PATH);
  const ingestTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ingest_events'").get();
  checks.push(check(Boolean(ingestTable), "Ingest DB reachable with ingest_events table", INGEST_DATABASE_PATH));
  db.close();

  const reviewSummary = getReviewQueueSummary();
  checks.push(
    check(true, "Review queue summary available", {
      file: REVIEW_QUEUE_FILE,
      count: reviewSummary.count,
      latestQueuedAt: reviewSummary.latestQueuedAt
    })
  );

  const defaultTargets = getWebhookTargets("default", { canDiluteToday: null, earliestDilution: null });
  const spikeTargets = getWebhookTargets("spike", { canDiluteToday: null, earliestDilution: null });
  checks.push(check(defaultTargets.length > 0 || Boolean(WEBHOOK_OVERRIDE_URL), "Default route has webhook target(s)", defaultTargets));
  checks.push(check(spikeTargets.length > 0 || Boolean(WEBHOOK_OVERRIDE_URL), "Spike route has webhook target(s)", spikeTargets));
  checks.push(check(true, "Webhook override mode", {
    overrideUrlSet: Boolean(WEBHOOK_OVERRIDE_URL),
    overrideDilutionOnly: WEBHOOK_OVERRIDE_DILUTION_ONLY
  }));

  const secTestUrl = "https://www.sec.gov/Archives/edgar/data/1892500/000121390026045585/0001213900-26-045585-index.htm";
  await fetchArticleText(secTestUrl, "CMND SEC - Form 6-K - Link");
  const secMeta = getArticleSelectionMeta(secTestUrl);
  checks.push(
    check(
      String(secMeta?.selectedDocumentUrl || "").includes("ex99-1"),
      "SEC selection smoke test chooses EX-99.1 for CMND",
      secMeta
    )
  );

  const summary = summarizeChecks(checks);
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary,
        checks
      },
      null,
      2
    )
  );

  process.exit(summary.failed ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
