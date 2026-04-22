// 2026-04-18
// press_release_levels_v2.js
// Discord SEC + PR scraper -> OpenAI -> Discord
// Appends levels output from levels_clean_output.py inside the Discord embed

const { REPLAY_FILE } = require("./lib/config");
const {
  INGEST_DATABASE_PATH,
  recordFailedEvent,
  recordObservedEvent,
  recordProcessedEvent
} = require("./lib/ingestStore");
const { processMessage } = require("./lib/pipeline");
const { runReplayMode } = require("./lib/replay");
const { REVIEW_QUEUE_FILE, getReviewQueueSummary } = require("./lib/reviewQueue");
const { runLiveDiscordBot } = require("./lib/liveBot");

const processingQueue = [];
let isProcessingQueue = false;
const DEFERRED_OPENAI_RETRY_DELAY_MS = 60000;
const MAX_DEFERRED_OPENAI_RETRIES = 1;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableOpenAIError(error) {
  const message = String(error?.message || error || "");
  return (
    /OpenAI failed after/i.test(message) ||
    /OpenAI URL fallback failed after/i.test(message) ||
    /operation was aborted/i.test(message)
  );
}

function scheduleDeferredRetry(data, error) {
  const retryCount = Number(data?.deferredRetryCount || 0);
  if (!isRetryableOpenAIError(error) || retryCount >= MAX_DEFERRED_OPENAI_RETRIES) {
    return false;
  }

  const nextData = {
    ...data,
    deferredRetryCount: retryCount + 1
  };

  console.warn(
    `[RETRY] Requeueing ${data?.ticker || "UNKNOWN"} in ${DEFERRED_OPENAI_RETRY_DELAY_MS}ms ` +
      `(deferred retry ${nextData.deferredRetryCount}/${MAX_DEFERRED_OPENAI_RETRIES})`
  );

  setTimeout(() => {
    processingQueue.push(nextData);
    void processQueue();
  }, DEFERRED_OPENAI_RETRY_DELAY_MS);

  return true;
}

function enqueueMessage(data) {
  if (!data.observedAt) {
    data.observedAt = new Date();
  }
  recordObservedEvent(data);
  processingQueue.push(data);
  void processQueue();
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (processingQueue.length) {
    const data = processingQueue.shift();
    try {
      const result = await processMessage(data);
      recordProcessedEvent(result);
    } catch (err) {
      if (data?.id) {
        recordFailedEvent(data.id, err);
      }
      console.error("[ERROR] Queue item failed", err);
      scheduleDeferredRetry(data, err);
    }
  }

  isProcessingQueue = false;
}

async function runSupervisedLiveBot() {
  let restartAttempt = 0;

  while (true) {
    try {
      await runLiveDiscordBot(enqueueMessage);
      restartAttempt = 0;
      console.warn("[SUPERVISOR] Live bot exited unexpectedly. Restarting in 5000ms.");
      await sleep(5000);
    } catch (err) {
      restartAttempt += 1;
      const delayMs = Math.min(30000, 5000 * restartAttempt);
      console.error("[FATAL] Live bot crashed", err);
      console.warn(`[SUPERVISOR] Restarting live bot in ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }
}

(async () => {
  console.log(`[DB] Using ingest database: ${INGEST_DATABASE_PATH}`);
  const reviewQueueSummary = getReviewQueueSummary();
  if (reviewQueueSummary.count > 0) {
    console.log(
      `[REVIEW] ${reviewQueueSummary.count} queued case(s) waiting in ${REVIEW_QUEUE_FILE}`
    );
    if (reviewQueueSummary.latestQueuedAt) {
      console.log(`[REVIEW] Latest queued case at ${reviewQueueSummary.latestQueuedAt}`);
    }
  }
  if (REPLAY_FILE) {
    await runReplayMode(processMessage);
    return;
  }

  await runSupervisedLiveBot();
})().catch(err => {
  console.error("[FATAL] Bot crashed", err);
  process.exit(1);
});
