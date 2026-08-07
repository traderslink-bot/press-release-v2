const {
  STOCKTWITS_DIR,
  DEFAULT_MAX_LENGTH,
  cleanText,
  normalizeTicker,
  messageHash,
  loadQueue,
  saveQueue,
  readHistory,
  resolveQueueFile,
  withQueueLock
} = require("./queue");
const fs = require("fs");
const path = require("path");

const DEFAULT_DELAY_MS = 3 * 60 * 1000;
const KILL_SWITCH_FILE = path.join(STOCKTWITS_DIR, "KILL_SWITCH");

function getQueueDelayMs() {
  const raw = process.env.STOCKTWITS_QUEUE_DELAY_MS || process.env.STOCKTWITS_ENQUEUE_DELAY_MS;
  const value = Number(raw || DEFAULT_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DELAY_MS;
}

function getMaxLength() {
  const value = Number(process.env.STOCKTWITS_MAX_LENGTH || DEFAULT_MAX_LENGTH);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_LENGTH;
}

function isQueueEnabled() {
  if (
    process.env.STOCKTWITS_KILL_SWITCH === "1" ||
    /^true$/i.test(process.env.STOCKTWITS_KILL_SWITCH || "") ||
    fs.existsSync(KILL_SWITCH_FILE)
  ) {
    return false;
  }
  return !/^false$/i.test(process.env.STOCKTWITS_QUEUE_ENABLED || "true");
}

function truncateText(text, maxLength) {
  const normalized = cleanText(text || "");
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 3) return normalized.slice(0, maxLength);
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function buildStocktwitsMessage({ ticker, title, summary, maxLength = getMaxLength() }) {
  const normalizedTicker = normalizeTicker(ticker);
  const titleText = cleanText(title || "News alert");
  const summaryText = cleanText(summary || "");
  const cashtag = normalizedTicker ? `$${normalizedTicker}` : "";
  const titlePrefix = `${cashtag}${cashtag && titleText ? " " : ""}`;
  const titleBudget = Math.max(0, maxLength - titlePrefix.length);
  const firstLine = `${titlePrefix}${truncateText(titleText, titleBudget)}`.trim();

  if (!summaryText) {
    return truncateText(firstLine, maxLength);
  }

  const separator = "\n\n";
  const fixedLength = firstLine.length + separator.length;
  const summaryBudget = Math.max(0, maxLength - fixedLength);
  const summaryPart = truncateText(summaryText, summaryBudget);
  return summaryPart ? `${firstLine}${separator}${summaryPart}`.trim() : firstLine;
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

function enqueueStocktwitsDraft({ id, ticker, title, summary, sentiment = "", source = "press_release_v2", scheduledAt: requestedScheduledAt = "" }) {
  if (!isQueueEnabled()) {
    return { ok: false, skipped: true, reason: "stocktwits queue disabled" };
  }

  const normalizedTicker = normalizeTicker(ticker);
  const sourceId = cleanText(id || "");
  if (!normalizedTicker) {
    return { ok: false, skipped: true, reason: "missing ticker" };
  }
  if (!sourceId) {
    return { ok: false, skipped: true, reason: "missing id" };
  }

  const queueFile = resolveQueueFile();
  const queueId = `pr-v2-${sourceId}`;
  const message = buildStocktwitsMessage({ ticker: normalizedTicker, title, summary });
  const hash = messageHash(message);
  const scheduledAt = cleanText(requestedScheduledAt || "") || new Date(Date.now() + getQueueDelayMs()).toISOString();

  if (!message.includes(`$${normalizedTicker}`)) {
    return { ok: false, skipped: true, reason: `message missing $${normalizedTicker} cashtag` };
  }

  return withQueueLock(queueFile, () => {
    const rows = loadQueue(queueFile);
    const history = readHistory();

    if (hasDuplicateQueuedOrPosted(rows, hash, queueId) || hasDuplicateHistory(history, hash, queueId)) {
      return { ok: false, skipped: true, reason: "duplicate stocktwits draft", id: queueId, ticker: normalizedTicker };
    }

    const item = {
      id: queueId,
      ticker: normalizedTicker,
      title: cleanText(title || "News alert"),
      summary: cleanText(summary || ""),
      message,
      sentiment: cleanText(sentiment || ""),
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
      scheduledAt,
      messageLength: message.length,
      queueFile
    };
  });
}

module.exports = {
  buildStocktwitsMessage,
  enqueueStocktwitsDraft
};
