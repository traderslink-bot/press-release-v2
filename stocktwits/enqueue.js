const fs = require("fs");
const path = require("path");
const {
  cleanText,
  normalizeTicker,
  buildMessage,
  loadQueue,
  saveQueue,
  resolveQueueFile,
  withQueueLock
} = require("./queue");

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = "true";
    }
  }
  return args;
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  return fs.readFileSync(0, "utf8");
}

function parseInput(args) {
  const stdin = readStdin().trim();
  if (stdin) return JSON.parse(stdin);
  if (args.json) return JSON.parse(args.json);
  return {
    id: args.id,
    ticker: args.ticker,
    title: args.title || args.headline,
    summary: args.summary,
    message: args.message,
    sentiment: args.sentiment,
    scheduledAt: args.scheduledAt,
    source: args.source
  };
}

function addDelay(date, delayMs) {
  return new Date(date.getTime() + delayMs).toISOString();
}

function main() {
  const args = parseArgs(process.argv);
  const input = parseInput(args);
  const ticker = normalizeTicker(input.ticker);
  const id = cleanText(input.id || `${ticker}-${Date.now()}`);
  const delayMs = Number(args.delayMs || process.env.STOCKTWITS_ENQUEUE_DELAY_MS || 3 * 60 * 1000);
  const scheduledAt = cleanText(input.scheduledAt || "") || addDelay(new Date(), Number.isFinite(delayMs) ? delayMs : 180000);

  const post = {
    id,
    ticker,
    title: cleanText(input.title || input.headline || ""),
    summary: cleanText(input.summary || ""),
    message: String(input.message || "").trim(),
    sentiment: cleanText(input.sentiment || ""),
    scheduledAt,
    status: "pending",
    postedAt: "",
    error: "",
    source: cleanText(input.source || "manual")
  };

  post.message = buildMessage(post);

  if (!post.ticker) throw new Error("ticker is required");
  if (!post.message) throw new Error("message, title, or summary is required");

  const queueFile = resolveQueueFile();
  withQueueLock(queueFile, () => {
    const rows = loadQueue(queueFile);
    const existingIndex = rows.findIndex(row => cleanText(row?.id || "") === id);
    if (existingIndex >= 0) {
      rows[existingIndex] = { ...rows[existingIndex], ...post };
    } else {
      rows.push(post);
    }
    saveQueue(rows, queueFile);
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    queueFile: path.relative(process.cwd(), queueFile),
    id: post.id,
    ticker: post.ticker,
    scheduledAt: post.scheduledAt,
    messageLength: post.message.length
  }, null, 2)}\n`);
}

main();
