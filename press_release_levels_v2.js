// 2026-04-18
// press_release_levels_v2.js
// Discord SEC + PR scraper -> OpenAI -> Discord
// Appends levels output from levels_clean_output.py inside the Discord embed

const {
  REPLAY_FILE,
  MARKET_CAP_HOST_CHANNEL_URL,
  MARKET_CAP_UNDER_30M_WEBHOOK_URL,
  MARKET_CAP_30M_TO_50M_WEBHOOK_URL,
  MARKET_CAP_50M_TO_100M_WEBHOOK_URL
} = require("./lib/config");
const {
  INGEST_DATABASE_PATH,
  claimNextQueuedEvent,
  recoverInterruptedQueuedEvents,
  recordFailedEvent,
  recordObservedEvent,
  recordProcessedEvent,
  scheduleQueuedRetry,
  getNextRetryDelayMs
} = require("./lib/ingestStore");
const { processMessage } = require("./lib/pipeline");
const { runReplayMode } = require("./lib/replay");
const { REVIEW_QUEUE_FILE, getReviewQueueSummary } = require("./lib/reviewQueue");
const { runLiveDiscordBot, runMarketCapDiscordBot } = require("./lib/liveBot");
const { startFreeNewsBotGateway } = require("./lib/discordFreeNewsBotGateway");
const { updateWatcherHealth, getRuntimeHealthSnapshot } = require("./lib/runtimeHealth");

let isProcessingQueue = false;
let shouldRerunProcessQueue = false;
let retryWakeTimeout = null;
const DEFERRED_OPENAI_RETRY_DELAY_MS = 60000;
const MAX_DEFERRED_OPENAI_RETRIES = 1;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForWatcherReady(name) {
  while (true) {
    const watcher = getRuntimeHealthSnapshot().watchers?.[name];
    if (watcher?.enabled === false || watcher?.status === "disabled") return;
    if (watcher?.status === "live" && watcher?.pageHealthy === true) return;
    await sleep(1000);
  }
}

function watcherNameForMessage(data = {}) {
  const routeTag = String(data?.routeTag || "").toLowerCase();
  const feedType = String(data?.feedType || "").toLowerCase();
  if (feedType === "market_cap" || routeTag.startsWith("market_cap_")) {
    return "market_cap";
  }
  return "press_release";
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
  if (
    !data?.id ||
    !isRetryableOpenAIError(error) ||
    retryCount >= MAX_DEFERRED_OPENAI_RETRIES
  ) {
    return false;
  }

  const nextRetryCount = retryCount + 1;

  console.warn(
    `[RETRY] Requeueing ${data?.ticker || "UNKNOWN"} in ${DEFERRED_OPENAI_RETRY_DELAY_MS}ms ` +
      `(deferred retry ${nextRetryCount}/${MAX_DEFERRED_OPENAI_RETRIES})`
  );

  scheduleQueuedRetry(data.id, error, nextRetryCount, DEFERRED_OPENAI_RETRY_DELAY_MS);
  scheduleRetryWakeupIfNeeded();

  return true;
}

function clearRetryWakeTimeout() {
  if (retryWakeTimeout) {
    clearTimeout(retryWakeTimeout);
    retryWakeTimeout = null;
  }
}

function requestQueueRun() {
  if (isProcessingQueue) {
    shouldRerunProcessQueue = true;
    return;
  }

  void processQueue();
}

function scheduleRetryWakeupIfNeeded() {
  clearRetryWakeTimeout();

  const delayMs = getNextRetryDelayMs();
  if (delayMs === null) {
    return;
  }

  retryWakeTimeout = setTimeout(() => {
    retryWakeTimeout = null;
    requestQueueRun();
  }, delayMs);
}

