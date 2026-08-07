const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const MOOMOO_DIR = __dirname;
const DEFAULT_QUEUE_FILE = path.join(MOOMOO_DIR, "posts.json");
const DEFAULT_HISTORY_FILE = path.join(MOOMOO_DIR, "post-history.jsonl");
const DEFAULT_MAX_LENGTH = 900;
const DEFAULT_MIN_POST_INTERVAL_MS = 2 * 60 * 1000;
const MIN_ARTICLE_BODY_LENGTH = 50;
const DEFAULT_LOCK_STALE_MS = 2 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 10 * 1000;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hasUnusableArticleContent(value) {
  const text = cleanText(value);
  if (!text) return false;

  return [
    /\bai\s+(?:could not|couldn't|cannot|can't|was unable to|failed to)\s+(?:summari[sz]e|display|read|retrieve|access|process|analy[sz]e)\b/i,
    /\b(?:article|article content|content|page|web ?page|website|link)\s+(?:could not|couldn't|cannot|can't|was unable to|failed to)\s+(?:be\s+)?(?:summari[sz]ed|displayed|read|retrieved|accessed|loaded|processed)\b/i,
    /\b(?:article|article content|content|summary)\s+(?:is|was)\s+(?:unavailable|not available|unable to be displayed)\b/i,
    /\b(?:unable|failed)\s+to\s+(?:summari[sz]e|display|read|retrieve|access|load|process)\s+(?:the\s+)?(?:article|content|page|web ?page|website|link)\b/i,
    /\bno\s+(?:article\s+)?summary\s+available\b/i,
    /\bsummary\s+(?:is\s+)?unavailable\b/i,
    /\bno\s+(?:article\s+)?summary\s+(?:was\s+)?(?:provided|returned|generated)\b/i,
    /\bai\s+summary\s+could\s+not\s+be\s+provided\s+for\s+this\s+article\b/i
  ].some(pattern => pattern.test(text));
}

// Operational status text is not article content. It must never be converted
// into a Moomoo post, even if the source event also includes a ticker.
function hasNonArticleSystemStatus(value) {
  const text = cleanText(value);
  if (!text) return false;

  return [
    /\bskipped\s+stale\s+market[\s-]?cap\s+scanner\s+event\b/i,
    /\bmarket_cap_stale_skip\b/i
  ].some(pattern => pattern.test(text));
}

function hasUsableArticleTitle(value) {
  const title = cleanText(value);
  return Boolean(title) &&
    !hasUnusableArticleContent(title) &&
    !hasNonArticleSystemStatus(title) &&
    !/^news alert[.!]?$/i.test(title);
}

function hasPublishableArticleBody(value, minLength = MIN_ARTICLE_BODY_LENGTH) {
  const body = cleanText(value);
  return body.length >= minLength &&
    !hasUnusableArticleContent(body) &&
    !hasNonArticleSystemStatus(body);
}

function normalizeTicker(value) {
  return cleanText(value).replace(/^\$/, "").replace(/\.US$/i, "").toUpperCase();
}

function normalizeTickers(value) {
  const raw = Array.isArray(value) ? value : [value];
  const tickers = [];
  for (const item of raw) {
    const ticker = normalizeTicker(item);
    if (ticker && !tickers.includes(ticker)) tickers.push(ticker);
  }
  return tickers;
}

function normalizeMessage(value) {
  return cleanText(value).toLowerCase();
}

