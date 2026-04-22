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
  generateAIUrlFallbackAnalysis,
  stabilizeAIResult
} = require("./ai");
const { runLevelsScript } = require("./levels");
const { buildDiscordEmbeds, getWebhookTargets, postEmbedsToWebhook } = require("./discord");
const { appendReviewQueueEntry } = require("./reviewQueue");
const { cleanText } = require("./utils");
const { findRecentDuplicateContext } = require("./ingestStore");

function roundDuration(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
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

function buildDuplicateDiagnostics({ data }) {
  const duplicateContext = findRecentDuplicateContext({
    id: data?.id,
    articleLink: data?.articleLink
  });

  return {
    duplicateGroupKey: duplicateContext.duplicateGroupKey,
    recentDuplicateCount: duplicateContext.recentDuplicateCount,
    recentDuplicates: duplicateContext.recentDuplicates,
    isRecentDuplicate: duplicateContext.isRecentDuplicate
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
  if (articleSourceMode === "sec_unreadable_fallback") reasonCodes.add("sec_unreadable_fallback_used");
  if (ai?.isFallback) reasonCodes.add("ai_fallback_output");
  if (secSource) reasonCodes.add("sec_source");
  if (Number(latencyMetrics?.totalProcessingMs || 0) >= 20000) reasonCodes.add("slow_processing_latency");
  if (Number(latencyMetrics?.queueDelayMs || 0) >= 10000) reasonCodes.add("queue_delay_high");
  if (duplicateDiagnostics?.isRecentDuplicate) reasonCodes.add("recent_duplicate_article_url");

  return Array.from(reasonCodes);
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

function sanitizeFallbackDisclosureText(text) {
  return cleanText(String(text || ""))
    .replace(/^Article text unavailable;\s*summary based on raw Discord metadata\.\s*/i, "")
    .replace(/^Summary based on raw Discord metadata\.\s*/i, "")
    .replace(/^Full article text unavailable[^.]*\.\s*/i, "");
}

function suppressFallbackDisclosure(ai, articleSourceMode, secSource) {
  if (secSource) return ai;
  if (articleSourceMode !== "headline_only_fallback" && articleSourceMode !== "openai_url_fallback") {
    return ai;
  }

  const negatives = Array.isArray(ai?.negatives)
    ? ai.negatives.filter(item => {
        const normalized = cleanText(item || "");
        return !/^Full article text unavailable/i.test(normalized);
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
  let fetchStartedAt = null;
  let fetchFinishedAt = null;
  let aiStartedAt = null;
  let aiFinishedAt = null;
  let levelsStartedAt = null;
  let levelsFinishedAt = null;
  let postStartedAt = null;
  let postFinishedAt = null;

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
    aiStartedAt = new Date();
    ai = await generateAIAnalysis(data.rawText, articleText, data.articleLink);
    aiFinishedAt = new Date();
  } else {
    aiFinishedAt = new Date();
  }

  ai = suppressFallbackDisclosure(ai, articleSourceMode, secSource);
  const articleSelectionMeta = getArticleSelectionMeta(data.articleLink);
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
  const reasonCodes = buildReasonCodes({
    ai,
    documentDiagnostics,
    signalDiagnostics,
    latencyMetrics: latencyMetricsBeforePost,
    duplicateDiagnostics,
    articleSourceMode,
    secSource
  });

  levelsStartedAt = new Date();
  const levelsText = await runLevelsScript(data.ticker);
  levelsFinishedAt = new Date();
  const embeds = buildDiscordEmbeds(ai, data, data.articleLink, levelsText);
  const webhookTargets = getWebhookTargets(data.routeTag, ai);
  let postedMessages = [];

  if (webhookTargets.length) {
    postStartedAt = new Date();
    const postResults = await Promise.all(
      webhookTargets.map(webhookUrl => postEmbedsToWebhook(webhookUrl, embeds))
    );
    postFinishedAt = new Date();
    postedMessages = postResults.filter(Boolean);
  } else {
    console.log(`[PROCESS] No eligible webhook targets for ${data.ticker}; skipping post.`);
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
  const finalReasonCodes = buildReasonCodes({
    ai,
    documentDiagnostics,
    signalDiagnostics,
    latencyMetrics,
    articleSourceMode,
    secSource
  });
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

  if (reviewQueueDecision.shouldQueue) {
    appendReviewQueueEntry({
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
    });
    console.log(`[REVIEW] Queued ${data.ticker} for manual review: ${reviewQueueDecision.reviewReasons.join(", ")}`);
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
    webhookTargets,
    postedMessages,
    embedCount: Array.isArray(embeds) ? embeds.length : 0,
    reviewArtifacts: {
      rawText: data.rawText,
      articleText,
      ai,
      articleSelectionMeta,
      documentDiagnostics,
      signalDiagnostics,
      reasonCodes: finalReasonCodes,
      latencyMetrics,
      duplicateDiagnostics,
      reviewQueueDecision,
      postedMessages,
      articleSourceMode,
      articleFetchError: articleFetchError ? articleFetchError.message : null,
      openaiUrlFallbackError: openaiUrlFallbackError ? openaiUrlFallbackError.message : null
    }
  };
}

module.exports = {
  processMessage,
  buildSignalDiagnostics
};
