const {
  INGEST_DATABASE_PATH,
  findRequeueCandidates,
  requeueIngestEvents
} = require("./lib/ingestStore");

function parseArgs(argv) {
  const options = {
    status: "failed",
    ticker: null,
    id: null,
    limit: 10,
    apply: false,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--status" && next) {
      options.status = String(next || "").trim().toLowerCase();
      i += 1;
      continue;
    }

    if (arg === "--ticker" && next) {
      options.ticker = String(next || "").trim().toUpperCase();
      i += 1;
      continue;
    }

    if (arg === "--id" && next) {
      options.id = String(next || "").trim();
      i += 1;
      continue;
    }

    if (arg === "--limit" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = parsed;
      }
      i += 1;
      continue;
    }

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

function formatCandidate(candidate) {
  return [
    `${candidate.ticker} | ${candidate.id}`,
    `status=${candidate.processStatus} attempts=${candidate.processingAttempts} deferredRetries=${candidate.deferredRetryCount}`,
    `observed=${candidate.observedAt || "N/A"} updated=${candidate.updatedAt || "N/A"} retryAfter=${candidate.retryAfterAt || "N/A"}`,
    `error=${candidate.processingError || "N/A"}`
  ].join("\n");
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const payload = options.apply
    ? requeueIngestEvents(options)
    : {
        matchedCount: 0,
        requeuedCount: 0,
        candidates: findRequeueCandidates(options)
      };

  const output = {
    ingestDatabasePath: INGEST_DATABASE_PATH,
    mode: options.apply ? "apply" : "dry_run",
    filters: {
      status: options.status,
      ticker: options.ticker,
      id: options.id,
      limit: options.limit
    },
    matchedCount: options.apply ? payload.matchedCount : payload.candidates.length,
    requeuedCount: options.apply ? payload.requeuedCount : 0,
    candidates: payload.candidates
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Ingest DB: ${output.ingestDatabasePath}`);
  console.log(`Mode: ${output.mode}`);
  console.log(
    `Filters: status=${output.filters.status} ticker=${output.filters.ticker || "N/A"} id=${output.filters.id || "N/A"} limit=${output.filters.limit}`
  );
  console.log(`Matched: ${output.matchedCount}`);
  if (options.apply) {
    console.log(`Requeued: ${output.requeuedCount}`);
  } else {
    console.log("Dry run only. Add --apply to actually move matched rows back to observed.");
  }

  if (!output.candidates.length) {
    console.log("No matching ingest events found.");
    return;
  }

  console.log("");
  for (const [index, candidate] of output.candidates.entries()) {
    if (index > 0) {
      console.log("\n---\n");
    }
    console.log(formatCandidate(candidate));
  }
}

run();
