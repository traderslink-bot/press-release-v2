const Database = require("better-sqlite3");

const { INGEST_DATABASE_PATH } = require("./lib/config");
const { cleanText } = require("./lib/utils");

function parseArgs(argv) {
  const options = {
    since: new Date().toISOString().slice(0, 10),
    limit: 12,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if ((arg === "--since" || arg === "--from") && next) {
      options.since = next;
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

    if (arg === "--json") {
      options.json = true;
    }
  }

  return options;
}

function normalizeSince(value) {
  const raw = cleanText(value || "");
  if (!raw) return new Date().toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  return raw;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function isPosted(row) {
  return parseJsonArray(row.posted_messages_json).length > 0;
}

function bump(map, key) {
  const normalized = cleanText(key || "N/A");
  map.set(normalized, (map.get(normalized) || 0) + 1);
}

function topEntries(map, limit = 10) {
  return Array.from(map.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function hasSourceAttributionLeak(row) {
  return /\b(?:Business\s*Wire|BusinessWire|PR\s*Newswire|GlobeNewswire|Accesswire|Newswire)\b|press release/i.test(
    cleanText(row.summary || "")
  );
}

function hasUnreadableDisclosureLeak(row) {
  return /could not|unable to|unavailable|not readable|not loaded|not retrieved/i.test(cleanText(row.summary || ""));
}

function isWeakSecWrapper(row) {
  return (
    row.is_sec_source === 1 &&
    /^(?:8-K|6-K)$/i.test(cleanText(row.selected_document_type || row.filing_type || "")) &&
    cleanText(row.selected_document_kind || "") === "index_primary"
  );
}

function simplifyRow(row) {
  return {
    observedAt: row.observed_at,
    ticker: row.ticker,
    routeTag: row.route_tag,
    source: row.source_hostname,
    articleSourceMode: row.article_source_mode,
    filingType: row.filing_type,
    eventType: row.event_type,
    selectedDocumentKind: row.selected_document_kind,
    selectedDocumentType: row.selected_document_type,
    headline: row.headline,
    summary: row.summary,
    articleUrl: row.article_url
  };
}

function average(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return null;
  return Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function buildAudit(rows, limit) {
  const postedRows = rows.filter(isPosted);
  const bySourceMode = new Map();
  const byDomain = new Map();
  const bySecSelection = new Map();
  const byReviewReason = new Map();

  for (const row of postedRows) {
    bump(bySourceMode, row.article_source_mode || "unknown");
    bump(byDomain, `${row.source_hostname || "unknown"} / ${row.article_source_mode || "unknown"}`);
    if (row.is_sec_source === 1) {
      bump(bySecSelection, `${row.selected_document_kind || "N/A"} / ${row.selected_document_type || "N/A"}`);
    }
    for (const reason of parseJsonArray(row.review_queue_reasons_json)) {
      bump(byReviewReason, reason);
    }
  }

  const sourceLeakRows = postedRows.filter(hasSourceAttributionLeak);
  const unreadableLeakRows = postedRows.filter(hasUnreadableDisclosureLeak);
  const headlineOnlyRows = postedRows.filter(row => row.article_source_mode === "headline_only_fallback");
  const openaiFallbackRows = postedRows.filter(row => row.article_source_mode === "openai_url_fallback");
  const weakSecWrapperRows = postedRows.filter(isWeakSecWrapper);

  return {
    ingestDatabasePath: INGEST_DATABASE_PATH,
    generatedAt: new Date().toISOString(),
    totalObserved: rows.length,
    totalPosted: postedRows.length,
    articleFetch: {
      bySourceMode: topEntries(bySourceMode, 20),
      byDomainAndMode: topEntries(byDomain, 20),
      headlineOnlyFallbackPosted: headlineOnlyRows.length,
      openaiUrlFallbackPosted: openaiFallbackRows.length
    },
    sec: {
      postedSecCount: postedRows.filter(row => row.is_sec_source === 1).length,
      selectedDocuments: topEntries(bySecSelection, 20),
      weakWrapperCount: weakSecWrapperRows.length,
      weakWrappers: weakSecWrapperRows.slice(0, limit).map(simplifyRow)
    },
    aiQuality: {
      sourceAttributionLeakCount: sourceLeakRows.length,
      unreadableDisclosureLeakCount: unreadableLeakRows.length,
      sourceAttributionLeaks: sourceLeakRows.slice(0, limit).map(simplifyRow),
      unreadableDisclosureLeaks: unreadableLeakRows.slice(0, limit).map(simplifyRow)
    },
    latency: {
      averageQueueDelayMs: average(postedRows.map(row => row.queue_delay_ms)),
      averageTotalProcessingMs: average(postedRows.map(row => row.total_processing_ms)),
      slowestPosts: postedRows
        .slice()
        .sort((left, right) => Number(right.total_processing_ms || 0) - Number(left.total_processing_ms || 0))
        .slice(0, limit)
        .map(simplifyRow)
    },
    reviewQueue: {
      topReasons: topEntries(byReviewReason, 20)
    }
  };
}

function printBucket(title, items) {
  console.log(title);
  if (!items.length) {
    console.log("none");
    return;
  }
  for (const item of items) {
    console.log(`${item.count}x  ${item.label}`);
  }
}

function printRows(title, rows) {
  console.log(title);
  if (!rows.length) {
    console.log("none");
    return;
  }
  for (const row of rows) {
    console.log(
      `${row.ticker || "?"} | ${row.observedAt || "?"} | ${row.source || "?"} | ${row.articleSourceMode || "?"} | ${row.selectedDocumentKind || "N/A"}/${row.selectedDocumentType || "N/A"} | ${row.headline || row.summary || "N/A"}`
    );
  }
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const since = normalizeSince(options.since);
  const db = new Database(INGEST_DATABASE_PATH, { readonly: true });
  const rows = db
    .prepare(
      `
      SELECT
        observed_at,
        ticker,
        route_tag,
        article_url,
        source_hostname,
        is_sec_source,
        article_source_mode,
        filing_type,
        event_type,
        headline,
        summary,
        selected_document_url,
        selected_document_type,
        selected_document_kind,
        review_queue_reasons_json,
        posted_messages_json,
        queue_delay_ms,
        total_processing_ms
      FROM ingest_events
      WHERE observed_at >= ?
      ORDER BY observed_at ASC
      `
    )
    .all(since);
  db.close();

  const audit = buildAudit(rows, options.limit);

  if (options.json) {
    console.log(JSON.stringify({ since, ...audit }, null, 2));
    return;
  }

  console.log(`Ingest audit since: ${since}`);
  console.log(`Generated: ${audit.generatedAt}`);
  console.log(`Observed: ${audit.totalObserved}`);
  console.log(`Posted: ${audit.totalPosted}`);
  console.log(`Average total processing: ${audit.latency.averageTotalProcessingMs ?? "N/A"}ms`);
  console.log("");
  printBucket("Article fetch by mode", audit.articleFetch.bySourceMode);
  console.log("");
  printBucket("Top domain/mode pairs", audit.articleFetch.byDomainAndMode);
  console.log("");
  printBucket("SEC selected documents", audit.sec.selectedDocuments);
  console.log("");
  console.log(`Weak SEC wrappers: ${audit.sec.weakWrapperCount}`);
  printRows("Weak SEC wrapper sample", audit.sec.weakWrappers);
  console.log("");
  console.log(`Source-attribution leaks: ${audit.aiQuality.sourceAttributionLeakCount}`);
  printRows("Source-attribution leak sample", audit.aiQuality.sourceAttributionLeaks);
  console.log("");
  console.log(`Unreadable-disclosure leaks: ${audit.aiQuality.unreadableDisclosureLeakCount}`);
  printRows("Unreadable-disclosure leak sample", audit.aiQuality.unreadableDisclosureLeaks);
  console.log("");
  printBucket("Review queue top reasons", audit.reviewQueue.topReasons);
  console.log("");
  printRows("Slowest posted items", audit.latency.slowestPosts);
}

run();
