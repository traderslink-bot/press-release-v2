const {
  normalizeSecDocumentUrl,
  fetchArticleText,
  getArticleSelectionMeta,
  buildUnreadableSecFallbackAI,
  buildArticleFetchFallback,
  isSecSource,
  recordArticleFetchEvent
} = require("./sec");
const {
  generateAIAnalysis,
  stabilizeAIResult,
  buildUrlFallbackMetadataOnlyResult
} = require("./ai");
const { runLevelsScript } = require("./levels");
const {
  buildDiscordEmbeds,
  getWebhookTargets,
  getFreeNewsBotTargets,
  postEmbedsToWebhook,
  postPayloadToWebhook,
  postPayloadToFreeNewsBotTarget
} = require("./discord");
const { isBufferConfigured, publishBufferXPost } = require("./buffer");
const { appendReviewQueueEntry } = require("./reviewQueue");
const { cleanText } = require("./utils");
const {
  findRecentDuplicateContext,
  findRecentProcessedArticleAnalysis,
  recordWebsiteArticlePost
} = require("./ingestStore");
const { fetchTextWithTimeout } = require("./http");
const { enqueueStocktwitsDraft } = require("../stocktwits/pipelineQueue");
const { scheduleStocktwitsOneShotWorkerForDraft } = require("../stocktwits/workerLauncher");
const { enqueueMoomooDraft } = require("../moomoo/pipelineQueue");
const { scheduleMoomooOneShotWorkerForDraft } = require("../moomoo/workerLauncher");
const {
  REVIEW_QUEUE_APPEND_ENABLED,
  MARKET_CAP_MAX_EVENT_AGE_MS,
  HOST_DISCORD_MAX_EVENT_AGE_MS,
  NEWS_ARTICLE_API_URL,
  NEWS_PUBLISH_TOKEN,
  NEWS_PUBLISH_TIMEOUT_MS,
  DELAYED_MARKET_CAP_DUMP_WEBHOOK_URL,
  DELAYED_MARKET_CAP_DUMP_DELAY_MS,
  BUFFER_AUTOPOST_ENABLED,
  WEBHOOK_OVERRIDE_URL,
  DISCORD_WEBHOOK_URL,
  NEWS_FILTERED_SECOND_WEBHOOK_URL
} = require("./config");

function roundDuration(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
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

function countNewsFilteredPosts(postedMessages = []) {
  const newsFilteredWebhooks = new Set(
    [
      cleanText(DISCORD_WEBHOOK_URL || ""),
      cleanText(NEWS_FILTERED_SECOND_WEBHOOK_URL || "")
    ].filter(Boolean)
  );

  return (Array.isArray(postedMessages) ? postedMessages : [])
    .filter(message =>
      message?.freeNewsBot === true ||
      newsFilteredWebhooks.has(cleanText(message?.webhookUrl || ""))
    )
    .length;
}

function getUserFacingSourceUrl(url) {
  const normalized = cleanText(url || "");
  if (!normalized || isNuntioBotUrl(normalized)) return "";
  return normalized;
}

function hasPublishableArticleText(articleText) {
  return cleanText(articleText || "").length > 0;
}

function hasAiSummary(ai) {
  const completedAiRead =
    ai?.openaiUsage?.operation === "summary" ||
    (ai?.openaiUsage?.operation === "url_fallback" && ai?.urlFallbackReadSucceeded === true);

  return (
    ai?.isFallback !== true &&
    completedAiRead &&
    cleanText(ai?.summary || "").length > 0
  );
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

function uniqueStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map(value => cleanText(value || ""))
        .filter(Boolean)
    )
  );
}

