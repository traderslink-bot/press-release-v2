const Database = require("better-sqlite3");
const { INGEST_DATABASE_PATH } = require("../lib/ingestStore");
const { cleanText } = require("./queue");
const { enqueueStocktwitsDraft } = require("./pipelineQueue");

const DEFAULT_HOST_CHANNEL_ID = "1139240765260836936";

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

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function addMs(isoValue, ms) {
  const date = new Date(isoValue);
  if (!Number.isFinite(date.getTime())) return new Date().toISOString();
  return new Date(date.getTime() + ms).toISOString();
}

function randomIntInclusive(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function buildBackfillSchedule(rows, options) {
  const delayMs = options.delayMs;
  const startDelayMs = options.startDelayMs;
  const minGapMs = options.minGapMs;
  const maxGapMs = options.maxGapMs;
  const nowMs = Date.now();
  let cursorMs = nowMs + startDelayMs;

  return rows.map((row, index) => {
    const naturalDueMs = new Date(addMs(row.processed_at || row.observed_at, delayMs)).getTime();
    const scheduledMs = Math.max(
      Number.isFinite(naturalDueMs) ? naturalDueMs : 0,
      index === 0 ? cursorMs : cursorMs + randomIntInclusive(minGapMs, maxGapMs)
    );
    cursorMs = scheduledMs;
    return new Date(scheduledMs).toISOString();
  });
}

function isNormalPrNewsRow(row, hostChannelId) {
  const id = cleanText(row.id || "");
  const postedMessages = parseJsonArray(row.posted_messages_json);
  if (!id.startsWith(`chat-messages-${hostChannelId}-`)) return false;
  if (!postedMessages.length) return false;
  if (!cleanText(row.headline || "") || !cleanText(row.summary || "")) return false;
  return true;
}

function main() {
  const args = parseArgs(process.argv);
  const date = cleanText(args.date || new Date().toISOString().slice(0, 10));
  const fromTicker = cleanText(args.from || "").toUpperCase();
  const toTicker = cleanText(args.to || "").toUpperCase();
  const hostChannelId = cleanText(args.hostChannelId || DEFAULT_HOST_CHANNEL_ID);
  const delayMs = Number(args.delayMs || process.env.STOCKTWITS_QUEUE_DELAY_MS || 3 * 60 * 1000);
  const startDelayMs = Number(args.startDelayMs || 90 * 1000);
  const minGapMs = Number(args.minGapMs || process.env.STOCKTWITS_BACKFILL_MIN_GAP_MS || 90 * 1000);
  const maxGapMs = Number(args.maxGapMs || process.env.STOCKTWITS_BACKFILL_MAX_GAP_MS || 4 * 60 * 1000);
  const dryRun = args.dryRun === "true" || args["dry-run"] === "true";

  if (!fromTicker || !toTicker) {
    throw new Error("--from and --to tickers are required");
  }

  const db = new Database(INGEST_DATABASE_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT id, ticker, headline, summary, process_status, route_tag, posted_messages_json, observed_at, processed_at
    FROM ingest_events
    WHERE date(observed_at) = date(@date)
      AND process_status = 'processed'
    ORDER BY observed_at ASC
  `).all({ date });

  const startIndex = rows.findIndex(row => cleanText(row.ticker || "").toUpperCase() === fromTicker);
  const endIndex = rows.map(row => cleanText(row.ticker || "").toUpperCase()).lastIndexOf(toTicker);
  if (startIndex === -1) throw new Error(`Could not find from ticker ${fromTicker} on ${date}`);
  if (endIndex === -1) throw new Error(`Could not find to ticker ${toTicker} on ${date}`);
  if (endIndex < startIndex) throw new Error(`${toTicker} appears before ${fromTicker} on ${date}`);

  const candidates = rows
    .slice(startIndex, endIndex + 1)
    .filter(row => isNormalPrNewsRow(row, hostChannelId));
  const scheduledTimes = buildBackfillSchedule(candidates, {
    delayMs: Number.isFinite(delayMs) ? delayMs : 180000,
    startDelayMs: Number.isFinite(startDelayMs) ? startDelayMs : 90000,
    minGapMs: Number.isFinite(minGapMs) ? minGapMs : 90000,
    maxGapMs: Number.isFinite(maxGapMs) ? maxGapMs : 240000
  });

  const results = candidates.map((row, index) => {
    const scheduledAt = scheduledTimes[index];
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        id: `pr-v2-${row.id}`,
        ticker: cleanText(row.ticker || "").toUpperCase(),
        title: cleanText(row.headline || ""),
        scheduledAt
      };
    }

    return enqueueStocktwitsDraft({
      id: row.id,
      ticker: row.ticker,
      title: row.headline,
      summary: row.summary,
      source: `press_release_v2_backfill_${date}`,
      scheduledAt
    });
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    date,
    from: fromTicker,
    to: toTicker,
    scanned: endIndex - startIndex + 1,
    eligible: candidates.length,
    schedule: {
      startDelayMs: Number.isFinite(startDelayMs) ? startDelayMs : 90000,
      minGapMs: Number.isFinite(minGapMs) ? minGapMs : 90000,
      maxGapMs: Number.isFinite(maxGapMs) ? maxGapMs : 240000
    },
    dryRun,
    results
  }, null, 2)}\n`);
}

main();
