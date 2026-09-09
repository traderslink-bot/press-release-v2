const {
  DEFAULT_MAX_LENGTH,
  cleanText,
  hasUnusableArticleContent,
  hasNonArticleSystemStatus,
  hasUsableArticleTitle,
  hasPublishableArticleBody,
  normalizeTicker,
  messageHash,
  loadQueue,
  saveQueue,
  readHistory,
  resolveQueueFile,
  withQueueLock
} = require("./queue");

const DEFAULT_DELAY_MS = 5 * 60 * 1000;

function isKillSwitchActive() {
  return process.env.MOOMOO_KILL_SWITCH === "1" ||
    /^true$/i.test(process.env.MOOMOO_KILL_SWITCH || "") ||
    require("fs").existsSync(require("path").join(__dirname, "KILL_SWITCH"));
}

function getQueueDelayMs() {
  const raw = process.env.MOOMOO_QUEUE_DELAY_MS || process.env.MOOMOO_ENQUEUE_DELAY_MS;
  const value = Number(raw || DEFAULT_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DELAY_MS;
}

function getMaxLength() {
  const value = Number(process.env.MOOMOO_MAX_LENGTH || DEFAULT_MAX_LENGTH);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_LENGTH;
}

function isQueueEnabled() {
  return !/^false$/i.test(process.env.MOOMOO_QUEUE_ENABLED || "true");
}

function truncateText(text, maxLength) {
  const normalized = cleanText(text || "");
  if (normalized.length <= maxLength) {
    return { text: normalized, truncated: false, originalLength: normalized.length };
  }
  if (maxLength <= 3) {
    return { text: normalized.slice(0, maxLength), truncated: true, originalLength: normalized.length };
  }
  return {
    text: `${normalized.slice(0, maxLength - 3).trim()}...`,
    truncated: true,
    originalLength: normalized.length
  };
}

function buildMoomooMessageDetails({ ticker, tickers = [], title, summary, maxLength = getMaxLength() }) {
  const normalizedTickers = [...new Set([ticker, ...tickers].map(value => normalizeTicker(value)).filter(Boolean))];
  const normalizedTicker = normalizedTickers[0] || "";
  const titleText = cleanText(title || "");
  const rawSummaryText = cleanText(summary || "");
  const summaryText = hasUnusableArticleContent(rawSummaryText) ? "" : rawSummaryText;
  const cashtags = normalizedTickers.map(symbol => `$${symbol}`).join(" ");
  const titlePrefix = `${cashtags}${cashtags && titleText ? " " : ""}`;
  const titleBudget = Math.max(0, maxLength - titlePrefix.length);
  const titleResult = truncateText(titleText, titleBudget);
  const firstLine = `${titlePrefix}${titleResult.text}`.trim();

  if (!summaryText) {
    return {
      message: truncateText(firstLine, maxLength).text,
      truncated: titleResult.truncated,
      truncatedTitle: titleResult.truncated,
      truncatedSummary: false,
      originalTitleLength: titleResult.originalLength,
      originalSummaryLength: 0
    };
  }

  const separator = "\n\n";
  const fixedLength = firstLine.length + separator.length;
  const summaryBudget = Math.max(0, maxLength - fixedLength);
  const summaryResult = truncateText(summaryText, summaryBudget);
  const message = summaryResult.text ? `${firstLine}${separator}${summaryResult.text}`.trim() : firstLine;
  return {
    message,
    truncated: titleResult.truncated || summaryResult.truncated,
    truncatedTitle: titleResult.truncated,
    truncatedSummary: summaryResult.truncated,
    originalTitleLength: titleResult.originalLength,
    originalSummaryLength: summaryResult.originalLength
  };
}

function buildMoomooMessage({ ticker, tickers = [], title, summary, maxLength = getMaxLength() }) {
  return buildMoomooMessageDetails({ ticker, tickers, title, summary, maxLength }).message;
}

function hasDuplicateQueuedOrPosted(rows, hash, id) {
  return rows.some(row => {
    const status = cleanText(row?.status || "pending").toLowerCase();
    const rowId = cleanText(row?.id || "");
    if (rowId === id) return true;
    if (status === "skipped" || status === "failed") return false;
    const rowMessage = cleanText(row?.message || "");
    return rowMessage && messageHash(rowMessage) === hash;
  });
}

function hasDuplicateHistory(history, hash, id) {
  return history.some(entry => entry?.messageHash === hash || cleanText(entry?.id || "") === id);
}

function queueIdForSource(source, sourceId) {
  const normalizedSource = cleanText(source || "");
  const normalizedId = cleanText(sourceId || "");
  if (normalizedSource === "press_release_v2") return `pr-v2-${normalizedId}`;
  return `${normalizedSource.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "moomoo"}-${normalizedId}`;
}

function enqueueMoomooDraft({ id, ticker, tickers = [], title, summary, sentiment = "", source = "press_release_v2", scheduledAt: requestedScheduledAt = "", eventType = "", articleSourceMode = "" }) {
  if (isKillSwitchActive()) {
    return { ok: false, skipped: true, reason: "moomoo poster is paused by the stop switch" };
  }
  if (!isQueueEnabled()) {
    return { ok: false, skipped: true, reason: "moomoo queue disabled" };
  }

  const normalizedTickers = [...new Set([ticker, ...tickers].map(value => normalizeTicker(value)).filter(Boolean))];
  const normalizedTicker = normalizedTickers[0] || "";
  const sourceId = cleanText(id || "");
  const cleanTitle = cleanText(title || "");
  const cleanArticleBody = cleanText(summary || "");
  const nonArticleSystemStatus = hasNonArticleSystemStatus(cleanTitle) ||
    hasNonArticleSystemStatus(summary) ||
    hasNonArticleSystemStatus(eventType) ||
    hasNonArticleSystemStatus(articleSourceMode);
  if (!normalizedTicker) {
    return { ok: false, skipped: true, reason: "missing ticker" };
  }
  if (!sourceId) {
    return { ok: false, skipped: true, reason: "missing id" };
  }
  if (nonArticleSystemStatus) {
    return { ok: false, skipped: true, reason: "non-article scanner status" };
  }
  if (!hasUsableArticleTitle(cleanTitle)) {
    return { ok: false, skipped: true, reason: "missing clean article title" };
  }
  if (!hasPublishableArticleBody(cleanArticleBody)) {
    return { ok: false, skipped: true, reason: "article body must contain at least 50 usable characters" };
  }
  const queueFile = resolveQueueFile();
  const queueId = queueIdForSource(source, sourceId);
  const messageDetails = buildMoomooMessageDetails({ ticker: normalizedTicker, tickers: normalizedTickers.slice(1), title, summary });
  const message = messageDetails.message;
  const hash = messageHash(message);
  const scheduledAt = cleanText(requestedScheduledAt || "") || new Date(Date.now() + getQueueDelayMs()).toISOString();

  for (const symbol of normalizedTickers) {
    if (!message.includes(`$${symbol}`)) {
      return { ok: false, skipped: true, reason: `message missing $${symbol} ticker tag` };
    }
  }
  if (!cleanText(message)) return { ok: false, skipped: true, reason: "empty message after sanitization" };

  return withQueueLock(queueFile, () => {
    const rows = loadQueue(queueFile);
    const history = readHistory();

    if (hasDuplicateQueuedOrPosted(rows, hash, queueId) || hasDuplicateHistory(history, hash, queueId)) {
      return { ok: false, skipped: true, reason: "duplicate moomoo draft", id: queueId, ticker: normalizedTicker };
    }

    const item = {
      id: queueId,
      ticker: normalizedTicker,
      tickers: normalizedTickers,
      title: cleanTitle,
      summary: cleanText(summary || ""),
      message,
      sentiment: cleanText(sentiment || ""),
      eventType: cleanText(eventType || ""),
      articleSourceMode: cleanText(articleSourceMode || ""),
      scheduledAt,
      status: "pending",
      postedAt: "",
      error: "",
      source
    };

    rows.push(item);
    saveQueue(rows, queueFile);

    return {
      ok: true,
      id: queueId,
      ticker: normalizedTicker,
      tickers: normalizedTickers,
      scheduledAt,
      source,
      messageLength: message.length,
      truncated: messageDetails.truncated,
      truncatedTitle: messageDetails.truncatedTitle,
      truncatedSummary: messageDetails.truncatedSummary,
      originalTitleLength: messageDetails.originalTitleLength,
      originalSummaryLength: messageDetails.originalSummaryLength,
      queueFile
    };
  });
}

module.exports = {
  buildMoomooMessage,
  buildMoomooMessageDetails,
  enqueueMoomooDraft,
  queueIdForSource
};
