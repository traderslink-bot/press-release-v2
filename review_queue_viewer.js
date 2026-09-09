const fs = require("fs");
const path = require("path");

const { REVIEW_QUEUE_FILE } = require("./lib/reviewQueue");
const { cleanText } = require("./lib/utils");

function parseArgs(argv) {
  const options = {
    ticker: null,
    reason: null,
    route: null,
    last: 20,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--ticker" && next) {
      options.ticker = cleanText(next).toUpperCase();
      i += 1;
      continue;
    }
    if (arg === "--reason" && next) {
      options.reason = cleanText(next).toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--route" && next) {
      options.route = cleanText(next).toLowerCase();
      i += 1;
      continue;
    }
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
    .filter(Boolean);
}

function matchesFilters(entry, options) {
  if (options.ticker && cleanText(entry.ticker).toUpperCase() !== options.ticker) {
    return false;
  }

  if (options.route && cleanText(entry.routeTag).toLowerCase() !== options.route) {
    return false;
  }

  if (options.reason) {
    const reviewReasons = Array.isArray(entry.reviewReasons) ? entry.reviewReasons : [];
    const reasonCodes = Array.isArray(entry.reasonCodes) ? entry.reasonCodes : [];
    const haystack = reviewReasons.concat(reasonCodes).map(item => cleanText(item).toLowerCase());
    if (!haystack.some(item => item.includes(options.reason))) {
      return false;
    }
  }

  return true;
}

function formatEntry(entry) {
  const reviewReasons = Array.isArray(entry.reviewReasons) ? entry.reviewReasons.join(", ") : "none";
  const reasonCodes = Array.isArray(entry.reasonCodes) ? entry.reasonCodes.join(", ") : "none";
  const signalFlags = Array.isArray(entry.signalFlags) ? entry.signalFlags.join(", ") : "none";
  const queueDelayMs = entry?.latencyMetrics?.queueDelayMs ?? "N/A";
  const totalProcessingMs = entry?.latencyMetrics?.totalProcessingMs ?? "N/A";
  const recentDuplicateCount = entry?.duplicateDiagnostics?.recentDuplicateCount ?? 0;
  const lines = [
    `${cleanText(entry.queuedAt || "")} | ${cleanText(entry.ticker || "UNKNOWN")} | route=${cleanText(entry.routeTag || "default")}`,
    `headline: ${cleanText(entry.headline || "N/A")}`,
    `reasons: ${reviewReasons}`,
    `codes: ${reasonCodes}`,
    `selected: ${cleanText(entry.selectedDocumentKind || "N/A")} / ${cleanText(entry.selectedDocumentType || "N/A")}`,
    `wrapper risk: ${cleanText(entry.wrapperRiskLevel || "N/A")}`,
    `signal quality: ${cleanText(entry.signalQuality || "N/A")}`,
    `signal flags: ${signalFlags}`,
    `latency: total=${totalProcessingMs}ms queue=${queueDelayMs}ms`,
    `recent duplicates: ${recentDuplicateCount}`,
    `confidence: ${entry.confidence ?? "N/A"}`,
    `url: ${cleanText(entry.articleLink || "N/A")}`
  ];

  return lines.join("\n");
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const entries = loadEntries()
    .filter(entry => matchesFilters(entry, options))
    .sort((left, right) => String(right.queuedAt || "").localeCompare(String(left.queuedAt || "")))
    .slice(0, options.last);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          reviewQueueFile: REVIEW_QUEUE_FILE,
          count: entries.length,
          entries
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Review queue file: ${REVIEW_QUEUE_FILE}`);
  console.log(`Showing ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);

  if (!entries.length) {
    console.log("No matching review-queue entries found.");
    return;
  }

  console.log("");
  for (const [index, entry] of entries.entries()) {
    if (index > 0) {
      console.log("\n---\n");
    }
    console.log(formatEntry(entry));
  }
}

run();