function firstIsoDate(...values) {
  for (const value of values) {
    const normalized = cleanText(value || "");
    if (!normalized) continue;
    const parsed = new Date(normalized);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function appendDiscordGroupSpacing(content) {
  // Discord trims trailing blank lines on grouped webhook posts; the invisible
  // final line preserves spacing without adding a visible separator character.
  return `${String(content || "").trimEnd()}\n\n\n\u200B`;
}

function buildMinimalDiscordPayload(data, ai, articleUrl, options = {}) {
  const ticker = cleanText(data?.ticker || "").toUpperCase();
  const headline = options.summaryUnavailable
    ? "Summary could not be generated."
    : cleanText(ai?.headline || data?.headline || "News alert");
  const metricParts = [];
  const marketCap = cleanText(data?.marketCap || "");
  const floatText = cleanText(data?.float || "");
  const io = cleanText(data?.io || "");

  if (marketCap) metricParts.push(`Market Cap: ${marketCap}`);
  if (floatText) metricParts.push(`Float: ${floatText}`);
  if (io) metricParts.push(`I/O: ${io}`);

  const lines = [
    ticker ? `**$${ticker}**` : "**News alert**",
    metricParts.length ? metricParts.join(" | ") : "",
    `**${headline.slice(0, 650)}${headline.length > 650 ? "..." : ""}**`,
    `<${articleUrl}>`
  ].filter(Boolean);

  return {
    content: appendDiscordGroupSpacing(lines.join("\n").slice(0, 1900)),
    allowed_mentions: { parse: [] }
  };
}

function isFreeDemoWebhookTarget(webhookUrl) {
  const normalizedWebhookUrl = cleanText(webhookUrl || "");
  return (
    Boolean(normalizedWebhookUrl) &&
    normalizedWebhookUrl === cleanText(NEWS_FILTERED_SECOND_WEBHOOK_URL || "")
  );
}

function describeDiscordTarget(job) {
  if (job.kind === "free_news_bot") {
    return `${job.target?.guildId || "unknown-guild"}/${job.target?.channelId || "unknown-channel"}`;
  }

  return job.target || "unknown-webhook";
}

async function postToDiscordTargets({
  webhookTargets,
  freeNewsBotTargets,
  webhookPoster,
  botPayload
}) {
  const jobs = [];

  for (const webhookUrl of webhookTargets) {
    jobs.push({
      kind: "webhook",
      target: webhookUrl,
      run: () => webhookPoster(webhookUrl)
    });
  }

  for (const target of freeNewsBotTargets) {
    jobs.push({
      kind: "free_news_bot",
      target,
      run: () => postPayloadToFreeNewsBotTarget(target, botPayload)
    });
  }

  const settledResults = await Promise.allSettled(jobs.map(job => job.run()));
  const postedMessages = settledResults
    .filter(result => result.status === "fulfilled")
    .map(result => result.value)
    .filter(Boolean);
  const postErrors = settledResults
    .map((result, index) => ({ result, job: jobs[index] }))
    .filter(item => item.result.status === "rejected")
    .map(item => `${item.job.kind} ${describeDiscordTarget(item.job)}: ${item.result.reason?.message || String(item.result.reason || "unknown Discord error")}`);

  return {
    postedMessages,
    postErrors,
    attemptedCount: jobs.length
  };
}

function buildFreeNewsArticleUrl(newsPublishResult, articleUrl) {
  const freeArticleUrl = cleanText(newsPublishResult?.freeArticleUrl || "");
  if (freeArticleUrl) return freeArticleUrl;

  const normalized = cleanText(articleUrl || "");
  if (!normalized) return "";

  try {
    const parsed = new URL(normalized);
    if (parsed.pathname.startsWith("/news/") && !parsed.pathname.startsWith("/news/free/")) {
      parsed.pathname = parsed.pathname.replace(/^\/news\//, "/news/free/");
      return parsed.toString();
    }
  } catch (_) {
    if (normalized.startsWith("/news/") && !normalized.startsWith("/news/free/")) {
      return normalized.replace(/^\/news\//, "/news/free/");
    }
  }

  return getUserFacingSourceUrl(normalized);
}

function isTradersLinkFreeNewsArticleUrl(url) {
  try {
    const parsed = new URL(cleanText(url || ""));
    return (
      ["traderslink.pro", "app.traderslink.pro"].includes(
        parsed.hostname.toLowerCase()
      ) &&
      parsed.pathname.startsWith("/news/free/")
    );
  } catch (_) {
    return false;
  }
}

function buildExternalFreeNewsBotPayload({ data, ai, newsPublishResult, articleUrl }) {
  const freeArticleUrl = buildFreeNewsArticleUrl(newsPublishResult, articleUrl);
  if (!isTradersLinkFreeNewsArticleUrl(freeArticleUrl)) {
    return null;
  }

  return buildMinimalDiscordPayload(data, ai, freeArticleUrl);
}

function shouldScheduleDelayedNewsDump({ postedMessages = [], webhookOverrideUrl = "" } = {}) {
  return (
    Array.isArray(postedMessages) &&
    postedMessages.length > 0 &&
    !cleanText(webhookOverrideUrl || "")
  );
}

function scheduleDelayedNewsDumpPost({ data, ai, articleUrl, newsPublishResult }) {
  const delayMs = Number(DELAYED_MARKET_CAP_DUMP_DELAY_MS || 0);
  if (!DELAYED_MARKET_CAP_DUMP_WEBHOOK_URL || !Number.isFinite(delayMs) || delayMs < 0) {
    return;
  }

  const freeArticleUrl = buildFreeNewsArticleUrl(newsPublishResult, articleUrl);
  if (!freeArticleUrl) {
    console.warn(`[DELAYED_NEWS] No delayed article URL available for ${data?.ticker || "UNKNOWN"}; skipping delayed dump post.`);
    return;
  }

  const payload = buildMinimalDiscordPayload(data, ai, freeArticleUrl);
  const ticker = cleanText(data?.ticker || "UNKNOWN").toUpperCase();
  const timeout = setTimeout(() => {
    postPayloadToWebhook(DELAYED_MARKET_CAP_DUMP_WEBHOOK_URL, payload)
      .then(result => {
        if (result?.messageId) {
          console.log(`[DELAYED_NEWS] Posted delayed news alert for ${ticker} as ${result.messageId}`);
        } else {
          console.log(`[DELAYED_NEWS] Posted delayed news alert for ${ticker}`);
        }
      })
      .catch(err => {
        console.warn(`[DELAYED_NEWS] Failed delayed news alert for ${ticker}: ${err.message}`);
      });
  }, delayMs);

  if (typeof timeout.unref === "function") {
    timeout.unref();
  }

  console.log(`[DELAYED_NEWS] Scheduled delayed news alert for ${ticker} in ${Math.round(delayMs / 1000)}s`);
}

function shouldQueueStocktwitsDraft({ postedMessages = [], webhookOverrideUrl = "" } = {}) {
  return (
    countNewsFilteredPosts(postedMessages) > 0 &&
    !cleanText(webhookOverrideUrl || "")
  );
}

function shouldQueueMoomooDraft({ postedMessages = [], webhookOverrideUrl = "" } = {}) {
  return (
    countNewsFilteredPosts(postedMessages) > 0 &&
    !cleanText(webhookOverrideUrl || "")
  );
}

function queueStocktwitsDraftAfterDiscord({ data, ai, postedMessages }) {
  if (!shouldQueueStocktwitsDraft({ postedMessages, webhookOverrideUrl: WEBHOOK_OVERRIDE_URL })) {
    return null;
  }

  const result = enqueueStocktwitsDraft({
    id: data?.id,
    ticker: data?.ticker,
    title: ai?.headline || data?.headline || "News alert",
    summary: ai?.summary || "",
    sentiment: ai?.sentiment || "",
    source: "press_release_v2"
  });

  if (result.ok) {
    const workerStart = scheduleStocktwitsOneShotWorkerForDraft(result);
    result.workerStart = workerStart;
    console.log(
      `[STOCKTWITS] Queued ${result.ticker} draft ${result.id} for ${result.scheduledAt} ` +
        `(${result.messageLength} chars).`
    );
    if (workerStart?.scheduled) {
      console.log(`[STOCKTWITS] Scheduled one-shot worker for ${result.ticker} in ${Math.round(workerStart.waitMs / 1000)}s.`);
    } else if (workerStart?.skipped) {
      console.log(`[STOCKTWITS] One-shot worker not scheduled for ${result.ticker}: ${workerStart.reason}`);
    }
  } else if (result.skipped) {
    console.log(`[STOCKTWITS] Skipping draft queue for ${data?.ticker || "UNKNOWN"}: ${result.reason}`);
  }

  return result;
}

function queueMoomooDraftAfterDiscord({ data, ai, postedMessages }) {
  if (!shouldQueueMoomooDraft({ postedMessages, webhookOverrideUrl: WEBHOOK_OVERRIDE_URL })) {
    return null;
  }

  const result = enqueueMoomooDraft({
    id: data?.id,
    ticker: data?.ticker,
    title: ai?.headline || data?.headline || "",
    summary: ai?.summary || "",
    sentiment: ai?.sentiment || "",
    source: "press_release_v2",
    eventType: ai?.eventType || data?.eventType || "",
    articleSourceMode: ai?.articleSourceMode || data?.articleSourceMode || ""
  });

  if (result.ok) {
    const workerStart = scheduleMoomooOneShotWorkerForDraft(result);
    result.workerStart = workerStart;
    console.log(
      `[MOOMOO] Queued ${result.ticker} draft ${result.id} for ${result.scheduledAt} ` +
        `(${result.messageLength} chars).`
    );
    if (workerStart?.scheduled) {
      console.log(`[MOOMOO] Scheduled one-shot worker for ${result.ticker} in ${Math.round(workerStart.waitMs / 1000)}s.`);
    } else if (workerStart?.skipped) {
      console.log(`[MOOMOO] One-shot worker not scheduled for ${result.ticker}: ${workerStart.reason}`);
    }
    if (result.truncated) {
      console.log(
        `[MOOMOO] Truncated draft text for ${result.ticker} ` +
          `(title ${result.originalTitleLength} chars, summary ${result.originalSummaryLength} chars).`
      );
    }
  } else if (result.skipped) {
    console.log(`[MOOMOO] Skipping draft queue for ${data?.ticker || "UNKNOWN"}: ${result.reason}`);
  }

  return result;
}

function buildNewsArticlePayload({
  data,
  ai,
  articleText,
  levelsText,
  articleSourceMode,
  documentDiagnostics,
  signalDiagnostics,
  latencyMetrics,
  duplicateDiagnostics,
  reasonCodes
}) {
  return {
    sourceEventId: cleanText(data?.id || "") || null,
    ticker: cleanText(data?.ticker || "").toUpperCase(),
    headline: cleanText(ai?.headline || data?.headline || "News alert"),
    summary: cleanText(ai?.summary || "") || null,
    articleText: cleanText(articleText || "") || null,
    sourceUrl: cleanText(data?.articleLink || "") || null,
    eventType: cleanText(ai?.eventType || "") || null,
    routeTag: cleanText(data?.routeTag || "default").toLowerCase(),
    publishedAt: firstIsoDate(data?.messageTimestamp, data?.observedAt),
    metadata: {
      marketCap: cleanText(data?.marketCap || "") || null,
      marketCapValue: Number.isFinite(Number(data?.marketCapValue)) ? Number(data.marketCapValue) : null,
      float: cleanText(data?.float || "") || null,
      io: cleanText(data?.io || "") || null,
      flag: cleanText(data?.flag || "") || null,
      filingType: cleanText(ai?.filingType || "") || null,
      dilutionStatus: cleanText(ai?.dilutionStatus || "") || null,
      dilutionTiming: cleanText(ai?.dilutionTiming || "") || null,
      dilutionTriggerType: cleanText(ai?.dilutionTriggerType || "") || null,
      dilutionTriggerDate: cleanText(ai?.dilutionTriggerDate || "") || null,
      canDiluteToday: ai?.canDiluteToday ?? null,
      earliestDilution: cleanText(ai?.earliestDilution || "") || null,
      articleSourceMode,
      sourceHostname: getHostname(data?.articleLink),
      supportResistanceLevels: cleanMultilineText(levelsText) || null
    },
    positives: uniqueStrings(ai?.positives),
    negatives: uniqueStrings(ai?.negatives),
    riskFlags: uniqueStrings(signalDiagnostics?.flags),
    diagnostics: {
      reasonCodes: uniqueStrings(reasonCodes),
      signalDiagnostics: signalDiagnostics || {},
      latencyMetrics: latencyMetrics || {},
      documentDiagnostics: documentDiagnostics || {},
      duplicateDiagnostics: duplicateDiagnostics || {}
    },
    rawPayload: {
      localIngestEventId: cleanText(data?.id || "") || null,
      ai,
      supportResistanceLevels: cleanMultilineText(levelsText) || null,
      articleSourceMode
    }
  };
}

async function publishNewsArticle(payload) {
  if (!NEWS_ARTICLE_API_URL) return null;

  const headers = { "Content-Type": "application/json" };
  if (NEWS_PUBLISH_TOKEN) {
    headers.Authorization = `Bearer ${NEWS_PUBLISH_TOKEN}`;
  }

  const result = await fetchTextWithTimeout(
    NEWS_ARTICLE_API_URL,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    },
    NEWS_PUBLISH_TIMEOUT_MS
  );

  let body = null;
  try {
    body = result.body ? JSON.parse(result.body) : null;
  } catch (_) {
    body = { rawBody: result.body };
  }

  if (!result.response.ok) {
    throw new Error(`News article publish failed ${result.response.status}: ${String(result.body || "").slice(0, 500)}`);
  }

  if (!body?.articleUrl) {
    throw new Error("News article publish response did not include articleUrl");
  }

  return body;
}

function buildLatencyMetrics({
  observedAt,
  processingStartedAt,
  fetchStartedAt,
  fetchFinishedAt,
  aiStartedAt,
  aiFinishedAt,
  levelsStartedAt,
  levelsFinishedAt,
  postStartedAt,
  postFinishedAt,
  processingFinishedAt
}) {
  const observedMs = observedAt ? new Date(observedAt).getTime() : NaN;
  const startedMs = processingStartedAt ? processingStartedAt.getTime() : NaN;
  const finishedMs = processingFinishedAt ? processingFinishedAt.getTime() : NaN;

  const metrics = {
    queueDelayMs: Number.isFinite(observedMs) && Number.isFinite(startedMs)
      ? roundDuration(startedMs - observedMs)
      : null,
    fetchMs:
      fetchStartedAt && fetchFinishedAt
        ? roundDuration(fetchFinishedAt.getTime() - fetchStartedAt.getTime())
        : null,
    aiMs:
      aiStartedAt && aiFinishedAt
        ? roundDuration(aiFinishedAt.getTime() - aiStartedAt.getTime())
        : null,
    levelsMs:
      levelsStartedAt && levelsFinishedAt
        ? roundDuration(levelsFinishedAt.getTime() - levelsStartedAt.getTime())
        : null,
    postMs:
      postStartedAt && postFinishedAt
        ? roundDuration(postFinishedAt.getTime() - postStartedAt.getTime())
        : null,
    totalProcessingMs:
      Number.isFinite(startedMs) && Number.isFinite(finishedMs)
        ? roundDuration(finishedMs - startedMs)
        : null
  };

  return metrics;
}

function isMarketCapFeedEvent(data) {
  const routeTag = cleanText(data?.routeTag || "default").toLowerCase();
  const feedType = cleanText(data?.feedType || "").toLowerCase();
  return (
    feedType === "market_cap" ||
    feedType === "market_cap_startup_backfill" ||
    routeTag === "market_cap_under_30m" ||
    routeTag === "market_cap_30m_to_50m" ||
    routeTag === "market_cap_50m_to_100m"
  );
}

function getMarketCapEventAgeMs(data, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return null;

  const eventTimes = [data?.messageTimestamp, data?.observedAt]
    .map(value => value ? new Date(value).getTime() : NaN)
    .filter(value => Number.isFinite(value));

  if (!eventTimes.length) return null;
  return Math.max(...eventTimes.map(value => nowMs - value));
}

function isStaleMarketCapEvent(data, now = new Date()) {
  if (!isMarketCapFeedEvent(data)) return false;
  if (cleanText(data?.feedType || "").toLowerCase() === "market_cap_startup_backfill") return false;
  const maxAgeMs = Number(MARKET_CAP_MAX_EVENT_AGE_MS || 0);
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;

  const ageMs = getMarketCapEventAgeMs(data, now);
  return Number.isFinite(ageMs) && ageMs > maxAgeMs;
}

function buildStaleMarketCapSkipResult(data, processingStartedAt) {
  const processingFinishedAt = new Date();
  const latencyMetrics = buildLatencyMetrics({
    observedAt: data?.observedAt || null,
    processingStartedAt,
    fetchStartedAt: null,
    fetchFinishedAt: null,
    aiStartedAt: null,
    aiFinishedAt: null,
    levelsStartedAt: null,
    levelsFinishedAt: null,
    postStartedAt: null,
    postFinishedAt: null,
    processingFinishedAt
  });
  const eventAgeMs = getMarketCapEventAgeMs(data, processingFinishedAt);
  const reasonCodes = ["market_cap_stale_suppressed"];
  if (Number(latencyMetrics?.queueDelayMs || 0) >= 10000) reasonCodes.push("queue_delay_high");

  return {
    id: data.id,
    ticker: data.ticker,
    tickers: Array.isArray(data.tickers) ? data.tickers : [data.ticker].filter(Boolean),
    headline: data.headline || null,
    summary: `Skipped stale market-cap scanner event; age ${eventAgeMs ?? "unknown"}ms exceeded ${MARKET_CAP_MAX_EVENT_AGE_MS}ms.`,
    eventType: "market_cap_stale_skip",
    ai: {
      headline: data.headline || null,
      summary: `Skipped stale market-cap scanner event; age ${eventAgeMs ?? "unknown"}ms exceeded ${MARKET_CAP_MAX_EVENT_AGE_MS}ms.`,
      eventType: "market_cap_stale_skip"
    },
    articleSourceMode: "market_cap_stale_skip",
    reasonCodes,
    latencyMetrics,
    reviewQueueDecision: {
      shouldQueue: false,
      reviewReasons: []
    },
    postingDecision: {
      allowPrimary: false,
      allowSpike: false,
      reasons: ["market_cap_stale_suppressed"]
    },
    webhookTargets: [],
    postedMessages: [],
    embedCount: 0,
    reviewArtifacts: {
      ai: {
        headline: data.headline || null,
        summary: `Skipped stale market-cap scanner event; age ${eventAgeMs ?? "unknown"}ms exceeded ${MARKET_CAP_MAX_EVENT_AGE_MS}ms.`,
        eventType: "market_cap_stale_skip"
      },
      articleText: null,
      reasonCodes,
      latencyMetrics,
      reviewQueueDecision: {
        shouldQueue: false,
        reviewReasons: []
      },
      postingDecision: {
        allowPrimary: false,
        allowSpike: false,
        reasons: ["market_cap_stale_suppressed"]
      },
      postedMessages: [],
      articleSourceMode: "market_cap_stale_skip",
      articleFetchError: null,
      openaiUrlFallbackError: null
    }
  };
}

function shouldBuildLevelsForPotentialPost(data, { isMarketCapFeed, useMinimalNewsDiscord = false, businessWireHeadlineOnly = false }) {
  const routeTag = cleanText(data?.routeTag || "default").toLowerCase();
  const ticker = cleanText(data?.ticker || "");

  if (useMinimalNewsDiscord && businessWireHeadlineOnly) {
    return false;
  }

  return Boolean(ticker) && !isMarketCapFeed && routeTag !== "drop";
}

function getDuplicateSuppressionGroup(value) {
  const routeTag = cleanText(value || "default").toLowerCase();
  if (routeTag === "market_cap_under_30m") return "market_cap_under_30m";
  if (routeTag === "market_cap_30m_to_50m") return "market_cap_30m_to_50m";
  if (routeTag === "market_cap_50m_to_100m") return "market_cap_50m_to_100m";
  if (routeTag === "drop") return "drop";
  return "primary";
}

function filterPostedDuplicatesForCurrentDestination(recentPostedDuplicates, data) {
  const currentGroup = getDuplicateSuppressionGroup(data?.routeTag || "default");
  return (Array.isArray(recentPostedDuplicates) ? recentPostedDuplicates : [])
    .filter(row => getDuplicateSuppressionGroup(row?.route_tag || "default") === currentGroup);
}

function buildDuplicateDiagnostics({ data }) {
  const duplicateContext = findRecentDuplicateContext({
    id: data?.id,
    articleLink: data?.articleLink
  });
  const destinationPostedDuplicates = filterPostedDuplicatesForCurrentDestination(
    duplicateContext.recentPostedDuplicates,
    data
  );

  return {
    duplicateGroupKey: duplicateContext.duplicateGroupKey,
    recentDuplicateCount: duplicateContext.recentDuplicateCount,
    recentDuplicates: duplicateContext.recentDuplicates,
    recentPostedDuplicateCount: destinationPostedDuplicates.length,
    recentPostedDuplicates: destinationPostedDuplicates,
    isRecentDuplicate: duplicateContext.isRecentDuplicate,
    isRecentPostedDuplicate: destinationPostedDuplicates.length > 0
  };
}

function buildSignalDiagnostics({ ai, data, articleText, secSource }) {
  const eventType = cleanText(ai?.eventType || "").toLowerCase();
  const combinedText = cleanText([
    data?.rawText || "",
    ai?.headline || "",
    ai?.summary || "",
    articleText || ""
  ].join(" "));
  if (!combinedText) {
    return {
      signalQuality: null,
      flags: []
    };
  }

  const lowSignalFlags = [];
  const conferenceParticipation = /(to present at|to participate in|will participate in|to attend|will attend|fireside chat|conference presentation|conference appearance|investor conference|annual conference|webcast presentation|panel discussion|booth \d+|exhibit(?:ing)? at)/i.test(
    combinedText
  );
  const policyNarrative = /(welcomes .*executive order|executive order .*catalyst|historic catalyst for|regulatory tailwind|policy tailwind|sector tailwind)/i.test(
    combinedText
  );
  const awarenessStyle = /(investor awareness|corporate awareness|brand awareness|featured on|interview with|podcast appearance|media campaign|national awareness|appearing on)/i.test(
    combinedText
  );
  const genericProductNews = /(general availability|now available|launch(?:ed|es)? .*program|showcas(?:e|ing)|demonstrat(?:e|ing)|unveil(?:ed|s)?|introduc(?:e|es|ed) .*solution)/i.test(
    combinedText
  );
  const hardCatalyst = /(gross proceeds|net proceeds|expected to close|priced at|units at|purchase order|order from|definitive agreement|collaboration agreement|commercial agreement|contract award|awarded contract|fda approval|fda cleared|granted approval|phase\s*[123]\b|topline data|guidance|revenue|earnings|merger agreement|acquisition|closed .*offering|registered direct|private placement|public offering)/i.test(
    combinedText
  );
  const specificCommercialTerms = /(\$\d|gross proceeds|net proceeds|customer order|purchase order|contract value|firm order|delivery schedule|deployment schedule|purchase commitment|pilot-to-production|pricing was not disclosed)/i.test(
    combinedText
  );
  const explicitNoCommercialTerms = /(does not announce|did not announce|no (?:customer orders|purchase commitments|pricing|firm delivery schedules|delivery schedule|firm order)|without (?:customer orders|pricing|firm delivery schedules))/i.test(
    combinedText
  );
  const pressReleaseLike =
    eventType.startsWith("press_release") ||
    (eventType === "sec_current_report" && /press release|news release|globenewswire|business wire|pr newswire/i.test(combinedText));
  const companySpecificCatalyst =
    hardCatalyst ||
    (!explicitNoCommercialTerms && specificCommercialTerms) ||
    (!explicitNoCommercialTerms && /(customer|customers|purchase order|contract|partnership|collaboration|data readout|trial results|received approval|granted approval|cash proceeds|closed the offering|priced the offering)/i.test(
      combinedText
    ));

  if (pressReleaseLike && conferenceParticipation && !hardCatalyst) {
    lowSignalFlags.push("conference_participation_pr");
  }
  if (pressReleaseLike && policyNarrative && !hardCatalyst) {
    lowSignalFlags.push("policy_tailwind_narrative_pr");
  }
  if (pressReleaseLike && policyNarrative && !companySpecificCatalyst) {
    lowSignalFlags.push("sector_tailwind_without_company_specifics");
  }
  if (pressReleaseLike && awarenessStyle && !hardCatalyst) {
    lowSignalFlags.push("corporate_awareness_pr");
  }
  if (pressReleaseLike && genericProductNews && !hardCatalyst && !specificCommercialTerms) {
    lowSignalFlags.push("generic_product_news_without_customer_terms");
  }

  if (lowSignalFlags.length) {
    lowSignalFlags.push("low_signal_press_release");
  }

  return {
    signalQuality: lowSignalFlags.length ? "low" : "normal",
    flags: Array.from(new Set(lowSignalFlags)),
    companySpecificCatalyst: companySpecificCatalyst ? "present" : "absent"
  };
}

function buildDocumentDiagnostics(articleSelectionMeta, articleText) {
  const selection = articleSelectionMeta || null;
  const selectedType = cleanText(selection?.selectedDocumentType || "").toUpperCase();
  const selectedKind = cleanText(selection?.selectionKind || "").toLowerCase();
  const flags = [];
  let wrapperRiskLevel = null;

  if (selection?.currentReportExhibitAvailable) {
    flags.push("current_report_exhibit_available");
  }
  if (selection?.currentReportWrapperPresent) {
    flags.push("current_report_wrapper_present");
  }
  if (selectedKind === "current_report_exhibit") {
    flags.push("current_report_exhibit_followed");
  }
  if (selectedKind === "effect_underlying_registration") {
    flags.push("effect_underlying_registration_followed");
  }
  if (selectedKind === "complete_submission_text") {
    flags.push("complete_submission_text_fallback");
  }

  const normalizedArticleText = cleanText(articleText || "");
  const looksWrapperLike = /(attached hereto and incorporated herein|incorporated by reference|press release attached to this form|exhibit 99\.1|furnished herewith|exhibit index)/i.test(
    normalizedArticleText
  );
  const shortText = normalizedArticleText.length > 0 && normalizedArticleText.length < 1400;
  const wrapperDocumentType = /^(?:8-K|6-K|EFFECT)$/i.test(selectedType);

  if (wrapperDocumentType && selectedKind !== "current_report_exhibit" && selectedKind !== "effect_underlying_registration") {
    flags.push("wrapper_document_selected");
  }
  if (looksWrapperLike) {
    flags.push("wrapper_language_detected");
  }
  if (shortText) {
    flags.push("short_document_text");
  }

  if (
    wrapperDocumentType &&
    selection?.currentReportExhibitAvailable &&
    selectedKind !== "current_report_exhibit"
  ) {
    wrapperRiskLevel = "high";
  } else if (
    selectedType === "EFFECT" &&
    selectedKind !== "effect_underlying_registration"
  ) {
    wrapperRiskLevel = "high";
  } else if (
    wrapperDocumentType &&
    (looksWrapperLike || shortText)
  ) {
    wrapperRiskLevel = "medium";
  } else if (selectedKind && (selectedKind === "current_report_exhibit" || selectedKind === "effect_underlying_registration")) {
    wrapperRiskLevel = "low";
  }

  return {
    wrapperRiskLevel,
    flags
  };
}

function buildReasonCodes({ ai, documentDiagnostics, signalDiagnostics, latencyMetrics, duplicateDiagnostics, articleSourceMode, secSource }) {
  const reasonCodes = new Set();

  const pressReleaseReasonCodes = Array.isArray(ai?.pressReleaseTimingSignals?.reasonCodes)
    ? ai.pressReleaseTimingSignals.reasonCodes
    : [];
  for (const code of pressReleaseReasonCodes) {
    if (cleanText(code)) reasonCodes.add(cleanText(code));
  }

  const diagnosticFlags = Array.isArray(documentDiagnostics?.flags)
    ? documentDiagnostics.flags
    : [];
  for (const flag of diagnosticFlags) {
    if (cleanText(flag)) reasonCodes.add(cleanText(flag));
  }

  const signalFlags = Array.isArray(signalDiagnostics?.flags)
    ? signalDiagnostics.flags
    : [];
  for (const flag of signalFlags) {
    if (cleanText(flag)) reasonCodes.add(cleanText(flag));
  }

  if (articleSourceMode === "openai_url_fallback") reasonCodes.add("openai_url_fallback_used");
  if (articleSourceMode === "headline_only_fallback") reasonCodes.add("headline_only_fallback_used");
  if (articleSourceMode === "ai_summary_unavailable") reasonCodes.add("ai_summary_unavailable");
  if (articleSourceMode === "sec_unreadable_fallback") reasonCodes.add("sec_unreadable_fallback_used");
  if (ai?.isFallback) reasonCodes.add("ai_fallback_output");
  if (secSource) reasonCodes.add("sec_source");
  if (Number(latencyMetrics?.totalProcessingMs || 0) >= 20000) reasonCodes.add("slow_processing_latency");
  if (Number(latencyMetrics?.queueDelayMs || 0) >= 10000) reasonCodes.add("queue_delay_high");
  if (duplicateDiagnostics?.isRecentDuplicate) reasonCodes.add("recent_duplicate_article_url");
  if (duplicateDiagnostics?.isRecentPostedDuplicate) reasonCodes.add("recent_posted_duplicate_article_url");

  return Array.from(reasonCodes);
}

function mergeReasonCodes(...reasonCodeGroups) {
  const merged = new Set();

  for (const group of reasonCodeGroups) {
    if (!Array.isArray(group)) continue;
    for (const code of group) {
      const normalized = cleanText(code || "");
      if (normalized) merged.add(normalized);
    }
  }

  return Array.from(merged);
}

function isBusinessWireUrl(url) {
  try {
    return new URL(String(url || "").trim()).hostname.toLowerCase().endsWith("businesswire.com");
  } catch (_) {
    return false;
  }
}

function extractBusinessWireHeadline(rawText, fallbackHeadline = null) {
  const normalized = cleanText(rawText || "");
  const fallback = cleanText(fallbackHeadline || "");
  if (!normalized) return fallback || "BusinessWire press release";

  const headlineParts = [];
  const pattern = /\bPR\s+(.+?)(?:\s+-\s+Link\b|,\s*\d+\s+seconds?\s+ago\s+PR\b|,\s*\d+\s+minutes?\s+ago\s+PR\b|,\s*$)/gi;
  let match;

  while ((match = pattern.exec(normalized)) !== null) {
    const headline = cleanText(match[1] || "").replace(/\s+-\s+Link\s*$/i, "");
    if (headline && !headlineParts.includes(headline)) {
      headlineParts.push(headline);
    }
  }

  if (headlineParts.length) {
    return headlineParts.join("; ");
  }

  if (fallback) return fallback;

  const afterPr = normalized.match(/\bPR\s+(.+)$/i)?.[1] || normalized;
  return cleanText(afterPr.replace(/\s+-\s+Link.*$/i, "")) || "BusinessWire press release";
}

function buildBusinessWireHeadlineOnlyAI(data) {
  return {
    headline: extractBusinessWireHeadline(data?.rawText, data?.headline),
    summary: "",
    positives: [],
    negatives: [],
    tickers: Array.isArray(data?.tickers) && data.tickers.length
      ? data.tickers
      : [data?.ticker].filter(Boolean),
    filingType: null,
    dilutionTiming: null,
    dilutionStatus: null,
    dilutionTriggerType: null,
    dilutionTriggerDate: null,
    canDiluteToday: null,
    earliestDilution: null,
    eventType: "press_release_businesswire_headline",
    confidence: 1,
    isFallback: false,
    isBusinessWireHeadlineOnly: true,
    openaiUsage: null
  };
}

function buildReviewQueueDecision({ ai, articleSourceMode, documentDiagnostics, signalDiagnostics, latencyMetrics, duplicateDiagnostics, reasonCodes, data }) {
  const reviewReasons = [];

  if (documentDiagnostics?.wrapperRiskLevel === "high") {
    reviewReasons.push("wrapper_risk_high");
  }
  if (documentDiagnostics?.wrapperRiskLevel === "medium") {
    reviewReasons.push("wrapper_risk_medium");
  }
  if (articleSourceMode === "headline_only_fallback") {
    reviewReasons.push("headline_only_fallback");
  }
  if (articleSourceMode === "ai_summary_unavailable") {
    reviewReasons.push("ai_summary_unavailable");
  }
  if (articleSourceMode === "sec_unreadable_fallback") {
    reviewReasons.push("sec_unreadable_fallback");
  }
  if (articleSourceMode === "openai_url_fallback") {
    reviewReasons.push("openai_url_fallback");
  }
  if (Number(ai?.confidence || 0) < 0.65) {
    reviewReasons.push("low_confidence");
  }
  if (Array.isArray(reasonCodes) && reasonCodes.includes("short_document_text")) {
    reviewReasons.push("short_document_text");
  }
  if (Array.isArray(reasonCodes) && reasonCodes.includes("wrapper_document_selected")) {
    reviewReasons.push("wrapper_document_selected");
  }
  if (signalDiagnostics?.signalQuality === "low") {
    reviewReasons.push("low_signal_press_release");
  }
  if (Array.isArray(reasonCodes) && reasonCodes.includes("slow_processing_latency")) {
    reviewReasons.push("slow_processing_latency");
  }
  if (Array.isArray(reasonCodes) && reasonCodes.includes("queue_delay_high")) {
    reviewReasons.push("queue_delay_high");
  }
  if (duplicateDiagnostics?.isRecentDuplicate) {
    reviewReasons.push("recent_duplicate_article_url");
  }
  if (cleanText(data?.routeTag || "").toLowerCase() === "spike" && reviewReasons.length) {
    reviewReasons.push("spike_route_manual_review");
  }

  return {
    shouldQueue: reviewReasons.length > 0,
    reviewReasons: Array.from(new Set(reviewReasons))
  };
}

function hasNegatedFinancingLanguage(text) {
  return /(not a financing|no financing announced|no offering(?:,|\b)|no public offering|no private placement|no registered direct|no deal size or timing disclosed|corporate update\/interview, not a financing)/i.test(
    text
  );
}

function hasConcreteFinancingLanguage(text) {
  const normalized = cleanText(text || "");
  if (!normalized || hasNegatedFinancingLanguage(normalized)) {
    return false;
  }

  const hits = [
    /public offering/i,
    /registered offering/i,
    /underwritten offering/i,
    /private placement/i,
    /registered direct/i,
    /\bpipe\b/i,
    /securities purchase agreement/i,
    /pre-funded warrant/i,
    /gross proceeds/i,
    /net proceeds/i,
    /expected to close/i,
    /priced .*offering/i,
    /price of \$\d/i
  ].filter(pattern => pattern.test(normalized)).length;

  return hits >= 2;
}

function hasStrongPressReleaseCatalyst(text, eventType) {
  const normalized = cleanText(text || "");
  const normalizedEventType = cleanText(eventType || "").toLowerCase();
  if (!normalized) return false;

  if (hasConcreteFinancingLanguage(normalized)) {
    return true;
  }

  if (normalizedEventType === "press_release_earnings") {
    return /(earnings|guidance|revenue|ebitda|net income|cash runway|operations into \d{4})/i.test(normalized);
  }

  if (normalizedEventType === "press_release_clinical") {
    return /(fda approval|fda cleared|complete response letter|topline data|met (?:its )?(?:primary|secondary) endpoint|phase\s*[23]\b|orphan drug|fast track|breakthrough therapy)/i.test(
      normalized
    );
  }

  return /(fda approval|fda cleared|complete response letter|topline data|merger agreement|acquisition|go-private|strategic alternatives|special committee|purchase order|order from|contract award|awarded contract|share repurchase|retire .*shares|special dividend|cash dividend)/i.test(
    normalized
  );
}

function hasStrongSecCurrentReportCatalyst(text) {
  const normalized = cleanText(text || "");
  if (!normalized) return false;

  return /(gross proceeds|net proceeds|purchase agreement|underwriting agreement|judgment|damages|royalty|merger agreement|acquisition|definitive agreement|share repurchase|special dividend|cash dividend|contract award|awarded contract|bankruptcy|going concern|asset sale|sale of .*business|financing)/i.test(
    normalized
  );
}

function isFinancingStylePressReleaseEventType(eventType) {
  return [
    "press_release_private_placement",
    "press_release_registered_direct",
    "press_release_at_the_market_financing",
    "press_release_warrant_financing",
    "press_release_offering_proposed",
    "press_release_offering_pricing",
    "press_release_financing",
    "press_release_ipo"
  ].includes(cleanText(eventType || "").toLowerCase());
}

function isImmediateDilutionOutput(ai) {
  const canDiluteToday = cleanText(ai?.canDiluteToday || "");
  const dilutionStatus = cleanText(ai?.dilutionStatus || "").toLowerCase();
  const dilutionTiming = cleanText(ai?.dilutionTiming || "");

  return (
    canDiluteToday === "Dilution status: Immediate" ||
    dilutionStatus === "live_now" ||
    dilutionTiming === "Dilution status: Immediate"
  );
}

function dateKeyFromDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function extractDateKeyFromText(text) {
  const normalized = cleanText(text || "");
  if (!normalized) return null;

  const isoDate = normalized.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;

  const slashDate = normalized.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (slashDate) {
    return `${slashDate[3]}-${slashDate[1].padStart(2, "0")}-${slashDate[2].padStart(2, "0")}`;
  }

  const monthDate = normalized.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i
  );
  if (monthDate) {
    const parsed = new Date(`${monthDate[1]} ${monthDate[2]}, ${monthDate[3]}`);
    return dateKeyFromDate(parsed);
  }

  return null;
}

function isCurrentDateDilutionOutput(ai, today = new Date()) {
  const hasDilutionSignal = Boolean(
    ai?.canDiluteToday ||
      ai?.earliestDilution ||
      ai?.dilutionTiming ||
      ai?.dilutionStatus ||
      ai?.dilutionTriggerType ||
      ai?.dilutionTriggerDate
  );
  if (!hasDilutionSignal) return false;

  const todayKey = dateKeyFromDate(today);
  if (!todayKey) return false;

  const triggerDateKey =
    extractDateKeyFromText(ai?.dilutionTriggerDate) ||
    extractDateKeyFromText(ai?.earliestDilution) ||
    extractDateKeyFromText(ai?.dilutionTiming);

  return triggerDateKey === todayKey;
}

function isReverseSplitText(text) {
  const normalized = cleanText(text || "");
  if (!normalized) return false;

  return (
    /\breverse\s+(?:stock\s+)?split\b/i.test(normalized) ||
    /\breverse\s+share\s+split\b/i.test(normalized) ||
    /\bshare\s+consolidation\b/i.test(normalized) ||
    /\bstock\s+consolidation\b/i.test(normalized) ||
    /\b(?:one|1)[-\s]?for[-\s]?(?:\d+|[a-z]+)\s+reverse\b/i.test(normalized) ||
    /\b1-for-\d+\b/i.test(normalized) && /\bsplit\b/i.test(normalized)
  );
}

function isBadNewsText(text) {
  const normalized = cleanText(text || "");
  if (!normalized) return false;

  return /(chapter 11|bankruptcy|going concern|delist(?:ing)?|nasdaq (?:deficiency|non-compliance|noncompliance)|received? .*notice of (?:non-compliance|noncompliance|delisting)|clinical hold|complete response letter|failed to meet (?:its )?(?:primary|secondary) endpoint|did not meet (?:its )?(?:primary|secondary) endpoint|trial (?:halted|paused|suspended|terminated|discontinued)|program (?:terminated|discontinued)|investigation by the sec|sec investigation|criminal investigation|restatement|auditor resignation|material weakness)/i.test(
    normalized
  );
}

function getHostNewsEventAgeMs(data, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return null;

  const eventMs = new Date(data?.messageTimestamp || data?.observedAt || "").getTime();
  return Number.isFinite(eventMs) ? Math.max(0, nowMs - eventMs) : null;
}

function isHostNewsTooOldForDiscord(data, now = new Date()) {
  if (cleanText(data?.feedType || "").toLowerCase() !== "host_startup_backfill") return false;
  const maxAgeMs = Number(HOST_DISCORD_MAX_EVENT_AGE_MS || 0);
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;

  const ageMs = getHostNewsEventAgeMs(data, now);
  return Number.isFinite(ageMs) && ageMs > maxAgeMs;
}

function buildPostingDecision({ ai, data, articleText, articleSourceMode, signalDiagnostics, secSource, duplicateDiagnostics }) {
  const routeTag = cleanText(data?.routeTag || "default").toLowerCase();
  if (isStaleMarketCapEvent(data)) {
    return {
      allowPrimary: false,
      allowSpike: false,
      reasons: ["market_cap_stale_suppressed"]
    };
  }
  if (isMarketCapFeedEvent(data)) {
    return {
      allowPrimary: true,
      allowSpike: false,
      reasons: ["market_cap_feed_unfiltered"]
    };
  }
  if (articleSourceMode === "businesswire_headline_only" || ai?.isBusinessWireHeadlineOnly) {
    const allow = routeTag !== "drop" && !duplicateDiagnostics?.isRecentPostedDuplicate;
    return {
      allowPrimary: allow,
      allowSpike: allow && routeTag === "spike",
      reasons: [
        allow ? "businesswire_headline_only_allowed" : "businesswire_headline_only_suppressed"
      ]
    };
  }

  const eventType = cleanText(ai?.eventType || "").toLowerCase();
  const combinedText = cleanText([
    data?.rawText || "",
    ai?.headline || "",
    ai?.summary || "",
    articleText || ""
  ].join(" "));
  const decisionHeadlineText = cleanText([
    data?.rawText || "",
    ai?.headline || "",
    ai?.summary || ""
  ].join(" "));
  const hasDilutionSnapshot = Boolean(ai?.canDiluteToday || ai?.earliestDilution);
  const lowSignal = signalDiagnostics?.signalQuality === "low";
  const companySpecificCatalyst = signalDiagnostics?.companySpecificCatalyst === "present";
  const weakArticleGrounding =
    articleSourceMode === "headline_only_fallback" ||
    (articleSourceMode === "openai_url_fallback" && ai?.urlFallbackReadSucceeded !== true);
  const concreteFinancing = hasConcreteFinancingLanguage(combinedText);
  const strongPressReleaseCatalyst = hasStrongPressReleaseCatalyst(combinedText, eventType);
  const strongSecCurrentReportCatalyst = hasStrongSecCurrentReportCatalyst(combinedText);
  const financingStylePressRelease = isFinancingStylePressReleaseEventType(eventType);
  const reverseSplit = isReverseSplitText(combinedText);
  const reasons = [];

  let allowPrimary = false;
  let allowSpike = routeTag === "spike";

  if (duplicateDiagnostics?.isRecentPostedDuplicate) {
    allowPrimary = false;
    allowSpike = false;
    reasons.push("recent_posted_duplicate_article_url_suppressed");
  } else if (routeTag === "drop") {
    allowPrimary = false;
    allowSpike = false;
    reasons.push("drop_route_suppressed");
  } else if (isImmediateDilutionOutput(ai)) {
    allowPrimary = false;
    allowSpike = false;
    reasons.push("immediate_dilution_suppressed");
  } else if (isCurrentDateDilutionOutput(ai)) {
    allowPrimary = false;
    allowSpike = false;
    reasons.push("current_date_dilution_suppressed");
  } else if (reverseSplit) {
    allowPrimary = false;
    allowSpike = false;
    reasons.push("reverse_split_suppressed");
  } else if (isBadNewsText(decisionHeadlineText)) {
    allowPrimary = false;
    allowSpike = false;
    reasons.push("bad_news_suppressed");
  } else if (secSource) {
    if (hasDilutionSnapshot) {
      allowPrimary = true;
      reasons.push("sec_dilution_relevant");
    } else if (eventType === "sec_current_report" && strongSecCurrentReportCatalyst) {
      allowPrimary = true;
      reasons.push("sec_current_report_hard_catalyst");
    } else {
      allowPrimary = true;
      reasons.push("sec_standard_allowed");
    }
  } else if (hasDilutionSnapshot && concreteFinancing) {
    allowPrimary = true;
    reasons.push("press_release_financing_relevant");
  } else if (financingStylePressRelease && !concreteFinancing) {
    allowPrimary = true;
    reasons.push("financing_classification_not_supported");
    reasons.push("press_release_standard_allowed");
  } else if (!weakArticleGrounding && !lowSignal && strongPressReleaseCatalyst) {
    allowPrimary = true;
    reasons.push("press_release_hard_catalyst");
  } else if (!weakArticleGrounding && eventType.startsWith("press_release")) {
    allowPrimary = true;
    reasons.push("press_release_standard_allowed");
  } else if (weakArticleGrounding && !lowSignal && eventType.startsWith("press_release") && companySpecificCatalyst) {
    allowPrimary = true;
    reasons.push("weak_article_grounding");
    reasons.push("press_release_headline_catalyst_allowed");
  } else if (weakArticleGrounding && eventType.startsWith("press_release")) {
    allowPrimary = true;
    reasons.push("weak_article_grounding");
    reasons.push("press_release_headline_allowed");
  } else {
    if (weakArticleGrounding) reasons.push("weak_article_grounding");
    if (lowSignal) reasons.push("low_signal_press_release");
    reasons.push("press_release_default_filtered");
  }

  if (routeTag === "spike") {
    if (
      allowPrimary ||
      concreteFinancing ||
      (!secSource && strongPressReleaseCatalyst) ||
      (secSource && strongSecCurrentReportCatalyst)
    ) {
      allowSpike = true;
      reasons.push("spike_channel_allowed");
    } else if (lowSignal) {
      allowSpike = false;
      reasons.push("spike_low_signal_suppressed");
    } else {
      allowSpike = false;
      reasons.push("spike_default_filtered");
    }
  }

  return {
    allowPrimary,
    allowSpike,
    reasons: Array.from(new Set(reasons))
  };
}

function sanitizeFallbackDisclosureText(text) {
  let sanitized = cleanText(String(text || ""))
    .replace(/^Article text unavailable;\s*summary based on raw Discord metadata\.\s*/i, "")
    .replace(/^Summary based on raw Discord metadata\.\s*/i, "")
    .replace(/^Full article text unavailable[^.]*\.\s*/i, "")
    .replace(/^I could not (?:load|read|retrieve|access)[^.]*\.\s*/i, "")
    .replace(/^Could not (?:load|read|retrieve|access)[^.]*\.\s*/i, "")
    .replace(/^The (?:BusinessWire|Business Wire|article|press release) (?:article body|body|URL|page)[^.]*unavailable[^.]*\.\s*/i, "")
    .replace(/^Full article specifics[^.]*unavailable[^.]*\.\s*/i, "");

  sanitized = sanitized
    .replace(/\s*Full article specifics from the (?:BusinessWire|Business Wire|provided|source)?\s*URL were unavailable\.\s*$/i, "")
    .replace(/\s*Full article specifics were unavailable\.\s*$/i, "")
    .trim();

  return sanitized;
}

function suppressFallbackDisclosure(ai, articleSourceMode, secSource) {
  if (secSource) return ai;
  if (articleSourceMode !== "headline_only_fallback" && articleSourceMode !== "openai_url_fallback") {
    return ai;
  }

  const negatives = Array.isArray(ai?.negatives)
    ? ai.negatives.filter(item => {
        const normalized = cleanText(item || "");
        return !/(?:full article|article body|businesswire|business wire|provided url|source url).*(?:unavailable|could not|not readable|not loaded|not retrieved)/i.test(normalized);
      })
    : [];

  return {
    ...ai,
    summary: sanitizeFallbackDisclosureText(ai?.summary || ""),
    negatives
  };
}

async function processMessage(data) {
  console.log(`[PROCESS] Processing ${data.ticker}`);
  const processingStartedAt = new Date();
  const isMarketCapFeed = isMarketCapFeedEvent(data);
  if (isStaleMarketCapEvent(data, processingStartedAt)) {
    const eventAgeMs = getMarketCapEventAgeMs(data, processingStartedAt);
    console.log(
      `[PROCESS] Skipping stale market-cap scanner event for ${data.ticker}; age ${eventAgeMs ?? "unknown"}ms exceeds ${MARKET_CAP_MAX_EVENT_AGE_MS}ms.`
    );
    return buildStaleMarketCapSkipResult(data, processingStartedAt);
  }

  let fetchStartedAt = null;
  let fetchFinishedAt = null;
  let aiStartedAt = null;
  let aiFinishedAt = null;
  let levelsStartedAt = null;
  let levelsFinishedAt = null;
  let postStartedAt = null;
  let postFinishedAt = null;

  const reusableAnalysis = findRecentProcessedArticleAnalysis({
    id: data?.id,
    articleLink: data?.articleLink
  });
  let articleText = reusableAnalysis?.articleText;
  let ai = reusableAnalysis?.ai;
  let articleSourceMode = reusableAnalysis?.articleSourceMode || "fetched_direct";
  let articleFetchError = null;
  let openaiUrlFallbackError = null;
  const secSource = isSecSource(data.articleLink);
  const skipArticleFetchForDrop = !secSource && data.routeTag === "drop";
  const businessWireHeadlineOnly = !secSource && !skipArticleFetchForDrop && isBusinessWireUrl(data.articleLink);
  let levelsPromise = null;

  if (reusableAnalysis) {
    console.log(
      `[PROCESS] Reusing canonical AI analysis for ${data.ticker} from ${reusableAnalysis.ingestEventId}.`
    );
  }

  if (shouldBuildLevelsForPotentialPost(data, {
    isMarketCapFeed,
    useMinimalNewsDiscord: Boolean(NEWS_ARTICLE_API_URL),
    businessWireHeadlineOnly
  })) {
    const safeTicker = String(data.ticker || "").trim().toUpperCase();
    levelsStartedAt = new Date();
    console.log(`[LEVELS] Prefetching levels for ${safeTicker} while ${safeTicker} is processed`);
    levelsPromise = runLevelsScript(safeTicker)
      .then(levelsText => {
        levelsFinishedAt = new Date();
        return levelsText || "";
      })
      .catch(err => {
        levelsFinishedAt = new Date();
        console.error(`[LEVELS] Prefetch failed for ${safeTicker}: ${err.message}`);
        return "";
      });
  }

  if (!ai && skipArticleFetchForDrop) {
    console.log(`[PROCESS] Skipping article fetch for PR DROP ${data.ticker}`);
    articleText = "";
    ai = buildUrlFallbackMetadataOnlyResult({
      parsed: {
        headline: data.headline || null,
        tickers: Array.isArray(data.tickers) ? data.tickers : [data.ticker].filter(Boolean),
        eventType: "press_release_unreadable",
        confidence: 0.35,
        urlReadNotes: "PR DROP article fetch paused intentionally"
      },
      rawDiscordMessage: data.rawText,
      openaiUsage: null
    });
    aiFinishedAt = new Date();
    articleSourceMode = "headline_only_fallback";
  }

  if (!ai && businessWireHeadlineOnly) {
    console.log(`[PROCESS] BusinessWire headline-only post for ${data.ticker}; skipping article fetch and AI.`);
    articleText = "";
    ai = buildBusinessWireHeadlineOnlyAI(data);
    articleSourceMode = "businesswire_headline_only";
  }

  try {
    if (!ai && !skipArticleFetchForDrop && !businessWireHeadlineOnly) {
      fetchStartedAt = new Date();
      articleText = await fetchArticleText(data.articleLink, data.rawText);
      fetchFinishedAt = new Date();
    }
  } catch (err) {
    fetchFinishedAt = new Date();
    articleFetchError = err;
    if (normalizeSecDocumentUrl(data.articleLink).includes("sec.gov")) {
      console.warn(`[WARN] Using SEC unreadable fallback for ${data.ticker}: ${err.message}`);
      ai = buildUnreadableSecFallbackAI(data, err);
      articleSourceMode = "sec_unreadable_fallback";
    } else {
      console.warn(`[WARN] Direct article fetch failed for ${data.ticker}; skipping OpenAI because no article text was fetched: ${err.message}`);
      articleText = "";
      ai = buildUrlFallbackMetadataOnlyResult({
        parsed: {
          headline: data.headline || null,
          tickers: Array.isArray(data.tickers) ? data.tickers : [data.ticker].filter(Boolean),
          eventType: "press_release_unreadable",
          confidence: 0.35,
          urlReadNotes: err.message
        },
        rawDiscordMessage: data.rawText,
        openaiUsage: null
      });
      aiFinishedAt = new Date();
      articleSourceMode = "headline_only_fallback";
    }
  }

  if (!ai) {
    if (!aiStartedAt) {
      aiStartedAt = new Date();
    }
    try {
      ai = await generateAIAnalysis(data.rawText, articleText, data.articleLink);
      aiFinishedAt = new Date();
    } catch (err) {
      aiFinishedAt = new Date();
      console.warn(`[WARN] AI summary failed for ${data.ticker}; Discord will link to source: ${err.message}`);
      ai = buildUrlFallbackMetadataOnlyResult({
        parsed: {
          headline: data.headline || null,
          tickers: Array.isArray(data.tickers) ? data.tickers : [data.ticker].filter(Boolean),
          eventType: "press_release_unreadable",
          confidence: 0.35,
          urlReadNotes: err.message
        },
        rawDiscordMessage: data.rawText,
        openaiUsage: null
      });
      articleSourceMode = "ai_summary_unavailable";
    }
  } else {
    aiFinishedAt = aiFinishedAt || new Date();
  }

  ai = suppressFallbackDisclosure(ai, articleSourceMode, secSource);
  const articleSelectionMeta = businessWireHeadlineOnly ? null : getArticleSelectionMeta(data.articleLink);
  const documentDiagnostics = buildDocumentDiagnostics(articleSelectionMeta, articleText);
  const signalDiagnostics = buildSignalDiagnostics({
    ai,
    data,
    articleText,
    secSource
  });
  const duplicateDiagnostics = buildDuplicateDiagnostics({ data });

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
  const latencyMetricsBeforePost = buildLatencyMetrics({
    observedAt: data?.observedAt || null,
    processingStartedAt,
    fetchStartedAt,
    fetchFinishedAt,
    aiStartedAt,
    aiFinishedAt,
    levelsStartedAt: null,
    levelsFinishedAt: null,
    postStartedAt: null,
    postFinishedAt: null,
    processingFinishedAt: new Date()
  });
  const diagnosticReasonCodes = buildReasonCodes({
    ai,
    documentDiagnostics,
    signalDiagnostics,
    latencyMetrics: latencyMetricsBeforePost,
    duplicateDiagnostics,
    articleSourceMode,
    secSource
  });
  const postingDecision = buildPostingDecision({
    ai,
    data,
    articleText,
    articleSourceMode,
    signalDiagnostics,
    secSource,
    duplicateDiagnostics
  });
  const isSilentHostBackfill = isHostNewsTooOldForDiscord(data);
  const routeTag = cleanText(data?.routeTag || "default").toLowerCase();
  const aiSummaryAvailable = hasAiSummary(ai);
  const reasonCodes = mergeReasonCodes(
    diagnosticReasonCodes,
    postingDecision.reasons,
    isSilentHostBackfill ? ["host_news_discord_age_suppressed"] : []
  );
  let webhookTargets = getWebhookTargets(data.routeTag, ai, postingDecision);
  let freeNewsBotTargets = getFreeNewsBotTargets(routeTag, postingDecision);
  const hasEligibleWebsitePublishRoute = Boolean(webhookTargets.length || freeNewsBotTargets.length);
  if (isSilentHostBackfill) {
    webhookTargets = [];
    freeNewsBotTargets = [];
  }
  const includeLevels = !isMarketCapFeed;
  let postedMessages = [];
  let embeds = [];
  let newsPublishResult = null;
  let discordArticleUrl = null;
  let minimalDiscordPayload = null;
  let levelsText = "";
  let bufferPostResult = null;
  let stocktwitsQueueResult = null;
  let moomooQueueResult = null;

  if (hasEligibleWebsitePublishRoute) {
    if (NEWS_ARTICLE_API_URL) {
      if (aiSummaryAvailable) {
        if (includeLevels) {
          if (levelsPromise) {
            if (!levelsFinishedAt) {
              console.log(`[LEVELS] Waiting for prefetched levels for ${data.ticker}`);
            }
            levelsText = await levelsPromise;
          } else {
            levelsStartedAt = new Date();
            levelsText = await runLevelsScript(data.ticker);
            levelsFinishedAt = new Date();
          }
        }
        console.log(`[NEWS] Publishing website article for ${data.ticker} before Discord alert.`);
        newsPublishResult = await publishNewsArticle(
          buildNewsArticlePayload({
            data,
            ai,
            articleText,
            levelsText,
            articleSourceMode,
            documentDiagnostics,
            signalDiagnostics,
            latencyMetrics: buildLatencyMetrics({
              observedAt: data?.observedAt || null,
              processingStartedAt,
              fetchStartedAt,
              fetchFinishedAt,
              aiStartedAt,
              aiFinishedAt,
              levelsStartedAt,
              levelsFinishedAt,
              postStartedAt: null,
              postFinishedAt: null,
              processingFinishedAt: new Date()
            }),
            duplicateDiagnostics,
            reasonCodes
          })
        );
        discordArticleUrl = cleanText(newsPublishResult?.articleUrl || "");
        try {
          recordWebsiteArticlePost({
            ingestEventId: data.id,
            ticker: data.ticker,
            articleUrl: discordArticleUrl,
            articlePath: newsPublishResult?.articlePath || null,
            title: ai?.headline || data?.headline || null,
            eventType: ai?.eventType || null,
            filingType: ai?.filingType || null,
            routeTag: data?.routeTag || "default",
            sourceUrl: data?.articleLink || null,
            publishedAt: newsPublishResult?.publishedAt || firstIsoDate(data?.messageTimestamp, data?.observedAt),
            observedAt: data?.observedAt || data?.messageTimestamp || null
          });
        } catch (err) {
          console.warn(`[NEWS] Failed to track website article for ${data.ticker}: ${err.message}`);
        }
      } else {
        discordArticleUrl = getUserFacingSourceUrl(data.articleLink);
        if (discordArticleUrl) {
          console.log(
            `[NEWS] Skipping TradersLink article for ${data.ticker}; AI summary was not generated. Discord will link to source.`
          );
        }
      }

      if (isSilentHostBackfill) {
        console.log(
          `[BACKFILL] Saved host article for ${data.ticker}; Discord and social delivery suppressed because the source post is older than ${Math.round(HOST_DISCORD_MAX_EVENT_AGE_MS / 60000)} minute(s).`
        );
      } else if (!discordArticleUrl) {
        console.log(
          `[NEWS] No website article URL or user-facing source URL for ${data.ticker}; skipping Discord alert.`
        );
        webhookTargets = [];
      } else {
        const summaryUnavailable = !aiSummaryAvailable;
        minimalDiscordPayload = buildMinimalDiscordPayload(data, ai, discordArticleUrl, {
          summaryUnavailable
        });
        const freeDiscordArticleUrl =
          buildFreeNewsArticleUrl(newsPublishResult, discordArticleUrl) ||
          discordArticleUrl;
        const freeMinimalDiscordPayload = buildMinimalDiscordPayload(
          data,
          ai,
          freeDiscordArticleUrl,
          { summaryUnavailable }
        );
        const externalFreeNewsBotPayload = buildExternalFreeNewsBotPayload({
          data,
          ai,
          newsPublishResult,
          articleUrl: discordArticleUrl
        });
        const eligibleFreeNewsBotTargets = externalFreeNewsBotPayload
          ? freeNewsBotTargets
          : [];
        if (freeNewsBotTargets.length && !externalFreeNewsBotPayload) {
          console.warn(
            `[BOT] Skipping external free news bot delivery for ${data.ticker}; no processed TradersLink free article URL is available.`
          );
        }
        postStartedAt = new Date();
        const discordPostResult = await postToDiscordTargets({
          webhookTargets,
          freeNewsBotTargets: eligibleFreeNewsBotTargets,
          webhookPoster: webhookUrl =>
            postPayloadToWebhook(
              webhookUrl,
              isFreeDemoWebhookTarget(webhookUrl)
                ? freeMinimalDiscordPayload
                : minimalDiscordPayload
            ),
          botPayload: externalFreeNewsBotPayload
        });
        postFinishedAt = new Date();
        postedMessages = discordPostResult.postedMessages;
        const postErrors = discordPostResult.postErrors;

        if (postErrors.length) {
          console.warn(`[DISCORD] ${data.ticker} had ${postErrors.length} delivery failure(s): ${postErrors.join(" | ")}`);
        }

        if (!postedMessages.length && postErrors.length) {
          throw new Error(`All Discord posts failed for ${data.ticker}: ${postErrors.join(" | ")}`);
        }
      }
    } else if (isSilentHostBackfill) {
      console.warn(
        `[BACKFILL] Website publishing is not configured for ${data.ticker}; stale host event saved to ingest DB only.`
      );
    } else {
      if (includeLevels) {
        if (levelsPromise) {
          if (!levelsFinishedAt) {
            console.log(`[LEVELS] Waiting for prefetched levels for ${data.ticker}`);
          }
          levelsText = await levelsPromise;
        } else {
          levelsStartedAt = new Date();
          levelsText = await runLevelsScript(data.ticker);
          levelsFinishedAt = new Date();
        }
      } else {
        console.log(`[LEVELS] Skipping levels script for market-cap feed ${data.ticker}`);
      }
      embeds = buildDiscordEmbeds(ai, data, data.articleLink, levelsText, {
        includeLevels
      });
      if (freeNewsBotTargets.length) {
        console.warn(
          `[BOT] Skipping external free news bot delivery for ${data.ticker}; website article publishing is not configured.`
        );
      }
      postStartedAt = new Date();
      const discordPostResult = await postToDiscordTargets({
        webhookTargets,
        freeNewsBotTargets: [],
        webhookPoster: webhookUrl => postEmbedsToWebhook(webhookUrl, embeds),
        botPayload: null
      });
      postFinishedAt = new Date();
      postedMessages = discordPostResult.postedMessages;
      const postErrors = discordPostResult.postErrors;

      if (postErrors.length) {
        console.warn(`[DISCORD] ${data.ticker} had ${postErrors.length} delivery failure(s): ${postErrors.join(" | ")}`);
      }

      if (!postedMessages.length && postErrors.length) {
        throw new Error(`All Discord posts failed for ${data.ticker}: ${postErrors.join(" | ")}`);
      }
    }
  } else {
    console.log(
      `[PROCESS] No eligible Discord targets for ${data.ticker}; skipping post (${postingDecision.reasons.join(", ") || "filtered"}).`
    );
  }

  if (
    BUFFER_AUTOPOST_ENABLED &&
    countNewsFilteredPosts(postedMessages) > 0 &&
    !WEBHOOK_OVERRIDE_URL
  ) {
    if (!isBufferConfigured()) {
      console.warn("[BUFFER] Autopost enabled but BUFFER_API_KEY or BUFFER_X_CHANNEL_ID is missing; skipping X post.");
    } else {
      try {
        bufferPostResult = await publishBufferXPost({
          ticker: data.ticker,
          title: ai?.headline || data?.headline || "News alert"
        });
        if (bufferPostResult?.post?.id) {
          console.log(`[BUFFER] Shared ${data.ticker} to Buffer/X as post ${bufferPostResult.post.id}`);
        } else {
          console.log(`[BUFFER] Shared ${data.ticker} to Buffer/X`);
        }
      } catch (err) {
        console.warn(`[BUFFER] Failed to share ${data.ticker} to Buffer/X: ${err.message}`);
      }
    }
  }

  stocktwitsQueueResult = queueStocktwitsDraftAfterDiscord({
    data,
    ai,
    postedMessages
  });

  moomooQueueResult = queueMoomooDraftAfterDiscord({
    data,
    ai,
    postedMessages
  });

  if (shouldScheduleDelayedNewsDump({ postedMessages, webhookOverrideUrl: WEBHOOK_OVERRIDE_URL })) {
    scheduleDelayedNewsDumpPost({
      data,
      ai,
      articleUrl: discordArticleUrl,
      newsPublishResult
    });
  }

  const processingFinishedAt = new Date();
  const latencyMetrics = buildLatencyMetrics({
    observedAt: data?.observedAt || null,
    processingStartedAt,
    fetchStartedAt,
    fetchFinishedAt,
    aiStartedAt,
    aiFinishedAt,
    levelsStartedAt,
    levelsFinishedAt,
    postStartedAt,
    postFinishedAt,
    processingFinishedAt
  });
  const finalDiagnosticReasonCodes = buildReasonCodes({
    ai,
    documentDiagnostics,
    signalDiagnostics,
    latencyMetrics,
    duplicateDiagnostics,
    articleSourceMode,
    secSource
  });
  const finalReasonCodes = mergeReasonCodes(
    finalDiagnosticReasonCodes,
    postingDecision.reasons,
    isSilentHostBackfill ? ["host_news_discord_age_suppressed"] : []
  );
  const reviewQueueDecision = buildReviewQueueDecision({
    ai,
    articleSourceMode,
    documentDiagnostics,
    signalDiagnostics,
    latencyMetrics,
    duplicateDiagnostics,
    reasonCodes: finalReasonCodes,
    data
  });

  if (reviewQueueDecision.shouldQueue && REVIEW_QUEUE_APPEND_ENABLED) {
    await appendReviewQueueEntry({
      id: data.id,
      ticker: data.ticker,
      routeTag: data.routeTag || "default",
      articleLink: data.articleLink,
      filingType: ai.filingType || null,
      eventType: ai.eventType || "unknown",
      confidence: Number.isFinite(ai.confidence) ? ai.confidence : 0,
      articleSourceMode,
      reviewReasons: reviewQueueDecision.reviewReasons,
      reasonCodes: finalReasonCodes,
      selectedDocumentKind: articleSelectionMeta?.selectionKind || null,
      selectedDocumentType: articleSelectionMeta?.selectedDocumentType || null,
      wrapperRiskLevel: documentDiagnostics?.wrapperRiskLevel || null,
      signalQuality: signalDiagnostics?.signalQuality || null,
      signalFlags: Array.isArray(signalDiagnostics?.flags) ? signalDiagnostics.flags : [],
      latencyMetrics,
      duplicateDiagnostics,
      headline: ai.headline || null
    }).catch(err => {
      console.warn(`[REVIEW] Failed to append review queue entry for ${data.ticker}: ${err.message}`);
    });
    console.log(`[REVIEW] Queued ${data.ticker} for manual review: ${reviewQueueDecision.reviewReasons.join(", ")}`);
  } else if (reviewQueueDecision.shouldQueue) {
    console.log(`[REVIEW] Review queue append disabled; ${data.ticker} matched manual review conditions.`);
  }

  console.log(
    `[PROCESS] Completed ${data.ticker} in ${latencyMetrics.totalProcessingMs ?? "?"}ms` +
      (latencyMetrics.queueDelayMs != null ? ` (queue ${latencyMetrics.queueDelayMs}ms)` : "")
  );

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
    articleSelectionMeta,
    documentDiagnostics,
    signalDiagnostics,
    reasonCodes: finalReasonCodes,
    latencyMetrics,
    duplicateDiagnostics,
    reviewQueueDecision,
    postingDecision,
    webhookTargets,
    freeNewsBotTargets,
    postedMessages,
    bufferPostResult,
    stocktwitsQueueResult,
    moomooQueueResult,
    newsArticleUrl: discordArticleUrl || null,
    levelsText,
    newsPublishResult: newsPublishResult
      ? {
          ok: Boolean(newsPublishResult.ok),
          articlePath: cleanText(newsPublishResult.articlePath || "") || null,
          articleUrl: cleanText(newsPublishResult.articleUrl || "") || null
        }
      : null,
    embedCount: Array.isArray(embeds) ? embeds.length : 0,
    reviewArtifacts: {
      rawText: data.rawText,
      articleText,
      levelsText,
      ai,
      articleSelectionMeta,
      documentDiagnostics,
      signalDiagnostics,
      reasonCodes: finalReasonCodes,
      latencyMetrics,
      duplicateDiagnostics,
      reviewQueueDecision,
      postingDecision,
      webhookTargets,
      freeNewsBotTargets,
      postedMessages,
      bufferPostResult,
      stocktwitsQueueResult,
      moomooQueueResult,
      minimalDiscordPayload,
      newsArticleUrl: discordArticleUrl || null,
      newsPublishResult: newsPublishResult
        ? {
            ok: Boolean(newsPublishResult.ok),
            articlePath: cleanText(newsPublishResult.articlePath || "") || null,
            articleUrl: cleanText(newsPublishResult.articleUrl || "") || null
          }
        : null,
      articleSourceMode,
      articleFetchError: articleFetchError ? articleFetchError.message : null,
      openaiUrlFallbackError: openaiUrlFallbackError ? openaiUrlFallbackError.message : null
    }
  };
}

module.exports = {
  buildNewsArticlePayload,
  publishNewsArticle,
  processMessage,
  buildSignalDiagnostics,
  buildPostingDecision,
  buildDuplicateDiagnostics,
  isStaleMarketCapEvent,
  countNewsFilteredPosts,
  shouldScheduleDelayedNewsDump,
  buildFreeNewsArticleUrl,
  buildExternalFreeNewsBotPayload,
  getHostNewsEventAgeMs,
  isHostNewsTooOldForDiscord,
  shouldQueueStocktwitsDraft,
  shouldQueueMoomooDraft
};
