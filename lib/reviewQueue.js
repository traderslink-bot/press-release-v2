const fs = require("fs");
const path = require("path");

const REVIEW_QUEUE_FILE = path.join(
  __dirname,
  "..",
  "docs",
  "live_fetch_tracking",
  "review_queue.jsonl"
);

function appendReviewQueueEntry(entry) {
  fs.mkdirSync(path.dirname(REVIEW_QUEUE_FILE), { recursive: true });
  fs.appendFileSync(
    REVIEW_QUEUE_FILE,
    `${JSON.stringify({ queuedAt: new Date().toISOString(), ...entry })}\n`,
    "utf8"
  );
}

function getReviewQueueSummary() {
  if (!fs.existsSync(REVIEW_QUEUE_FILE)) {
    return {
      exists: false,
      count: 0,
      latestQueuedAt: null
    };
  }

  const lines = fs
    .readFileSync(REVIEW_QUEUE_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);

  let latestQueuedAt = null;
  if (lines.length) {
    try {
      const last = JSON.parse(lines[lines.length - 1]);
      latestQueuedAt = last?.queuedAt || null;
    } catch (_) {
      latestQueuedAt = null;
    }
  }

  return {
    exists: true,
    count: lines.length,
    latestQueuedAt
  };
}

module.exports = {
  REVIEW_QUEUE_FILE,
  appendReviewQueueEntry,
  getReviewQueueSummary
};
