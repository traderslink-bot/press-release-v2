const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const STOCKTWITS_DIR = __dirname;
const DEFAULT_QUEUE_FILE = path.join(STOCKTWITS_DIR, "posts.json");
const DEFAULT_HISTORY_FILE = path.join(STOCKTWITS_DIR, "post-history.jsonl");
const DEFAULT_MAX_LENGTH = 900;
const DEFAULT_MIN_POST_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_LOCK_STALE_MS = 2 * 60 * 1000;
const DEFAULT_LOCK_WAIT_MS = 10 * 1000;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTicker(value) {
  return cleanText(value).replace(/^\$/, "").toUpperCase();
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
  const waitMs = Number(options.waitMs ?? process.env.STOCKTWITS_QUEUE_LOCK_WAIT_MS ?? DEFAULT_LOCK_WAIT_MS);
  const staleMs = Number(options.staleMs ?? process.env.STOCKTWITS_QUEUE_LOCK_STALE_MS ?? DEFAULT_LOCK_STALE_MS);
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
  if (explicitMessage) return explicitMessage;

  const ticker = normalizeTicker(post?.ticker);
  const title = cleanText(post?.title || post?.headline || "");
  const summary = cleanText(post?.summary || "");
  const lines = [];

  if (ticker || title) {
    lines.push(`${ticker ? `$${ticker}` : ""}${ticker && title ? " " : ""}${title}`.trim());
  }
  if (summary) lines.push(summary);

  return lines.join("\n\n").trim();
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
  const ticker = normalizeTicker(post?.ticker);
  const message = buildMessage(post);
  const hash = messageHash(message);

  if (!id) return { ok: false, reason: "missing id", terminal: true };
  if (!ticker) return { ok: false, reason: "missing ticker", terminal: true };
  if (!message.trim()) return { ok: false, reason: "empty message", terminal: true };
  if (message.length > maxLength) {
    return { ok: false, reason: `message too long (${message.length}/${maxLength})`, terminal: true };
  }

  const cashtagPattern = new RegExp(`(^|[^A-Z0-9_$])\\$${ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (!cashtagPattern.test(message)) {
    return { ok: false, reason: `message missing $${ticker} cashtag`, terminal: true };
  }

  const scheduledTime = getScheduledTime(post);
  if (scheduledTime && scheduledTime.getTime() > now.getTime()) {
    return {
      ok: false,
      reason: `scheduled for future (${scheduledTime.toISOString()})`,
      terminal: false
    };
  }

  const duplicateInQueue = allPosts.some(other => {
    if (other === post) return false;
    if (cleanText(other?.status).toLowerCase() !== "posted") return false;
    return messageHash(buildMessage(other)) === hash || cleanText(other?.id || "") === id;
  });
  if (duplicateInQueue) return { ok: false, reason: "duplicate of posted queue item", terminal: true };

  const duplicateInHistory = history.some(entry => entry?.messageHash === hash || cleanText(entry?.id || "") === id);
  if (duplicateInHistory) return { ok: false, reason: "duplicate of post history", terminal: true };

  return { ok: true, id, ticker, message, messageHash: hash };
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
  return path.resolve(ROOT_DIR, process.env.STOCKTWITS_QUEUE_FILE || DEFAULT_QUEUE_FILE);
}

module.exports = {
  ROOT_DIR,
  STOCKTWITS_DIR,
  DEFAULT_QUEUE_FILE,
  DEFAULT_HISTORY_FILE,
  DEFAULT_MAX_LENGTH,
  DEFAULT_MIN_POST_INTERVAL_MS,
  cleanText,
  normalizeTicker,
  messageHash,
  buildMessage,
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
