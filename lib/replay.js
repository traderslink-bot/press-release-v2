const fs = require("fs");
const path = require("path");

const {
  REPLAY_FILE,
  REPLAY_OUTPUT_FILE,
  REPLAY_SKIP_WEBHOOKS,
  DISCORD_WEBHOOK_URL,
  OPENAI_API_KEY,
  WEBHOOK_OVERRIDE_URL,
  REVIEW_ENABLED,
  REVIEW_OUTPUT_FILE
} = require("./config");
const { cleanText } = require("./utils");
const {
  getArticleFetchTelemetry,
  normalizeSecFilingType,
  resetArticleFetchTelemetry
} = require("./sec");
const { reviewSecResult } = require("./review");
const { summarizeOpenAIUsage } = require("./openaiUsage");

function normalizeReplayMessage(rawItem, index) {
  const item = rawItem && typeof rawItem === "object" ? rawItem : {};
  let rawText = cleanText(item.rawText || item.text || "");
  const articleLink = cleanText(item.articleLink || item.url || "");
  const filingTypeHint = normalizeSecFilingType(item.filingTypeHint || item.filingType || "");

  let ticker = cleanText(item.ticker || "");
  if (!ticker) {
    const tickerMatch = rawText.match(/\b([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b/);
    ticker = tickerMatch ? tickerMatch[1].toUpperCase() : `TEST${index + 1}`;
  }

  if (!rawText && articleLink && articleLink.includes("sec.gov")) {
    rawText = filingTypeHint
      ? `SEC ${ticker} - Form ${filingTypeHint} - Link`
      : `SEC ${ticker} - Link`;
  }

  return {
    id: cleanText(item.id || `replay-${index + 1}-${Date.now()}`),
    ticker,
    tickers: Array.isArray(item.tickers) && item.tickers.length
      ? item.tickers.map(value => cleanText(value).toUpperCase()).filter(Boolean)
      : [ticker],
    float: item.float ? cleanText(item.float) : null,
    io: item.io ? cleanText(item.io) : null,
    marketCap: item.marketCap ? cleanText(item.marketCap) : null,
    extraInfo: Array.isArray(item.extraInfo) ? item.extraInfo.map(cleanText).filter(Boolean) : [],
    articleLink,
    rawText,
    routeTag: item.routeTag === "spike" || item.routeTag === "drop" ? item.routeTag : "default"
  };
}

function loadReplayMessages(replayFilePath) {
  const raw = fs.readFileSync(replayFilePath, "utf8");
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed) ? parsed : [parsed];

  if (!items.length) {
    throw new Error(`Replay file contains no messages: ${replayFilePath}`);
  }

  return items.map((item, index) => normalizeReplayMessage(item, index));
}

async function runReplayMode(processMessage) {
  if (!REPLAY_FILE) {
    throw new Error("Replay mode requires REPLAY_FILE.");
  }

  if (!fs.existsSync(REPLAY_FILE)) {
    throw new Error(`Replay file not found: ${REPLAY_FILE}`);
  }

  if (!DISCORD_WEBHOOK_URL && !WEBHOOK_OVERRIDE_URL && !REPLAY_SKIP_WEBHOOKS) {
    throw new Error("Replay mode requires DISCORD_WEBHOOK_URL or WEBHOOK_OVERRIDE_URL unless REPLAY_SKIP_WEBHOOKS=true.");
  }

  if (!OPENAI_API_KEY) {
    throw new Error("Replay mode requires OPENAI_API_KEY.");
  }

  const messages = loadReplayMessages(REPLAY_FILE);
  resetArticleFetchTelemetry();
  console.log(`[REPLAY] Loaded ${messages.length} message(s) from ${REPLAY_FILE}`);
  const results = [];
  const reviews = [];

  for (const message of messages) {
    const result = await processMessage(message);

    if (REVIEW_ENABLED) {
      try {
        const review = await reviewSecResult({
          ...result,
          rawText: result.reviewArtifacts?.rawText || message.rawText,
          articleText: result.reviewArtifacts?.articleText || ""
        });

        if (review) {
          reviews.push({
            id: result.id,
            ticker: result.ticker,
            articleLink: result.articleLink,
            filingType: result.filingType,
            eventType: result.eventType,
            review
          });
        }
      } catch (err) {
        reviews.push({
          id: result.id,
          ticker: result.ticker,
          articleLink: result.articleLink,
          filingType: result.filingType,
          eventType: result.eventType,
          reviewError: cleanText(err.message)
        });
      }
    }

    delete result.reviewArtifacts;
    results.push(result);
  }

  const summaryUsageItems = results.map(result => result.openaiUsage).filter(Boolean);
  const reviewUsageItems = reviews
    .map(entry => entry?.review?.openaiUsage)
    .filter(Boolean);
  const openaiUsage = {
    summary: summarizeOpenAIUsage(summaryUsageItems),
    review: summarizeOpenAIUsage(reviewUsageItems),
    total: summarizeOpenAIUsage([...summaryUsageItems, ...reviewUsageItems])
  };
  const articleFetchTelemetry = getArticleFetchTelemetry();

  if (REPLAY_OUTPUT_FILE) {
    fs.mkdirSync(path.dirname(REPLAY_OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(
      REPLAY_OUTPUT_FILE,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          replayFile: REPLAY_FILE,
          articleFetchTelemetry,
          openaiUsage,
          results
        },
        null,
        2
      )
    );
    console.log(`[REPLAY] Wrote replay results to ${REPLAY_OUTPUT_FILE}`);
  }

  if (REVIEW_ENABLED && REVIEW_OUTPUT_FILE) {
    fs.mkdirSync(path.dirname(REVIEW_OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(
      REVIEW_OUTPUT_FILE,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          replayFile: REPLAY_FILE,
          openaiUsage: {
            review: openaiUsage.review
          },
          reviews
        },
        null,
        2
      )
    );
    console.log(`[REVIEW] Wrote review results to ${REVIEW_OUTPUT_FILE}`);
  }

  const estimatedCostText = openaiUsage.total.estimatedCostUsd === null
    ? "n/a"
    : `$${openaiUsage.total.estimatedCostUsd.toFixed(6)}`;
  console.log(
    `[REPLAY] Article fetch telemetry: ${articleFetchTelemetry.totalRequests} requests, ${articleFetchTelemetry.totalCacheHits} cache hit(s), ${articleFetchTelemetry.totalCacheMisses} cache miss(es), ${articleFetchTelemetry.totalNuntioCooldowns} Nuntio cooldown hit(s), ${articleFetchTelemetry.uniqueNuntioUrlCount} unique Nuntio URL(s)`
  );
  console.log(
    `[REPLAY] OpenAI usage totals: ${openaiUsage.total.totalTokens} tokens across ${openaiUsage.total.callCount} call(s); estimated cost ${estimatedCostText}`
  );

  console.log("[REPLAY] Completed replay run.");
}

module.exports = {
  runReplayMode
};