function messageHash(message) {
  return crypto.createHash("sha256").update(normalizeMessage(message)).digest("hex");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockFileFor(filePath) {
  return `${filePath}.lock`;
}

function acquireFileLock(filePath, options = {}) {
  const lockPath = lockFileFor(filePath);
  const waitMs = Number(options.waitMs ?? process.env.MOOMOO_QUEUE_LOCK_WAIT_MS ?? DEFAULT_LOCK_WAIT_MS);
  const staleMs = Number(options.staleMs ?? process.env.MOOMOO_QUEUE_LOCK_STALE_MS ?? DEFAULT_LOCK_STALE_MS);
  const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : DEFAULT_LOCK_WAIT_MS);
  const lockBody = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), filePath });

  ensureDir(path.dirname(filePath));
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, `${lockBody}\n`, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch (_) {
          // Best-effort lock cleanup.
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      try {
        const stat = fs.statSync(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (Number.isFinite(staleMs) && staleMs > 0 && ageMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (_) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for queue lock: ${lockPath}`);
      }
      sleepSync(100);
    }
  }
}

function withQueueLock(queueFile, fn) {
  const release = acquireFileLock(queueFile);
  try {
    return fn();
  } finally {
    release();
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function writeJsonFileAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function loadQueue(queueFile = DEFAULT_QUEUE_FILE) {
  const rows = readJsonFile(queueFile, []);
  if (!Array.isArray(rows)) {
    throw new Error(`Queue file must contain a JSON array: ${queueFile}`);
  }
  return rows;
}

function saveQueue(rows, queueFile = DEFAULT_QUEUE_FILE) {
  writeJsonFileAtomic(queueFile, rows);
}

function updateQueue(queueFile = DEFAULT_QUEUE_FILE, updater) {
  return withQueueLock(queueFile, () => {
    const rows = loadQueue(queueFile);
    const result = updater(rows);
    if (result) saveQueue(rows, queueFile);
    return result;
  });
}

function readHistory(historyFile = DEFAULT_HISTORY_FILE) {
  if (!fs.existsSync(historyFile)) return [];
  return fs.readFileSync(historyFile, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function appendHistory(entry, historyFile = DEFAULT_HISTORY_FILE) {
  const release = acquireFileLock(historyFile);
  try {
    ensureDir(path.dirname(historyFile));
    fs.appendFileSync(historyFile, `${JSON.stringify(entry)}\n`, "utf8");
  } finally {
    release();
  }
}

function buildMessage(post) {
  const explicitMessage = String(post?.message || "").trim();

  const tickers = getPostTickers(post);
  const title = cleanText(post?.title || post?.headline || "");
  const tagLine = tickers.map(ticker => `$${ticker}`).join(" ");
  const titleOnlyMessage = `${tagLine}${tagLine && title ? " " : ""}${title}`.trim();

  // A failed article/summary response must never become post content. When
  // possible, keep the useful article title and discard the unusable text.
  if (explicitMessage && !hasUnusableArticleContent(explicitMessage)) return explicitMessage;
  if (explicitMessage && hasUnusableArticleContent(explicitMessage)) return titleOnlyMessage;

  const summary = cleanText(post?.summary || "");
  const lines = [];

  if (tickers.length || title) {
    lines.push(titleOnlyMessage);
  }
  if (summary && !hasUnusableArticleContent(summary)) lines.push(summary);

  return lines.join("\n\n").trim();
}

function getPostTickers(post) {
  const tickers = normalizeTickers(post?.tickers);
  const primary = normalizeTicker(post?.ticker);
  if (primary && !tickers.includes(primary)) tickers.unshift(primary);
  return tickers;
}

function getScheduledTime(post) {
  const scheduledAt = cleanText(post?.scheduledAt || "");
  if (!scheduledAt) return null;
  const date = new Date(scheduledAt);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isPendingStatus(value) {
  const status = cleanText(value || "pending").toLowerCase();
  return !status || status === "pending" || status === "queued";
}

function getPostedAtMs(value) {
  const text = cleanText(value || "");
  if (!text) return null;
  const timestamp = new Date(text).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getLastPostedAtMs(rows = [], history = []) {
  const queueTimes = (Array.isArray(rows) ? rows : [])
    .filter(row => cleanText(row?.status || "").toLowerCase() === "posted")
    .map(row => getPostedAtMs(row?.postedAt))
    .filter(value => Number.isFinite(value));

  const historyTimes = (Array.isArray(history) ? history : [])
    .map(entry => getPostedAtMs(entry?.postedAt))
    .filter(value => Number.isFinite(value));

  const times = [...queueTimes, ...historyTimes];
  return times.length ? Math.max(...times) : null;
}

function getPostCooldown(rows = [], history = [], now = new Date(), options = {}) {
  const minIntervalMs = Number(options.minPostIntervalMs ?? DEFAULT_MIN_POST_INTERVAL_MS);
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) {
    return { active: false, minPostIntervalMs: 0, lastPostedAt: null, nextAllowedAt: null, remainingMs: 0 };
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const lastPostedAtMs = getLastPostedAtMs(rows, history);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastPostedAtMs)) {
    return { active: false, minPostIntervalMs: minIntervalMs, lastPostedAt: null, nextAllowedAt: null, remainingMs: 0 };
  }

  const nextAllowedAtMs = lastPostedAtMs + minIntervalMs;
  const remainingMs = Math.max(0, nextAllowedAtMs - nowMs);
  return {
    active: remainingMs > 0,
    minPostIntervalMs: minIntervalMs,
    lastPostedAt: new Date(lastPostedAtMs).toISOString(),
    nextAllowedAt: new Date(nextAllowedAtMs).toISOString(),
    remainingMs
  };
}

function validatePost(post, allPosts, history, now = new Date(), options = {}) {
  const maxLength = Number(options.maxLength || DEFAULT_MAX_LENGTH);
  const id = cleanText(post?.id || "");
  const tickers = getPostTickers(post);
  const ticker = tickers[0] || "";
  const title = cleanText(post?.title || post?.headline || "");
  const hasCleanTitle = hasUsableArticleTitle(title);
  const hasPublishableBody = hasPublishableArticleBody(post?.summary);
  const nonArticleSystemStatus = hasNonArticleSystemStatus(title) ||
    hasNonArticleSystemStatus(post?.message) ||
    hasNonArticleSystemStatus(post?.summary) ||
    hasNonArticleSystemStatus(post?.eventType) ||
    hasNonArticleSystemStatus(post?.articleSourceMode);
  const message = buildMessage(post);
  const hash = messageHash(message);

  if (!id) return { ok: false, reason: "missing id", terminal: true };
  if (!ticker) return { ok: false, reason: "missing ticker", terminal: true };
  if (nonArticleSystemStatus) {
    return { ok: false, reason: "non-article scanner status", terminal: true };
  }
  if (!hasCleanTitle) {
    return { ok: false, reason: "missing clean article title", terminal: true };
  }
  if (!hasPublishableBody) {
    return { ok: false, reason: `article body must contain at least ${MIN_ARTICLE_BODY_LENGTH} usable characters`, terminal: true };
  }
  if (!message.trim()) return { ok: false, reason: "empty message", terminal: true };
  if (message.length > maxLength) {
    return { ok: false, reason: `message too long (${message.length}/${maxLength})`, terminal: true };
  }

  for (const tagTicker of tickers) {
    const escapedTicker = tagTicker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tickerTagPattern = new RegExp(`(^|[^A-Z0-9_$])(\\$${escapedTicker}|${escapedTicker})(\\b|\\.US\\b|\\$)`, "i");
    if (!tickerTagPattern.test(message)) {
      return { ok: false, reason: `message missing ${tagTicker} ticker symbol/cashtag`, terminal: true };
    }
  }

  const scheduledTime = getScheduledTime(post);
  if (scheduledTime && scheduledTime.getTime() > now.getTime()) {
    return {
      ok: false,
      reason: `scheduled for future (${scheduledTime.toISOString()})`,
      terminal: false
    };
  }

  const postIndex = allPosts.indexOf(post);
  const duplicateInQueue = allPosts.some((other, index) => {
    if (other === post) return false;
    const otherStatus = cleanText(other?.status || "pending").toLowerCase();
    if (otherStatus === "skipped" || otherStatus === "failed") return false;
    if (otherStatus !== "posted" && postIndex >= 0 && index > postIndex) return false;
    return messageHash(buildMessage(other)) === hash || cleanText(other?.id || "") === id;
  });
  if (duplicateInQueue) return { ok: false, reason: "duplicate id/message hash in queue", terminal: true };

  const duplicateInHistory = history.some(entry => entry?.messageHash === hash || cleanText(entry?.id || "") === id);
  if (duplicateInHistory) return { ok: false, reason: "duplicate of post history", terminal: true };

  return { ok: true, id, ticker, tickers, message, messageHash: hash };
}

function selectNextDuePost(rows, history, now = new Date(), options = {}) {
  const skipped = [];
  const cooldown = getPostCooldown(rows, history, now, options);
  if (cooldown.active) {
    return { post: null, validation: null, skipped, cooldown };
  }

  const sourceFilter = cleanText(options.sourceFilter || "");
  for (const post of rows) {
    if (!isPendingStatus(post?.status)) continue;
    if (sourceFilter && cleanText(post?.source || "") !== sourceFilter) continue;
    const validation = validatePost(post, rows, history, now, options);
    if (validation.ok) {
      return { post, validation, skipped, cooldown };
    }
    skipped.push({
      id: cleanText(post?.id || ""),
      ticker: normalizeTicker(post?.ticker),
      reason: validation.reason,
      terminal: validation.terminal
    });
  }
  return { post: null, validation: null, skipped, cooldown };
}

function markPostStatus(rows, id, patch) {
  const targetId = cleanText(id || "");
  const index = rows.findIndex(row => cleanText(row?.id || "") === targetId);
  if (index === -1) return false;
  rows[index] = { ...rows[index], ...patch };
  return true;
}

function resolveQueueFile() {
  return path.resolve(ROOT_DIR, process.env.MOOMOO_QUEUE_FILE || DEFAULT_QUEUE_FILE);
}

module.exports = {
  ROOT_DIR,
  MOOMOO_DIR,
  DEFAULT_QUEUE_FILE,
  DEFAULT_HISTORY_FILE,
  DEFAULT_MAX_LENGTH,
  DEFAULT_MIN_POST_INTERVAL_MS,
  MIN_ARTICLE_BODY_LENGTH,
  cleanText,
  hasUnusableArticleContent,
  hasNonArticleSystemStatus,
  hasUsableArticleTitle,
  hasPublishableArticleBody,
  normalizeTicker,
  normalizeTickers,
  messageHash,
  buildMessage,
  getPostTickers,
  ensureDir,
  withQueueLock,
  readJsonFile,
  writeJsonFileAtomic,
  loadQueue,
  saveQueue,
  updateQueue,
  readHistory,
  appendHistory,
  getPostedAtMs,
  getLastPostedAtMs,
  getPostCooldown,
  validatePost,
  selectNextDuePost,
  markPostStatus,
  resolveQueueFile
};
