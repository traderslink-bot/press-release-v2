const fs = require("fs");

const { REVIEW_QUEUE_FILE } = require("./lib/reviewQueue");
const { cleanText } = require("./lib/utils");

function parseArgs(argv) {
  const options = {
    last: 100,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--last" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.last = parsed;
      }
      i += 1;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

function loadEntries() {
  if (!fs.existsSync(REVIEW_QUEUE_FILE)) {
    return [];
  }

  return fs
    .readFileSync(REVIEW_QUEUE_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.queuedAt || "").localeCompare(String(left.queuedAt || "")));
}

function bump(map, key) {
  const normalized = cleanText(key || "");
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) || 0) + 1);
}

function topEntries(map, limit = 10) {
  return Array.from(map.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function formatBucket(title, items) {
  const lines = [title];
  if (!items.length) {
    lines.push("none");
    return lines.join("\n");
  }

  for (const item of items) {
    lines.push(`${item.count}x  ${item.label}`);
  }
  return lines.join("\n");
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const entries = loadEntries().slice(0, options.last);

  const byReviewReason = new Map();
  const byReasonCode = new Map();
  const byTicker = new Map();
  const bySelectedDoc = new Map();
  const byWrapperRisk = new Map();
  const bySignalQuality = new Map();
  const byDuplicateFlag = new Map();
  let totalQueueDelayMs = 0;
  let totalProcessingMs = 0;
  let queueDelayCount = 0;
  let processingCount = 0;

  for (const entry of entries) {
    bump(byTicker, cleanText(entry.ticker || "UNKNOWN").toUpperCase());
    bump(
      bySelectedDoc,
      `${cleanText(entry.selectedDocumentKind || "N/A")} / ${cleanText(entry.selectedDocumentType || "N/A")}`
    );
    bump(byWrapperRisk, cleanText(entry.wrapperRiskLevel || "N/A"));
    bump(bySignalQuality, cleanText(entry.signalQuality || "N/A"));
    bump(byDuplicateFlag, entry?.duplicateDiagnostics?.isRecentDuplicate ? "recent_duplicate" : "not_duplicate");

    if (Number.isFinite(entry?.latencyMetrics?.queueDelayMs)) {
      totalQueueDelayMs += entry.latencyMetrics.queueDelayMs;
      queueDelayCount += 1;
    }
    if (Number.isFinite(entry?.latencyMetrics?.totalProcessingMs)) {
      totalProcessingMs += entry.latencyMetrics.totalProcessingMs;
      processingCount += 1;
    }

    const reviewReasons = Array.isArray(entry.reviewReasons) ? entry.reviewReasons : [];
    for (const reason of reviewReasons) {
      bump(byReviewReason, reason);
    }

    const reasonCodes = Array.isArray(entry.reasonCodes) ? entry.reasonCodes : [];
    for (const code of reasonCodes) {
      bump(byReasonCode, code);
    }
  }

  const payload = {
    reviewQueueFile: REVIEW_QUEUE_FILE,
    entriesAnalyzed: entries.length,
    newestQueuedAt: entries[0]?.queuedAt || null,
    oldestQueuedAt: entries[entries.length - 1]?.queuedAt || null,
    topReviewReasons: topEntries(byReviewReason),
    topReasonCodes: topEntries(byReasonCode),
    topTickers: topEntries(byTicker),
    topSelectedDocuments: topEntries(bySelectedDoc),
    wrapperRiskBreakdown: topEntries(byWrapperRisk),
    signalQualityBreakdown: topEntries(bySignalQuality),
    duplicateBreakdown: topEntries(byDuplicateFlag),
    averageQueueDelayMs: queueDelayCount ? Math.round(totalQueueDelayMs / queueDelayCount) : null,
    averageTotalProcessingMs: processingCount ? Math.round(totalProcessingMs / processingCount) : null
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Review queue file: ${REVIEW_QUEUE_FILE}`);
  console.log(`Entries analyzed: ${payload.entriesAnalyzed}`);
  if (!entries.length) {
    console.log("No review-queue entries available.");
    return;
  }

  console.log(`Newest queued: ${payload.newestQueuedAt}`);
  console.log(`Oldest queued: ${payload.oldestQueuedAt}`);
  console.log(`Average queue delay: ${payload.averageQueueDelayMs ?? "N/A"}ms`);
  console.log(`Average total processing: ${payload.averageTotalProcessingMs ?? "N/A"}ms`);
  console.log("");
  console.log(formatBucket("Top review reasons", payload.topReviewReasons));
  console.log("");
  console.log(formatBucket("Top reason codes", payload.topReasonCodes));
  console.log("");
  console.log(formatBucket("Top tickers", payload.topTickers));
  console.log("");
  console.log(formatBucket("Top selected documents", payload.topSelectedDocuments));
  console.log("");
  console.log(formatBucket("Wrapper risk breakdown", payload.wrapperRiskBreakdown));
  console.log("");
  console.log(formatBucket("Signal quality breakdown", payload.signalQualityBreakdown));
  console.log("");
  console.log(formatBucket("Duplicate breakdown", payload.duplicateBreakdown));
}

run();
