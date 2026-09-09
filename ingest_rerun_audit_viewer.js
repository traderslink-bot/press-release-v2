const { getRecentIngestRerunAuditEntries } = require("./lib/ingestStore");

function parseArgs(argv) {
  const options = {
    id: null,
    last: 20,
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

function formatLatency(latencyMetrics) {
  if (!latencyMetrics || typeof latencyMetrics !== "object") {
    return "N/A";
  }

  const total = latencyMetrics.totalProcessingMs ?? "N/A";
  const queue = latencyMetrics.queueDelayMs ?? "N/A";
  const ai = latencyMetrics.aiMs ?? "N/A";
  return `total=${total}ms queue=${queue}ms ai=${ai}ms`;
}

function formatEntry(entry) {
  return [
    `${entry.executedAt} | ${entry.ingestEventId} | ${entry.outcomeStatus}`,
    `mode=${entry.mode} dbUpdated=${entry.dbUpdated} postEnabled=${entry.postEnabled} preserveObservedAt=${entry.preserveObservedAt}`,
    `prior=${entry.priorProcessStatus || "N/A"} result=${entry.resultEventType || "N/A"} / ${entry.resultFilingType || "N/A"} / ${entry.resultArticleSourceMode || "N/A"}`,
    `confidence=${entry.resultConfidence ?? "N/A"} latency=${formatLatency(entry.latencyMetrics)}`,
    `reasonCodes=${entry.reasonCodes.join(", ") || "none"}`,
    `reviewReasons=${entry.reviewReasons.join(", ") || "none"}`,
    `postedMessages=${Array.isArray(entry.postedMessages) ? entry.postedMessages.length : 0}`,
    `error=${entry.outcomeError || "none"}`
  ].join("\n");
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const entries = getRecentIngestRerunAuditEntries({
    ingestEventId: options.id,
    limit: options.last
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          count: entries.length,
          entries
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Showing ${entries.length} rerun audit entr${entries.length === 1 ? "y" : "ies"}`);
  if (!entries.length) {
    console.log("No rerun audit entries found.");
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
