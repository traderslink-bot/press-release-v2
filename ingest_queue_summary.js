const { getIngestQueueStatus } = require("./lib/ingestStore");

function parseArgs(argv) {
  const options = {
    limit: 5,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--limit" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = parsed;
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

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "N/A";
  if (ageMs < 1000) return `${ageMs}ms`;

  const totalSeconds = Math.floor(ageMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatQueueRow(row, mode) {
  const when = mode === "retry" ? row.retryAfterAt : row.updatedAt;
  const meta = mode === "retry"
    ? `retryCount=${row.deferredRetryCount}`
    : `attempts=${row.processingAttempts}`;

  return `${row.ticker} | ${meta} | ${when || "N/A"} | ${row.processingError || "N/A"}`;
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const status = getIngestQueueStatus(options.limit);

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(`Ingest DB: ${status.ingestDatabasePath}`);
  console.log(`Generated: ${status.generatedAt}`);
  console.log(
    `Counts: observed=${status.counts.observed} processing=${status.counts.processing} retry_wait=${status.counts.retryWait} failed=${status.counts.failed} processed=${status.counts.processed}`
  );
  console.log(
    `Attempts: max=${status.processingAttemptStats.max} avg=${status.processingAttemptStats.average ?? "N/A"}`
  );
  console.log(`Next retry due in: ${formatAge(status.nextRetryDelayMs)}`);

  if (status.oldestObserved) {
    console.log(
      `Oldest observed: ${status.oldestObserved.ticker} | ${status.oldestObserved.observedAt} | age=${formatAge(status.oldestObserved.ageMs)}`
    );
  } else {
    console.log("Oldest observed: none");
  }

  if (status.oldestProcessing) {
    console.log(
      `Oldest processing: ${status.oldestProcessing.ticker} | ${status.oldestProcessing.processingStartedAt} | age=${formatAge(status.oldestProcessing.ageMs)} | attempts=${status.oldestProcessing.processingAttempts}`
    );
  } else {
    console.log("Oldest processing: none");
  }

  console.log("");
  console.log("Retry-wait sample");
  if (!status.retrying.length) {
    console.log("none");
  } else {
    for (const row of status.retrying) {
      console.log(formatQueueRow(row, "retry"));
    }
  }

  console.log("");
  console.log("Recent failed sample");
  if (!status.failed.length) {
    console.log("none");
  } else {
    for (const row of status.failed) {
      console.log(formatQueueRow(row, "failed"));
    }
  }
}

run();
