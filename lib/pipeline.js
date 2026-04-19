const {
  normalizeSecDocumentUrl,
  fetchArticleText,
  buildUnreadableSecFallbackAI,
  buildArticleFetchFallback,
  isSecSource
} = require("./sec");
const { generateAIAnalysis, stabilizeAIResult } = require("./ai");
const { runLevelsScript } = require("./levels");
const { buildDiscordEmbeds, getWebhookTargets, postEmbedsToWebhook } = require("./discord");

async function processMessage(data) {
  console.log(`[PROCESS] Processing ${data.ticker}`);

  let articleText;
  let ai;
  const secSource = isSecSource(data.articleLink);
  const skipArticleFetchForDrop = !secSource && data.routeTag === "drop";

  if (skipArticleFetchForDrop) {
    console.log(`[PROCESS] Skipping article fetch for PR DROP ${data.ticker}`);
    articleText = buildArticleFetchFallback(data, new Error("PR DROP article fetch paused intentionally"));
  }

  try {
    if (!skipArticleFetchForDrop) {
      articleText = await fetchArticleText(data.articleLink, data.rawText);
    }
  } catch (err) {
    if (normalizeSecDocumentUrl(data.articleLink).includes("sec.gov")) {
      console.warn(`[WARN] Using SEC unreadable fallback for ${data.ticker}: ${err.message}`);
      ai = buildUnreadableSecFallbackAI(data, err);
    } else {
      console.warn(`[WARN] Falling back to Discord-only summary for ${data.ticker}: ${err.message}`);
      articleText = buildArticleFetchFallback(data, err);
    }
  }

  if (!ai) {
    ai = await generateAIAnalysis(data.rawText, articleText, data.articleLink);
  }

  ai = stabilizeAIResult(ai, data, articleText);

  const levelsText = await runLevelsScript(data.ticker);
  const embeds = buildDiscordEmbeds(ai, data, data.articleLink, levelsText);
  const webhookTargets = getWebhookTargets(data.routeTag, ai);

  if (webhookTargets.length) {
    await Promise.all(webhookTargets.map(webhookUrl => postEmbedsToWebhook(webhookUrl, embeds)));
  } else {
    console.log(`[PROCESS] No eligible webhook targets for ${data.ticker}; skipping post.`);
  }

  console.log(`[PROCESS] Completed ${data.ticker}`);

  return {
    id: data.id,
    ticker: data.ticker,
    routeTag: data.routeTag || "default",
    articleLink: data.articleLink,
    filingType: ai.filingType || null,
    eventType: ai.eventType || "unknown",
    dilutionTiming: ai.dilutionTiming || null,
    dilutionStatus: ai.dilutionStatus || null,
    dilutionTriggerType: ai.dilutionTriggerType || null,
    dilutionTriggerDate: ai.dilutionTriggerDate || null,
    canDiluteToday: ai.canDiluteToday || null,
    earliestDilution: ai.earliestDilution || null,
    confidence: Number.isFinite(ai.confidence) ? ai.confidence : 0,
    isFallback: Boolean(ai.isFallback),
    headline: ai.headline,
    summary: ai.summary,
    positives: Array.isArray(ai.positives) ? ai.positives : [],
    negatives: Array.isArray(ai.negatives) ? ai.negatives : [],
    tickers: Array.isArray(ai.tickers) ? ai.tickers : [],
    openaiUsage: ai.openaiUsage || null,
    embedCount: Array.isArray(embeds) ? embeds.length : 0,
    reviewArtifacts: {
      rawText: data.rawText,
      articleText,
      ai
    }
  };
}

module.exports = {
  processMessage
};
