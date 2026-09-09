// Publishes one stored local ingest event to the website news API, then optionally
// posts the new minimal Discord alert to a test webhook.
const Database = require("better-sqlite3");
const { INGEST_DATABASE_PATH, resolvedEnvFile } = require("./lib/config");
const { runLevelsScript } = require("./lib/levels");

const args = new Set(process.argv.slice(2));
const eventIdArg = process.argv
  .slice(2)
  .find(arg => arg.startsWith("--event-id="));
const shouldPostDiscord = args.has("--post-discord");

function cleanText(value, fallback = "") {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function cleanMultilineText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getHostname(url) {
  try {
    return new URL(String(url || "").trim()).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function isNuntioBotUrl(url) {
  return getHostname(url) === "news.nuntiobot.com";
}

function getUserFacingSourceUrl(articlePayload) {
  const sourceUrl = cleanText(articlePayload.sourceUrl);
  if (!sourceUrl || isNuntioBotUrl(sourceUrl)) {
    return "";
  }
  return sourceUrl;
}

function parseJson(value, fallback) {
  if (!cleanText(value)) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map(value => cleanText(value))
        .filter(Boolean)
    )
  );
}

function getLatestProcessedEvent(db) {
  const eventId =
    cleanText(process.env.TEST_NEWS_EVENT_ID) ||
    cleanText(eventIdArg ? eventIdArg.replace(/^--event-id=/, "") : "");

  if (eventId) {
    return db
      .prepare(
        `
          SELECT *
          FROM ingest_events
          WHERE id = ?
          LIMIT 1
        `
      )
      .get(eventId);
  }

  return db
    .prepare(
      `
        SELECT *
        FROM ingest_events
        WHERE process_status = 'processed'
          AND headline IS NOT NULL
        ORDER BY processed_at DESC, observed_at DESC
        LIMIT 1
      `
    )
    .get();
}

function buildArticlePayload(row, levelsText = "") {
  const ai = parseJson(row.ai_json, {});
  const positives = uniqueStrings(parseJson(row.positives_json, []));
  const negatives = uniqueStrings(parseJson(row.negatives_json, []));
  const reasonCodes = uniqueStrings(parseJson(row.reason_codes_json, []));
  const signalDiagnostics = parseJson(row.signal_diagnostics_json, {});
  const latencyMetrics = parseJson(row.latency_metrics_json, {});
  const documentDiagnostics = parseJson(row.document_diagnostics_json, {});
  const duplicateDiagnostics = parseJson(row.duplicate_diagnostics_json, {});
  const reviewQueueReasons = uniqueStrings(parseJson(row.review_queue_reasons_json, []));
  const signalFlags = uniqueStrings(signalDiagnostics.flags);

  return {
    sourceEventId: cleanText(row.id),
    ticker: cleanText(row.ticker).toUpperCase(),
    headline: cleanText(row.headline || ai.headline),
    summary: cleanText(row.summary || ai.summary) || null,
    articleText: cleanText(row.article_text) || null,
    sourceUrl: cleanText(row.article_url) || null,
    eventType: cleanText(row.event_type || ai.eventType) || null,
    routeTag: cleanText(row.route_tag) || null,
    publishedAt: cleanText(row.observed_at || row.processed_at) || null,
    metadata: {
      marketCap: cleanText(row.market_cap_text) || null,
      marketCapValue: Number.isFinite(Number(row.market_cap_value))
        ? Number(row.market_cap_value)
        : null,
      float: cleanText(row.float_text) || null,
      io: cleanText(row.io_text) || null,
      flag: cleanText(row.flag_text) || null,
      filingType: cleanText(row.filing_type || ai.filingType) || null,
      dilutionStatus: cleanText(row.dilution_status || ai.dilutionStatus) || null,
      dilutionTiming: cleanText(ai.dilutionTiming) || null,
      dilutionTriggerType: cleanText(row.dilution_trigger_type || ai.dilutionTriggerType) || null,
      dilutionTriggerDate: cleanText(row.dilution_trigger_date || ai.dilutionTriggerDate) || null,
      canDiluteToday:
        row.can_dilute_today === null || row.can_dilute_today === undefined
          ? ai.canDiluteToday ?? null
          : Boolean(row.can_dilute_today),
      earliestDilution: cleanText(row.earliest_dilution || ai.earliestDilution) || null,
      articleSourceMode: cleanText(row.article_source_mode) || null,
      sourceHostname: cleanText(row.source_hostname) || null,
      supportResistanceLevels: cleanMultilineText(levelsText) || null
    },
    positives,
    negatives,
    riskFlags: uniqueStrings([...signalFlags, ...reviewQueueReasons]),
    diagnostics: {
      reasonCodes,
      signalDiagnostics,
      latencyMetrics,
      documentDiagnostics,
      duplicateDiagnostics
    },
    rawPayload: {
      localIngestEventId: cleanText(row.id),
      ai,
      supportResistanceLevels: cleanMultilineText(levelsText) || null
    }
  };
}

function buildMinimalDiscordPayload(articlePayload, articleUrl) {
  const marketCap = cleanText(articlePayload.metadata?.marketCap, "N/A");
  const floatText = cleanText(articlePayload.metadata?.float, "N/A");
  const io = cleanText(articlePayload.metadata?.io, "N/A");
  const headline = cleanText(articlePayload.headline);
  const ticker = cleanText(articlePayload.ticker).toUpperCase();
  const content = [
    `**$${ticker}**`,
    `Market Cap: ${marketCap} | Float: ${floatText} | I/O: ${io}`,
    `**${headline}**`,
    `<${articleUrl}>`
  ].join("\n");

  return {
    content: `${content.trimEnd()}\n\n\n\u200B`
  };
}

function hasStoredArticleText(articlePayload) {
  return cleanText(articlePayload.articleText).length > 0;
}

function shouldPublishWebsiteArticle(articlePayload) {
  return hasStoredArticleText(articlePayload);
}

async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = { rawBody: text };
  }

  if (!response.ok) {
    throw new Error(`POST ${url} failed ${response.status}: ${text}`);
  }

  return body;
}

