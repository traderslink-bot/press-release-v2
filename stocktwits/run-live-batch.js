const {
  DEFAULT_HISTORY_FILE,
  DEFAULT_MAX_LENGTH,
  DEFAULT_MIN_POST_INTERVAL_MS,
  cleanText,
  loadQueue,
  readHistory,
  resolveQueueFile,
  selectNextDuePost
} = require("./queue");
const { openBrowser, run } = require("./automator");

const DEFAULT_SOURCE_FILTER = `press_release_v2_backfill_${new Date().toISOString().slice(0, 10)}`;

function parseArgs(argv) {
  const args = {
    confirmBatch: false,
    source: process.env.STOCKTWITS_SOURCE_FILTER || DEFAULT_SOURCE_FILTER,
    maxPosts: Number(process.env.STOCKTWITS_BATCH_MAX_POSTS || 10)
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm-batch") {
      args.confirmBatch = true;
    } else if (arg === "--source") {
      args.source = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--max") {
      args.maxPosts = Number(argv[index + 1] || "");
      index += 1;
    }
  }

  args.source = cleanText(args.source);
  if (!Number.isFinite(args.maxPosts) || args.maxPosts < 1) args.maxPosts = 10;
  args.maxPosts = Math.min(Math.floor(args.maxPosts), 25);
  return args;
}

function maxLength() {
  const value = Number(process.env.STOCKTWITS_MAX_LENGTH || DEFAULT_MAX_LENGTH);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_LENGTH;
}

function minPostIntervalMs() {
  const value = Number(process.env.STOCKTWITS_MIN_POST_INTERVAL_MS || DEFAULT_MIN_POST_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_POST_INTERVAL_MS;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resetPage(browser) {
  const oldPage = browser.page;
  const nextPage = await browser.context.newPage();
  browser.page = nextPage;
  await nextPage.bringToFront().catch(() => null);
  await oldPage.close().catch(() => null);
}

function getSelection(sourceFilter) {
  const queueFile = resolveQueueFile();
  const rows = loadQueue(queueFile);
  const history = readHistory(DEFAULT_HISTORY_FILE);
  return {
    queueFile,
    rows,
    selection: selectNextDuePost(rows, history, new Date(), {
      maxLength: maxLength(),
      minPostIntervalMs: minPostIntervalMs(),
      sourceFilter
    })
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.confirmBatch) {
    throw new Error("Batch posting requires --confirm-batch.");
  }
  if (!args.source) {
    throw new Error("Batch posting requires a source filter.");
  }

  process.env.STOCKTWITS_SOURCE_FILTER = args.source;

  let posted = 0;
  const browser = await openBrowser();
  try {
    while (posted < args.maxPosts) {
      const { queueFile, selection } = getSelection(args.source);
      if (!selection.post) {
        if (selection.cooldown?.active) {
          const waitMs = Math.min(selection.cooldown.remainingMs + 3000, 10 * 60 * 1000);
          console.log(`[INFO] Cooldown active for ${Math.ceil(selection.cooldown.remainingMs / 1000)}s; waiting before next batch item.`);
          await sleep(waitMs);
          continue;
        }

        console.log(`[INFO] No pending due Stocktwits posts for source ${args.source}.`);
        console.log(`[INFO] Queue file: ${queueFile}`);
        break;
      }

      console.log(`[INFO] Batch dry-run ${posted + 1}/${args.maxPosts}: $${selection.validation.ticker} (${selection.validation.id})`);
      const dryRunCode = await run("dry-run", { confirmPost: false, keepOpen: false, noDryRunGate: false }, { browser });
      if (dryRunCode !== 0) {
        throw new Error(`Dry-run failed for $${selection.validation.ticker}; stopping batch.`);
      }
      await resetPage(browser);

      console.log(`[INFO] Batch live post ${posted + 1}/${args.maxPosts}: $${selection.validation.ticker} (${selection.validation.id})`);
      const postCode = await run("post-next", { confirmPost: true, keepOpen: false, noDryRunGate: false }, { browser });
      if (postCode !== 0) {
        throw new Error(`Live post failed for $${selection.validation.ticker}; stopping batch.`);
      }
      await resetPage(browser);

      posted += 1;
    }
  } finally {
    await browser.close();
  }

  console.log(`[INFO] Batch complete. Posted ${posted} item(s) for source ${args.source}.`);
}

main().catch(err => {
  console.error(`[ERROR] ${err.message}`);
  process.exitCode = 1;
});
