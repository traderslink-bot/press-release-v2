const {
  normalizeSecDocumentUrl,
  fetchArticleText,
  buildUnreadableSecFallbackAI,
  buildArticleFetchFallback,
  isSecSource,
  recordArticleFetchEvent
} = require("./sec");
const {
  generateAIAnalysis,
  generateAIUrlFallbackAnalysis,
  stabilizeAIResult
} = require("./ai");
const { runLevelsScript } = require("./levels");
const { buildDiscordEmbeds, getWebhookTargets, postEmbedsToWebhook } = require("./discord");

async function processMessage(data) {
  console.log(`[PROCESS] Processing ${data.ticker}`);

  let articleText;
  let ai;
  let articleSourceMode = "fetched_direct";
  let articleFetchError = null;
  let openaiUrlFallbackError = null;
  const secSource = isSecSource(data.articleLink);
  const skipArticleFetchForDrop = !secSource && data.routeTag === "drop";

  if (skipArticleFetchForDrop) {
    console.log(`[PROCESS] Skipping article fetch for PR DROP ${data.ticker}`);
    articleText = buildArticleFetchFallback(data, new Error("PR DROP article fetch paused intentionally"));
    articleSourceMode = "headline_only_fallback";
  }

  try {
    if (!skipArticleFetchForDrop) {
      articleText = await fetchArticleText(data.articleLink, data.rawText);
    }
  } catch (err) {
    articleFetchError = err;
    if (normalizeSecDocumentUrl(data.articleLink).includes("sec.gov")) {
      console.warn(`[WARN] Using SEC unreadable fallback for ${data.ticker}: ${err.message}`);
      ai = buildUnreadableSecFallbackAI(data, err);
      articleSourceMode = "sec_unreadable_fallback";
    } else {
      console.warn(`[WARN] Direct article fetch failed for ${data.ticker}; trying OpenAI URL fallback: ${err.message}`);
      try {
        ai = await generateAIUrlFallbackAnalysis(data.rawText, data.articleLink);
        articleSourceMode = ai.urlFallbackReadSucceeded
          ? "openai_url_fallback"
          : "headline_only_fallback";
      } catch (fallbackErr) {
        openaiUrlFallbackError = fallbackErr;
        console.warn(`[WARN] Falling back to Discord-only summary for ${data.ticker}: ${fallbackErr.message}`);
        articleText = buildArticleFetchFallback(data, err);
        articleSourceMode = "headline_only_fallback";
      }
    }
  }

  if (!ai) {
    ai = await generateAIAnalysis(data.rawText, articleText, data.articleLink);
  }

  if (!secSource) {
    recordArticleFetchEvent(data.articleLink, {
      kind: "pipeline_resolution",
      articleSourceMode,
      directFetchError: articleFetchError ? articleFetchError.message : null,
      openaiUrlFallbackError: openaiUrlFallbackError ? openaiUrlFallbackError.message : null
    });
  }
  console.log(`[PROCESS] ${data.ticker} article source mode: ${articleSourceMode}`);

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
    articleSourceMode,
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
      ai,
      articleSourceMode,
      articleFetchError: articleFetchError ? articleFetchError.message : null,
      openaiUrlFallbackError: openaiUrlFallbackError ? openaiUrlFallbackError.message : null
    }
  };
}

module.exports = {
  processMessage
};