async function main() {
  const apiUrl =
    cleanText(process.env.TEST_NEWS_API_URL) ||
    "http://127.0.0.1:3000/api/news/articles";
  const publishToken = cleanText(process.env.NEWS_PUBLISH_TOKEN);
  const discordWebhookUrl = cleanText(process.env.NEWS_TEST_DISCORD_WEBHOOK_URL);

  const db = new Database(INGEST_DATABASE_PATH, { readonly: true });
  const row = getLatestProcessedEvent(db);
  if (!row) {
    throw new Error("No processed local ingest event with a headline was found.");
  }

  let articlePayload = buildArticlePayload(row);
  let articleUrl = getUserFacingSourceUrl(articlePayload);
  let publishResponse = null;

  if (shouldPublishWebsiteArticle(articlePayload)) {
    const levelsText = await runLevelsScript(articlePayload.ticker);
    articlePayload = buildArticlePayload(row, levelsText);
    publishResponse = await postJson(
      apiUrl,
      articlePayload,
      publishToken ? { Authorization: `Bearer ${publishToken}` } : {}
    );
    articleUrl = publishResponse.articleUrl;
  }

  if (!articleUrl) {
    throw new Error(
      "No website article URL or user-facing source URL is available for the Discord alert. NuntioBot links are fetch helpers only and are not sent to Discord."
    );
  }

  const discordPayload = buildMinimalDiscordPayload(articlePayload, articleUrl);

  console.log("[TEST NEWS] Env:", resolvedEnvFile);
  console.log("[TEST NEWS] Source event:", row.id);
  if (publishResponse) {
    console.log("[TEST NEWS] Website article:", articleUrl);
  } else {
    console.log("[TEST NEWS] Website article: skipped because no article text was stored");
    console.log("[TEST NEWS] Discord source link:", articleUrl);
  }
  console.log("[TEST NEWS] Minimal Discord payload:");
  console.log(JSON.stringify(discordPayload, null, 2));

  if (!shouldPostDiscord) {
    console.log("[TEST NEWS] Dry run only. Add --post-discord to send to NEWS_TEST_DISCORD_WEBHOOK_URL.");
    return;
  }

  if (!discordWebhookUrl) {
    throw new Error("NEWS_TEST_DISCORD_WEBHOOK_URL is required when using --post-discord.");
  }

  const waitUrl = discordWebhookUrl.includes("?")
    ? `${discordWebhookUrl}&wait=true`
    : `${discordWebhookUrl}?wait=true`;
  const discordResponse = await postJson(waitUrl, discordPayload);
  console.log("[TEST NEWS] Discord test message:", JSON.stringify(discordResponse, null, 2));
}

main().catch(error => {
  console.error(`[TEST NEWS] ${error.stack || error.message}`);
  process.exitCode = 1;
});