function enqueueMessage(data) {
  if (!data.observedAt) {
    data.observedAt = new Date();
  }
  recordObservedEvent(data);
  updateWatcherHealth(watcherNameForMessage(data), {
    lastEnqueuedAt: new Date().toISOString(),
    lastEnqueuedId: String(data?.id || "").slice(0, 120),
    lastEnqueuedTicker: String(data?.ticker || "").slice(0, 16)
  });
  requestQueueRun();
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  shouldRerunProcessQueue = false;
  clearRetryWakeTimeout();

  while (true) {
    const data = claimNextQueuedEvent();
    if (!data) {
      break;
    }

    const watcherName = watcherNameForMessage(data);
    updateWatcherHealth(watcherName, {
      pipelineStatus: "processing",
      lastProcessingStartedAt: new Date().toISOString(),
      lastProcessingId: String(data?.id || "").slice(0, 120),
      lastProcessingTicker: String(data?.ticker || "").slice(0, 16)
    });

    try {
      const result = await processMessage(data);
      recordProcessedEvent(result);
      const postedCount = Array.isArray(result?.postedMessages) ? result.postedMessages.length : 0;
      const healthPatch = {
        pipelineStatus: "idle",
        lastProcessedAt: new Date().toISOString(),
        lastProcessedId: String(data?.id || "").slice(0, 120),
        lastProcessedTicker: String(data?.ticker || "").slice(0, 16),
        lastOutcome: postedCount > 0 ? "posted" : "processed_not_posted",
        lastProcessingErrorAt: null,
        lastProcessingError: null
      };
      if (postedCount > 0) {
        healthPatch.lastPostedAt = new Date().toISOString();
      }
      updateWatcherHealth(watcherName, healthPatch);
    } catch (err) {
      const retryScheduled = scheduleDeferredRetry(data, err);
      if (!retryScheduled && data?.id) {
        recordFailedEvent(data.id, err);
      }
      updateWatcherHealth(watcherName, {
        pipelineStatus: retryScheduled ? "retry_scheduled" : "error",
        lastProcessingErrorAt: new Date().toISOString(),
        lastProcessingError: String(err?.message || err || "").replace(/\s+/g, " ").slice(0, 500)
      }, { immediate: true });
      console.error("[ERROR] Queue item failed", err);
    }
  }

  isProcessingQueue = false;

  if (shouldRerunProcessQueue) {
    shouldRerunProcessQueue = false;
    void processQueue();
    return;
  }

  scheduleRetryWakeupIfNeeded();
}

async function runSupervisedLiveBot(options = {}) {
  let restartAttempt = 0;

  while (true) {
    try {
      await runLiveDiscordBot(enqueueMessage, options);
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

async function runSupervisedMarketCapBot(options = {}) {
  if (
    !MARKET_CAP_HOST_CHANNEL_URL ||
    (
      !MARKET_CAP_UNDER_30M_WEBHOOK_URL &&
      !MARKET_CAP_30M_TO_50M_WEBHOOK_URL &&
      !MARKET_CAP_50M_TO_100M_WEBHOOK_URL
    )
  ) {
    console.log("[MCBOT] Market-cap host watcher disabled; set MARKET_CAP_HOST_CHANNEL_URL and at least one market-cap destination webhook to enable it.");
    updateWatcherHealth("market_cap", {
      enabled: false,
      status: "disabled",
      pageHealthy: true,
      disabledAt: new Date().toISOString()
    }, { immediate: true });
    return;
  }

  let restartAttempt = 0;

  while (true) {
    try {
      await runMarketCapDiscordBot(enqueueMessage, options);
      restartAttempt = 0;
      console.warn("[MCBOT][SUPERVISOR] Market-cap bot exited unexpectedly. Restarting in 5000ms.");
      await sleep(5000);
    } catch (err) {
      restartAttempt += 1;
      const delayMs = Math.min(30000, 5000 * restartAttempt);
      console.error("[MCBOT][FATAL] Market-cap bot crashed", err);
      console.warn(`[MCBOT][SUPERVISOR] Restarting market-cap bot in ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }
}

async function startPressReleaseLevelsV2(options = {}) {
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

  const recoveredCount = recoverInterruptedQueuedEvents();
  if (recoveredCount > 0) {
    console.warn(`[QUEUE] Recovered ${recoveredCount} interrupted queued event(s) from the previous run.`);
  }

  requestQueueRun();
  startFreeNewsBotGateway();

  const pressReleaseWatcher = runSupervisedLiveBot(options);
  await waitForWatcherReady("press_release");
  console.log("[STARTUP] Press-release watcher is attached; starting market-cap watcher.");
  const marketCapWatcher = runSupervisedMarketCapBot(options);

  await Promise.all([pressReleaseWatcher, marketCapWatcher]);
}

if (require.main === module) {
  startPressReleaseLevelsV2().catch(err => {
    console.error("[FATAL] Bot crashed", err);
    process.exit(1);
  });
}

module.exports = {
  startPressReleaseLevelsV2,
  enqueueMessage,
  requestQueueRun,
  processQueue
};
