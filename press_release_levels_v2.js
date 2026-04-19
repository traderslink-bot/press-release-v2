// 2026-04-18
// press_release_levels_v2.js
// Discord SEC + PR scraper -> OpenAI -> Discord
// Appends levels output from levels_clean_output.py inside the Discord embed

const { REPLAY_FILE } = require("./lib/config");
const { processMessage } = require("./lib/pipeline");
const { runReplayMode } = require("./lib/replay");
const { runLiveDiscordBot } = require("./lib/liveBot");

const processingQueue = [];
let isProcessingQueue = false;

function enqueueMessage(data) {
  processingQueue.push(data);
  void processQueue();
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (processingQueue.length) {
    const data = processingQueue.shift();
    try {
      await processMessage(data);
    } catch (err) {
      console.error("[ERROR] Queue item failed", err);
    }
  }

  isProcessingQueue = false;
}

(async () => {
  if (REPLAY_FILE) {
    await runReplayMode(processMessage);
    return;
  }

  await runLiveDiscordBot(enqueueMessage);
})().catch(err => {
  console.error("[FATAL] Bot crashed", err);
  process.exit(1);
});
