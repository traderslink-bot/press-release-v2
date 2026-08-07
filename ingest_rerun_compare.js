const { getIngestEventLatestRerunComparison } = require("./lib/ingestStore");

function parseArgs(argv) {
  const options = {
    id: null,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--id" && next) {
      options.id = String(next || "").trim();
      i += 1;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

function formatLatency(latencyMetrics) {
  if (!latencyMetrics || typeof latencyMetrics !== "object") {
    return "N/A";
  }

  const total = latencyMetrics.totalProcessingMs ?? "N/A";
  const queue = latencyMetrics.queueDelayMs ?? "N/A";
  const ai = latencyMetrics.aiMs ?? "N/A";
  return `total=${total}ms queue=${queue}ms ai=${ai}ms`;
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") {
    return "N/A";
  }

  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "none";
  }

  return String(value);
}

function buildDiffRows(comparison) {
  const current = comparison.current || {};
  const latest = comparison.latestRerun || {};
  const fields = [
    ["articleSourceMode", "Article Source"],
    ["eventType", "Event Type"],
    ["filingType", "Filing Type"],
    ["confidence", "Confidence"],
    ["canDiluteToday", "Can Dilute"],
    ["earliestDilution", "Earliest Dilution"],
    ["headline", "Headline"],
    ["summary", "Summary"],
    ["reasonCodes", "Reason Codes"]
  ];

  return fields.map(([key, label]) => ({
    label,
    current: current[key],
    latest: latest[key],
    changed: JSON.stringify(current[key] ?? null) !== JSON.stringify(latest[key] ?? null)
  }));
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.id) {
    throw new Error("Missing required --id argument.");
  }

  const comparison = getIngestEventLatestRerunComparison(options.id);
  if (!comparison) {
    throw new Error(`Ingest event not found: ${options.id}`);
  }

  if (options.json) {
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }

  console.log(`Ingest event: ${comparison.ingestEventId}`);
  if (!comparison.latestRerun) {
    console.log("No rerun audit entry found for this event.");
    return;
  }

  console.log(`Latest rerun: ${comparison.latestRerun.auditId} | ${comparison.latestRerun.executedAt} | ${comparison.latestRerun.outcomeStatus}`);
  console.log(`Current latency: ${formatLatency(comparison.current.latencyMetrics)}`);
  console.log(`Latest rerun latency: ${formatLatency(comparison.latestRerun.latencyMetrics)}`);
  console.log(`Current posted messages: ${Array.isArray(comparison.current.postedMessages) ? comparison.current.postedMessages.length : 0}`);
  console.log(`Latest rerun posted messages: ${Array.isArray(comparison.latestRerun.postedMessages) ? comparison.latestRerun.postedMessages.length : 0}`);
  console.log("");

  for (const row of buildDiffRows(comparison)) {
    console.log(`${row.label}${row.changed ? " *" : ""}`);
    console.log(`current: ${formatValue(row.current)}`);
    console.log(`latest:  ${formatValue(row.latest)}`);
    console.log("");
  }
}

run();
