const fs = require("fs");
const Database = require("better-sqlite3");

const {
  HOST_CHANNEL_URL,
  DISCORD_WEBHOOK_URL,
  WEBHOOK_OVERRIDE_URL,
  WEBHOOK_OVERRIDE_DILUTION_ONLY,
  MARKET_CAP_HOST_CHANNEL_URL,
  MARKET_CAP_UNDER_30M_WEBHOOK_URL,
  MARKET_CAP_30M_TO_50M_WEBHOOK_URL,
  MARKET_CAP_30M_TO_50M_MIN,
  MARKET_CAP_30M_TO_50M_LIMIT,
  MARKET_CAP_50M_TO_100M_WEBHOOK_URL,
  MARKET_CAP_50M_TO_100M_MIN,
  MARKET_CAP_50M_TO_100M_LIMIT,
  MARKET_CAP_MAX_EVENT_AGE_MS,
  HOST_DISCORD_MAX_EVENT_AGE_MS,
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

function redactConfiguredTargets(targets) {
  return {
    count: Array.isArray(targets) ? targets.filter(Boolean).length : 0,
    configured: Array.isArray(targets) ? targets.filter(Boolean).map(() => "<configured>") : []
  };
}

async function run() {
  const checks = [];

  checks.push(check(Boolean(resolvedEnvFile && fs.existsSync(resolvedEnvFile)), "Env file resolved", resolvedEnvFile));
  checks.push(check(Boolean(HOST_CHANNEL_URL), "Host channel URL configured", HOST_CHANNEL_URL || null));
  checks.push(check(
    String(HOST_CHANNEL_URL || "").includes("/1139240765260836936"),
    "PR filtered-news host channel matches expected",
    HOST_CHANNEL_URL || null
  ));
  checks.push(check(
    String(MARKET_CAP_HOST_CHANNEL_URL || "").includes("/1280514882676199506"),
    "Market-cap under-30M host channel matches expected",
    MARKET_CAP_HOST_CHANNEL_URL || null
  ));
  checks.push(check(
    Number(MARKET_CAP_MAX_EVENT_AGE_MS) > 0 && Number(MARKET_CAP_MAX_EVENT_AGE_MS) <= 30000,
    "Market-cap scanner freshness window is tight",
    MARKET_CAP_MAX_EVENT_AGE_MS
  ));
  checks.push(check(
    Number(HOST_DISCORD_MAX_EVENT_AGE_MS) === 2 * 60 * 60 * 1000,
    "Host news recovery cutoff is 2 hours",
    HOST_DISCORD_MAX_EVENT_AGE_MS
  ));
  checks.push(check(Boolean(DISCORD_WEBHOOK_URL || WEBHOOK_OVERRIDE_URL), "Default webhook path configured", {
    defaultWebhookConfigured: Boolean(DISCORD_WEBHOOK_URL),
    overrideWebhookConfigured: Boolean(WEBHOOK_OVERRIDE_URL)
  }));
  checks.push(check(Boolean(MARKET_CAP_UNDER_30M_WEBHOOK_URL), "Market-cap under-30M webhook configured", {
    configured: Boolean(MARKET_CAP_UNDER_30M_WEBHOOK_URL)
  }));
  checks.push(check(Boolean(MARKET_CAP_30M_TO_50M_WEBHOOK_URL), "Market-cap 30M-to-50M webhook configured", {
    configured: Boolean(MARKET_CAP_30M_TO_50M_WEBHOOK_URL)
  }));
  checks.push(check(Boolean(MARKET_CAP_50M_TO_100M_WEBHOOK_URL), "Market-cap 50M-to-100M webhook configured", {
    configured: Boolean(MARKET_CAP_50M_TO_100M_WEBHOOK_URL)
  }));
  checks.push(check(
    Number(MARKET_CAP_30M_TO_50M_MIN) === 30000000 &&
      Number(MARKET_CAP_30M_TO_50M_LIMIT) === 50000000,
    "Market-cap 30M-to-50M band is above 30M through 50M",
    {
      minExclusive: MARKET_CAP_30M_TO_50M_MIN,
      maxInclusive: MARKET_CAP_30M_TO_50M_LIMIT
    }
  ));
  checks.push(check(
    Number(MARKET_CAP_50M_TO_100M_MIN) === 50000000 &&
      Number(MARKET_CAP_50M_TO_100M_LIMIT) === 100000000,
    "Market-cap 50M-to-100M band is above 50M through 100M",
    {
      minExclusive: MARKET_CAP_50M_TO_100M_MIN,
      maxInclusive: MARKET_CAP_50M_TO_100M_LIMIT
    }
  ));
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
  const under30Targets = getWebhookTargets("market_cap_under_30m", { canDiluteToday: null, earliestDilution: null });
  const midCapTargets = getWebhookTargets("market_cap_30m_to_50m", { canDiluteToday: null, earliestDilution: null });
  const upperCapTargets = getWebhookTargets("market_cap_50m_to_100m", { canDiluteToday: null, earliestDilution: null });
  checks.push(check(defaultTargets.length > 0 || Boolean(WEBHOOK_OVERRIDE_URL), "Default route has webhook target(s)", redactConfiguredTargets(defaultTargets)));
  checks.push(check(under30Targets.length > 0 || Boolean(WEBHOOK_OVERRIDE_URL), "Under-30M route has webhook target(s)", redactConfiguredTargets(under30Targets)));
  checks.push(check(midCapTargets.length > 0 || Boolean(WEBHOOK_OVERRIDE_URL), "30M-to-50M route has webhook target(s)", redactConfiguredTargets(midCapTargets)));
  checks.push(check(upperCapTargets.length > 0 || Boolean(WEBHOOK_OVERRIDE_URL), "50M-to-100M route has webhook target(s)", redactConfiguredTargets(upperCapTargets)));
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
