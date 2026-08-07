const { spawnSync } = require("child_process");
const path = require("path");
const Database = require("better-sqlite3");

const { INGEST_DATABASE_PATH } = require("./lib/config");
const { cleanText } = require("./lib/utils");

const REASON_PRESETS = new Set([
  "headline_only",
  "openai_fallback",
  "weak_sec_wrapper",
  "source_leak",
  "unreadable_leak"
]);

function parseArgs(argv) {
  const options = {
    reason: "headline_only",
    since: new Date().toISOString().slice(0, 10),
    ticker: null,
    limit: 5,
    apply: false,
    updateDb: false,
    post: false,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--reason" && next) {
      options.reason = cleanText(next).toLowerCase();
      i += 1;
      continue;
    }

    if ((arg === "--since" || arg === "--from") && next) {
      options.since = next;
      i += 1;
      continue;
    }

    if (arg === "--ticker" && next) {
      options.ticker = cleanText(next).toUpperCase();
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

    if (arg === "--update-db") {
      options.updateDb = true;
      continue;
    }

    if (arg === "--post") {
      options.post = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
    }
  }

  if (!REASON_PRESETS.has(options.reason)) {
    throw new Error(`Unknown --reason "${options.reason}". Use one of: ${Array.from(REASON_PRESETS).join(", ")}`);
  }

  return options;
}

function normalizeSince(value) {
  const raw = cleanText(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  return raw || new Date().toISOString().slice(0, 10);
}

function buildWhereClause(options) {
  const clauses = ["observed_at >= @since", "process_status = 'processed'"];
  const params = {
    since: normalizeSince(options.since),
    limit: Math.max(1, Number(options.limit) || 5)
  };

  if (options.ticker) {
    clauses.push("ticker = @ticker");
    params.ticker = options.ticker;
  }

  if (options.reason === "headline_only") {
    clauses.push("article_source_mode = 'headline_only_fallback'");
  } else if (options.reason === "openai_fallback") {
    clauses.push("article_source_mode = 'openai_url_fallback'");
  } else if (options.reason === "weak_sec_wrapper") {
    clauses.push("is_sec_source = 1");
    clauses.push("selected_document_kind = 'index_primary'");
    clauses.push("UPPER(COALESCE(selected_document_type, filing_type, '')) IN ('8-K', '6-K')");
  } else if (options.reason === "source_leak") {
    clauses.push(
      "summary REGEXP '(Business\\s*Wire|BusinessWire|PR\\s*Newswire|GlobeNewswire|Accesswire|Newswire|press release)'"
    );
  } else if (options.reason === "unreadable_leak") {
    clauses.push("summary REGEXP '(could not|unable to|unavailable|not readable|not loaded|not retrieved)'");
  }

  return { clauses, params };
}

function installRegexp(db) {
  db.function("REGEXP", { deterministic: true }, (pattern, value) => {
    try {
      return new RegExp(pattern, "i").test(String(value || "")) ? 1 : 0;
    } catch (_) {
      return 0;
    }
  });
}

function findCandidates(options) {
  const db = new Database(INGEST_DATABASE_PATH, { readonly: true });
  installRegexp(db);
  const { clauses, params } = buildWhereClause(options);
  const rows = db
    .prepare(
      `
      SELECT
        id,
        ticker,
        observed_at,
        article_source_mode,
        selected_document_kind,
        selected_document_type,
        filing_type,
        headline,
        summary
      FROM ingest_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY observed_at DESC
      LIMIT @limit
      `
    )
    .all(params);
  db.close();
  return rows.map(row => ({
    id: String(row.id),
    ticker: cleanText(row.ticker || "UNKNOWN").toUpperCase(),
    observedAt: row.observed_at || null,
    articleSourceMode: row.article_source_mode || null,
    selectedDocumentKind: row.selected_document_kind || null,
    selectedDocumentType: row.selected_document_type || null,
    filingType: row.filing_type || null,
    headline: row.headline || null,
    summary: row.summary || null
  }));
}

function rerunCandidate(candidate, options) {
  const args = [
    path.join(__dirname, "ingest_event_rerun.js"),
    "--id",
    candidate.id,
    "--preserve-observed-at"
  ];

  if (options.updateDb) args.push("--update-db");
  if (options.post) args.push("--post");
  if (options.json) args.push("--json");

  const result = spawnSync(process.execPath, args, {
    cwd: __dirname,
    encoding: "utf8",
    stdio: options.json ? "pipe" : "inherit"
  });

  return {
    id: candidate.id,
    ticker: candidate.ticker,
    status: result.status,
    ok: result.status === 0,
    stdout: options.json ? result.stdout : null,
    stderr: options.json ? result.stderr : null
  };
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const candidates = findCandidates(options);
  const results = options.apply ? candidates.map(candidate => rerunCandidate(candidate, options)) : [];

  const output = {
    ingestDatabasePath: INGEST_DATABASE_PATH,
    mode: options.apply ? "apply" : "dry_run",
    filters: {
      reason: options.reason,
      since: normalizeSince(options.since),
      ticker: options.ticker,
      limit: options.limit,
      updateDb: options.updateDb,
      post: options.post
    },
    candidateCount: candidates.length,
    candidates,
    results
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Ingest DB: ${output.ingestDatabasePath}`);
  console.log(`Mode: ${output.mode}`);
  console.log(
    `Filters: reason=${output.filters.reason} since=${output.filters.since} ticker=${output.filters.ticker || "N/A"} limit=${output.filters.limit}`
  );
  console.log(`Candidates: ${output.candidateCount}`);
  if (!options.apply) {
    console.log("Dry run only. Add --apply to rerun candidates. Add --update-db to replace stored summaries.");
  }

  for (const candidate of candidates) {
    console.log(
      `${candidate.ticker} | ${candidate.id} | ${candidate.observedAt || "N/A"} | ${candidate.articleSourceMode || "N/A"} | ${candidate.selectedDocumentKind || "N/A"}/${candidate.selectedDocumentType || "N/A"} | ${candidate.headline || candidate.summary || "N/A"}`
    );
  }

  if (options.apply) {
    const succeeded = results.filter(result => result.ok).length;
    console.log(`Rerun complete: ${succeeded}/${results.length} succeeded.`);
  }
}

run();
