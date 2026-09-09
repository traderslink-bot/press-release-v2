function parseArgs(argv) {
  const options = {
    id: null,
    post: false,
    updateDb: false,
    preserveObservedAt: false,
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

    if (arg === "--post") {
      options.post = true;
      continue;
    }

    if (arg === "--update-db") {
      options.updateDb = true;
      continue;
    }

    if (arg === "--preserve-observed-at") {
      options.preserveObservedAt = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));

if (!options.id) {
  throw new Error("Missing required --id argument.");
}

if (!options.post) {
  process.env.REPLAY_SKIP_WEBHOOKS = "true";
}
process.env.ARTICLE_FETCH_LOG_ENABLED = "false";
process.env.REVIEW_QUEUE_APPEND_ENABLED = "false";

const { processMessage } = require("./lib/pipeline");
const {
  INGEST_DATABASE_PATH,
  buildPersistableProcessedResultSnapshot,
  getIngestEventById,
  recordIngestRerunAudit,
  recordProcessedEvent,
  recordFailedEvent
} = require("./lib/ingestStore");

function buildOutput(result, inputEvent, mode, dbUpdated) {
  const reviewReasons = Array.isArray(result?.reviewQueueDecision?.reviewReasons)
    ? result.reviewQueueDecision.reviewReasons
    : [];

  return {
    ingestDatabasePath: INGEST_DATABASE_PATH,
    mode,
    dbUpdated,
    input: {
      id: inputEvent.id,
      ticker: inputEvent.ticker,
      routeTag: inputEvent.routeTag,
      articleLink: inputEvent.articleLink,
      priorProcessStatus: inputEvent.processStatus,
      priorProcessingError: inputEvent.processingError,
      originalObservedAt: inputEvent.originalObservedAt,
      rerunObservedAt: inputEvent.observedAt
    },
    result: {
      articleSourceMode: result.articleSourceMode,
      eventType: result.eventType,
      filingType: result.filingType,
      confidence: result.confidence,
      isFallback: result.isFallback,
      canDiluteToday: result.canDiluteToday,
      earliestDilution: result.earliestDilution,
      reasonCodes: result.reasonCodes,
      reviewReasons,
      webhookTargets: result.webhookTargets,
      postedMessages: result.postedMessages,
      latencyMetrics: result.latencyMetrics,
      headline: result.headline,
      summary: result.summary
    }
  };
}

function buildAuditPayload({ result = null, error = null, inputEvent, mode, dbUpdated }) {
  const reviewReasons = Array.isArray(result?.reviewQueueDecision?.reviewReasons)
    ? result.reviewQueueDecision.reviewReasons
    : [];
  const reasonCodes = Array.isArray(result?.reasonCodes) ? result.reasonCodes : [];

  return {
    ingestEventId: inputEvent.id,
    mode,
    dbUpdated,
    preserveObservedAt: options.preserveObservedAt,
    postEnabled: options.post,
    priorProcessStatus: inputEvent.processStatus,
    priorProcessingError: inputEvent.processingError,
    originalObservedAt: inputEvent.originalObservedAt,
    rerunObservedAt: inputEvent.observedAt,
    outcomeStatus: error ? "failed" : "succeeded",
    outcomeError: error ? String(error?.message || error || "Unknown rerun error") : null,
    resultEventType: result?.eventType || null,
    resultFilingType: result?.filingType || null,
    resultArticleSourceMode: result?.articleSourceMode || null,
    resultConfidence: Number.isFinite(result?.confidence) ? result.confidence : null,
    reasonCodes,
    reviewReasons,
    latencyMetrics: result?.latencyMetrics || null,
    postedMessages: Array.isArray(result?.postedMessages) ? result.postedMessages : [],
    payload: error
      ? {
          input: {
            id: inputEvent.id,
            ticker: inputEvent.ticker,
            routeTag: inputEvent.routeTag
          },
          error: String(error?.message || error || "Unknown rerun error")
        }
      : {
          ...buildOutput(result, inputEvent, mode, dbUpdated),
          persistedResult: buildPersistableProcessedResultSnapshot(result)
        }
  };
}

async function run() {
  const sourceEvent = getIngestEventById(options.id);
  if (!sourceEvent) {
    throw new Error(`Ingest event not found: ${options.id}`);
  }

  const inputEvent = {
    ...sourceEvent,
    observedAt: options.preserveObservedAt
      ? sourceEvent.observedAt
      : new Date().toISOString()
  };

  try {
    const result = await processMessage(inputEvent);
    if (options.updateDb) {
      recordProcessedEvent(result);
    }

    const output = buildOutput(
      result,
      inputEvent,
      options.post ? "rerun_with_posting" : "rerun_no_post",
      options.updateDb
    );
    recordIngestRerunAudit(
      buildAuditPayload({
        result,
        inputEvent,
        mode: output.mode,
        dbUpdated: options.updateDb
      })
    );

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(`Ingest DB: ${output.ingestDatabasePath}`);
    console.log(`Mode: ${output.mode}`);
    console.log(`DB updated: ${output.dbUpdated ? "yes" : "no"}`);
    console.log(`Event: ${output.input.ticker} | ${output.input.id}`);
    console.log(`Prior status: ${output.input.priorProcessStatus || "N/A"}`);
    console.log(`Article source mode: ${output.result.articleSourceMode}`);
    console.log(`Event type: ${output.result.eventType}`);
    console.log(`Confidence: ${output.result.confidence}`);
    console.log(`Reason codes: ${(output.result.reasonCodes || []).join(", ") || "none"}`);
    console.log(`Review reasons: ${(output.result.reviewReasons || []).join(", ") || "none"}`);
    console.log(`Posted messages: ${(output.result.postedMessages || []).length}`);
    console.log(`Headline: ${output.result.headline || "N/A"}`);
    console.log(`Summary: ${output.result.summary || "N/A"}`);
  } catch (err) {
    if (options.updateDb) {
      recordFailedEvent(inputEvent.id, err);
    }

    recordIngestRerunAudit(
      buildAuditPayload({
        error: err,
        inputEvent,
        mode: options.post ? "rerun_with_posting" : "rerun_no_post",
        dbUpdated: options.updateDb
      })
    );

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ingestDatabasePath: INGEST_DATABASE_PATH,
            mode: options.post ? "rerun_with_posting" : "rerun_no_post",
            dbUpdated: options.updateDb,
            input: {
              id: inputEvent.id,
              ticker: inputEvent.ticker,
              priorProcessStatus: inputEvent.processStatus
            },
            error: String(err?.message || err || "Unknown rerun error")
          },
          null,
          2
        )
      );
    } else {
      console.error(`Rerun failed for ${inputEvent.id}: ${err.message}`);
    }

    process.exit(1);
  }
}

run();
