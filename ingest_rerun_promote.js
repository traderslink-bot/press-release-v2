const {
  getIngestEventLatestSuccessfulRerunPromotionPreview,
  promoteIngestEventFromLatestSuccessfulRerun
} = require("./lib/ingestStore");

function parseArgs(argv) {
  const options = {
    id: null,
    apply: false,
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

function formatValue(value) {
  if (value === null || value === undefined || value === "") {
    return "N/A";
  }

  if (Array.isArray(value)) {
    return value.length ? value.join(", ") : "none";
  }

  return String(value);
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.id) {
    throw new Error("Missing required --id argument.");
  }

  if (options.apply) {
    const result = promoteIngestEventFromLatestSuccessfulRerun(options.id);
    if (!result) {
      throw new Error(`Ingest event not found: ${options.id}`);
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            action: "promote_latest_rerun",
            applied: true,
            ingestDatabasePath: result.ingestDatabasePath,
            ingestEventId: result.ingestEventId,
            promotedFromAuditId: result.promotedFromAuditId,
            changedFields: result.changedFields,
            currentBefore: result.currentBefore,
            currentAfter: result.currentAfter
          },
          null,
          2
        )
      );
      return;
    }

    console.log(`Applied promotion for ${result.ingestEventId}`);
    console.log(`Source audit: ${result.promotedFromAuditId}`);
    console.log(`Changed fields: ${result.changedFields.join(", ") || "none"}`);
    console.log(`Status: ${formatValue(result.currentBefore.processStatus)} -> ${formatValue(result.currentAfter.processStatus)}`);
    console.log(`Event type: ${formatValue(result.currentBefore.eventType)} -> ${formatValue(result.currentAfter.eventType)}`);
    console.log(`Headline: ${formatValue(result.currentAfter.headline)}`);
    return;
  }

  const preview = getIngestEventLatestSuccessfulRerunPromotionPreview(options.id);
  if (!preview) {
    throw new Error(`Ingest event not found: ${options.id}`);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          action: "promote_latest_rerun",
          applied: false,
          ...preview
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Ingest event: ${preview.ingestEventId}`);
  console.log(`Can promote: ${preview.canPromote ? "yes" : "no"}`);

  if (!preview.latestSuccessfulRerun) {
    console.log("No successful rerun snapshot with promotable data was found.");
    console.log("Run `npm run rerun-ingest:v2 -- --id <ingest-id>` first, then try again.");
    return;
  }

  console.log(
    `Source audit: ${preview.latestSuccessfulRerun.auditId} | ${preview.latestSuccessfulRerun.executedAt} | ${preview.latestSuccessfulRerun.mode}`
  );
  console.log(`Changed fields: ${preview.changedFields.join(", ") || "none"}`);
  console.log(`Current status: ${formatValue(preview.current.processStatus)}`);
  console.log(`Promoted status: processed`);
  console.log(`Current event type: ${formatValue(preview.current.eventType)}`);
  console.log(`Rerun event type: ${formatValue(preview.latestSuccessfulRerun.eventType)}`);
  console.log(`Current headline: ${formatValue(preview.current.headline)}`);
  console.log(`Rerun headline: ${formatValue(preview.latestSuccessfulRerun.headline)}`);
  console.log("");
  console.log("Apply with:");
  console.log(`npm run rerun-promote:v2 -- --id ${preview.ingestEventId} --apply`);
}

run();
