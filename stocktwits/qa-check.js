const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");
const {
  DEFAULT_HISTORY_FILE,
  STOCKTWITS_DIR,
  buildMessage,
  loadQueue,
  readHistory,
  saveQueue,
  selectNextDuePost,
  withQueueLock
} = require("./queue");
const {
  buildStocktwitsMessage,
  enqueueStocktwitsDraft
} = require("./pipelineQueue");
const {
  scheduleStocktwitsOneShotWorkerForDraft
} = require("./workerLauncher");

const tempQueue = path.join(STOCKTWITS_DIR, "qa-temp-posts.json");
process.env.STOCKTWITS_QUEUE_FILE = tempQueue;
process.env.STOCKTWITS_MAX_LENGTH = "240";
process.env.STOCKTWITS_MIN_POST_INTERVAL_MS = "0";
process.env.STOCKTWITS_AUTOSTART_WORKER_ENABLED = "false";

function cleanup() {
  for (const file of [tempQueue, `${tempQueue}.lock`, `${tempQueue}.tmp`]) {
    fs.rmSync(file, { force: true });
  }
}

function main() {
  cleanup();
  saveQueue([], tempQueue);

  const message = buildStocktwitsMessage({
    ticker: "AAPL",
    title: "Apple announces a long headline ".repeat(8),
    summary: "Summary ".repeat(100)
  });
  assert(message.startsWith("$AAPL "), "message starts with cashtag");
  assert(message.length <= 240, "message respects configured max length");

  const first = enqueueStocktwitsDraft({
    id: "qa-1",
    ticker: "AAPL",
    title: "Apple test title",
    summary: "AI summary",
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    source: "press_release_v2"
  });
  assert.strictEqual(first.ok, true, "first enqueue succeeds");
  const disabledAutostart = scheduleStocktwitsOneShotWorkerForDraft(first);
  assert.strictEqual(disabledAutostart.skipped, true, "autostart can be disabled for QA");
  assert.strictEqual(disabledAutostart.reason, "autostart disabled", "autostart disabled reason is explicit");

  const duplicate = enqueueStocktwitsDraft({
    id: "qa-1",
    ticker: "AAPL",
    title: "Apple test title",
    summary: "AI summary",
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    source: "press_release_v2"
  });
  assert.strictEqual(duplicate.skipped, true, "duplicate enqueue is skipped");

  withQueueLock(tempQueue, () => {
    const rows = loadQueue(tempQueue);
    rows.push({
      id: "pr-v2-qa-skipped",
      ticker: "NVDA",
      message: "$NVDA Old skipped item",
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      status: "skipped",
      postedAt: "",
      error: "qa skipped row",
      source: "press_release_v2"
    });
    saveQueue(rows, tempQueue);
  });

  const replayedSkippedId = enqueueStocktwitsDraft({
    id: "qa-skipped",
    ticker: "NVDA",
    title: "A different title for the same source event",
    summary: "A different summary",
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    source: "press_release_v2"
  });
  assert.strictEqual(replayedSkippedId.skipped, true, "same source id is not requeued after a skipped row");

  withQueueLock(tempQueue, () => {
    const rows = loadQueue(tempQueue);
    rows.push({
      id: "manual-1",
      ticker: "MSFT",
      message: "$MSFT Manual item",
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      status: "pending",
      postedAt: "",
      error: "",
      source: "manual"
    });
    saveQueue(rows, tempQueue);
  });

  const rows = loadQueue(tempQueue);
  const liveSelection = selectNextDuePost(rows, readHistory(DEFAULT_HISTORY_FILE), new Date(), {
    maxLength: 240,
    minPostIntervalMs: 0,
    sourceFilter: "press_release_v2"
  });
  assert.strictEqual(liveSelection.validation.ticker, "AAPL", "source filter selects live item");

  const manualSelection = selectNextDuePost(rows, readHistory(DEFAULT_HISTORY_FILE), new Date(), {
    maxLength: 240,
    minPostIntervalMs: 0,
    sourceFilter: "manual"
  });
  assert.strictEqual(manualSelection.validation.ticker, "MSFT", "source filter selects manual item");

  const built = buildMessage({ ticker: "TSLA", title: "Title", summary: "Summary" });
  assert.strictEqual(built, "$TSLA Title\n\nSummary", "queue buildMessage fallback format");

  const statusCheck = spawnSync(process.execPath, [path.join(STOCKTWITS_DIR, "worker-status.js")], {
    encoding: "utf8"
  });
  assert([0, 2, 3].includes(statusCheck.status), "worker status exits with an expected operational code");
  assert.doesNotThrow(() => JSON.parse(statusCheck.stdout), "worker status prints JSON");

  cleanup();
  process.stdout.write("Stocktwits QA checks passed.\n");
}

try {
  main();
} catch (err) {
  cleanup();
  throw err;
}
