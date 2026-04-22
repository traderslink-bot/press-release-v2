const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const { INGEST_DATABASE_PATH } = require("./config");
const { cleanText } = require("./utils");

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return cleanText(url || "") || null;
  }
}

function getHostname(url) {
  try {
    return new URL(String(url || "").trim()).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

function toIsoString(value = new Date()) {
  return new Date(value).toISOString();
}

function jsonStringify(value) {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return null;
  }
}

function buildContentHash(text) {
  const normalized = cleanText(text || "");
  if (!normalized) return null;
  return crypto.createHash("sha1").update(normalized).digest("hex");
}

ensureParentDir(INGEST_DATABASE_PATH);
const db = new Database(INGEST_DATABASE_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS ingest_events (
    id TEXT PRIMARY KEY,
    observed_at TEXT NOT NULL,
    message_timestamp TEXT,
    ticker TEXT NOT NULL,
    tickers_json TEXT,
    route_tag TEXT NOT NULL,
    article_url TEXT,
    normalized_article_url TEXT,
    source_hostname TEXT,
    is_sec_source INTEGER NOT NULL DEFAULT 0,
    raw_discord_message TEXT,
    float_text TEXT,
    io_text TEXT,
    market_cap_text TEXT,
    extra_info_json TEXT,
    process_status TEXT NOT NULL DEFAULT 'observed',
    article_source_mode TEXT,
    filing_type TEXT,
    event_type TEXT,
    dilution_status TEXT,
    dilution_trigger_type TEXT,
    dilution_trigger_date TEXT,
    can_dilute_today TEXT,
    earliest_dilution TEXT,
    headline TEXT,
    summary TEXT,
    positives_json TEXT,
    negatives_json TEXT,
    ai_tickers_json TEXT,
    openai_usage_json TEXT,
    document_selection_json TEXT,
    selected_document_url TEXT,
    selected_document_type TEXT,
    selected_document_kind TEXT,
    document_diagnostics_json TEXT,
    wrapper_risk_level TEXT,
    signal_diagnostics_json TEXT,
    signal_quality TEXT,
    latency_metrics_json TEXT,
    queue_delay_ms INTEGER,
    total_processing_ms INTEGER,
    duplicate_diagnostics_json TEXT,
    reason_codes_json TEXT,
    review_queue_flag INTEGER NOT NULL DEFAULT 0,
    review_queue_reasons_json TEXT,
    article_text_hash TEXT,
    article_text TEXT,
    ai_json TEXT,
    webhook_targets_json TEXT,
    posted_messages_json TEXT,
    processed_at TEXT,
    processing_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ingest_events_observed_at
    ON ingest_events (observed_at DESC);

  CREATE INDEX IF NOT EXISTS idx_ingest_events_ticker_observed_at
    ON ingest_events (ticker, observed_at DESC);

  CREATE INDEX IF NOT EXISTS idx_ingest_events_normalized_article_url
    ON ingest_events (normalized_article_url);

  CREATE INDEX IF NOT EXISTS idx_ingest_events_route_status
    ON ingest_events (route_tag, process_status, observed_at DESC);
`);

function ensureColumn(tableName, columnName, columnSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some(column => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
  }
}

ensureColumn("ingest_events", "document_selection_json", "TEXT");
ensureColumn("ingest_events", "selected_document_url", "TEXT");
ensureColumn("ingest_events", "selected_document_type", "TEXT");
ensureColumn("ingest_events", "selected_document_kind", "TEXT");
ensureColumn("ingest_events", "document_diagnostics_json", "TEXT");
ensureColumn("ingest_events", "wrapper_risk_level", "TEXT");
ensureColumn("ingest_events", "signal_diagnostics_json", "TEXT");
ensureColumn("ingest_events", "signal_quality", "TEXT");
ensureColumn("ingest_events", "latency_metrics_json", "TEXT");
ensureColumn("ingest_events", "queue_delay_ms", "INTEGER");
ensureColumn("ingest_events", "total_processing_ms", "INTEGER");
ensureColumn("ingest_events", "duplicate_diagnostics_json", "TEXT");
ensureColumn("ingest_events", "reason_codes_json", "TEXT");
ensureColumn("ingest_events", "review_queue_flag", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("ingest_events", "review_queue_reasons_json", "TEXT");
ensureColumn("ingest_events", "posted_messages_json", "TEXT");

const insertObservedEvent = db.prepare(`
  INSERT OR IGNORE INTO ingest_events (
    id,
    observed_at,
    message_timestamp,
    ticker,
    tickers_json,
    route_tag,
    article_url,
    normalized_article_url,
    source_hostname,
    is_sec_source,
    raw_discord_message,
    float_text,
    io_text,
    market_cap_text,
    extra_info_json,
    process_status,
    created_at,
    updated_at
  ) VALUES (
    @id,
    @observed_at,
    @message_timestamp,
    @ticker,
    @tickers_json,
    @route_tag,
    @article_url,
    @normalized_article_url,
    @source_hostname,
    @is_sec_source,
    @raw_discord_message,
    @float_text,
    @io_text,
    @market_cap_text,
    @extra_info_json,
    'observed',
    @created_at,
    @updated_at
  )
`);

const updateProcessedEvent = db.prepare(`
  UPDATE ingest_events
  SET
    process_status = 'processed',
    article_source_mode = @article_source_mode,
    filing_type = @filing_type,
    event_type = @event_type,
    dilution_status = @dilution_status,
    dilution_trigger_type = @dilution_trigger_type,
    dilution_trigger_date = @dilution_trigger_date,
    can_dilute_today = @can_dilute_today,
    earliest_dilution = @earliest_dilution,
    headline = @headline,
    summary = @summary,
    positives_json = @positives_json,
    negatives_json = @negatives_json,
    ai_tickers_json = @ai_tickers_json,
    openai_usage_json = @openai_usage_json,
    document_selection_json = @document_selection_json,
    selected_document_url = @selected_document_url,
    selected_document_type = @selected_document_type,
    selected_document_kind = @selected_document_kind,
    document_diagnostics_json = @document_diagnostics_json,
    wrapper_risk_level = @wrapper_risk_level,
    signal_diagnostics_json = @signal_diagnostics_json,
    signal_quality = @signal_quality,
    latency_metrics_json = @latency_metrics_json,
    queue_delay_ms = @queue_delay_ms,
    total_processing_ms = @total_processing_ms,
    duplicate_diagnostics_json = @duplicate_diagnostics_json,
    reason_codes_json = @reason_codes_json,
    review_queue_flag = @review_queue_flag,
    review_queue_reasons_json = @review_queue_reasons_json,
    article_text_hash = @article_text_hash,
    article_text = @article_text,
    ai_json = @ai_json,
    webhook_targets_json = @webhook_targets_json,
    posted_messages_json = @posted_messages_json,
    processed_at = @processed_at,
    processing_error = NULL,
    updated_at = @updated_at
  WHERE id = @id
`);

const updateFailedEvent = db.prepare(`
  UPDATE ingest_events
  SET
    process_status = 'failed',
    processing_error = @processing_error,
    updated_at = @updated_at
  WHERE id = @id
`);

const selectRecentDuplicatesByUrl = db.prepare(`
  SELECT id, ticker, route_tag, observed_at, normalized_article_url, headline, event_type
  FROM ingest_events
  WHERE normalized_article_url = @normalized_article_url
    AND id != @id
    AND observed_at >= @cutoff_observed_at
  ORDER BY observed_at DESC
  LIMIT 5
`);

function recordObservedEvent(data) {
  const observedAt = toIsoString(data.observedAt || new Date());
  insertObservedEvent.run({
    id: String(data.id),
    observed_at: observedAt,
    message_timestamp: data.messageTimestamp ? toIsoString(data.messageTimestamp) : null,
    ticker: cleanText(data.ticker || "UNKNOWN").toUpperCase(),
    tickers_json: jsonStringify(Array.isArray(data.tickers) ? data.tickers : []),
    route_tag: cleanText(data.routeTag || "default").toLowerCase(),
    article_url: cleanText(data.articleLink || "") || null,
    normalized_article_url: normalizeUrl(data.articleLink),
    source_hostname: getHostname(data.articleLink),
    is_sec_source: /sec\.gov/i.test(String(data.articleLink || "")) ? 1 : 0,
    raw_discord_message: String(data.rawText || ""),
    float_text: cleanText(data.float || "") || null,
    io_text: cleanText(data.io || "") || null,
    market_cap_text: cleanText(data.marketCap || "") || null,
    extra_info_json: jsonStringify(Array.isArray(data.extraInfo) ? data.extraInfo : []),
    created_at: observedAt,
    updated_at: observedAt
  });
}

function recordProcessedEvent(result) {
  const processedAt = toIsoString(new Date());
  const articleText = result?.reviewArtifacts?.articleText || null;
  const ai = result?.reviewArtifacts?.ai || null;
  const selection = result?.articleSelectionMeta || result?.reviewArtifacts?.articleSelectionMeta || null;
  const diagnostics =
    result?.documentDiagnostics ||
    result?.reviewArtifacts?.documentDiagnostics ||
    null;
  const signalDiagnostics =
    result?.signalDiagnostics ||
    result?.reviewArtifacts?.signalDiagnostics ||
    null;
  const latencyMetrics =
    result?.latencyMetrics ||
    result?.reviewArtifacts?.latencyMetrics ||
    null;
  const duplicateDiagnostics =
    result?.duplicateDiagnostics ||
    result?.reviewArtifacts?.duplicateDiagnostics ||
    null;
  const reasonCodes = Array.isArray(result?.reasonCodes)
    ? result.reasonCodes
    : Array.isArray(result?.reviewArtifacts?.reasonCodes)
      ? result.reviewArtifacts.reasonCodes
      : [];
  const reviewQueueDecision =
    result?.reviewQueueDecision ||
    result?.reviewArtifacts?.reviewQueueDecision ||
    null;
  updateProcessedEvent.run({
    id: String(result.id),
    article_source_mode: cleanText(result.articleSourceMode || "") || null,
    filing_type: cleanText(result.filingType || "") || null,
    event_type: cleanText(result.eventType || "") || null,
    dilution_status: cleanText(result.dilutionStatus || "") || null,
    dilution_trigger_type: cleanText(result.dilutionTriggerType || "") || null,
    dilution_trigger_date: cleanText(result.dilutionTriggerDate || "") || null,
    can_dilute_today: cleanText(result.canDiluteToday || "") || null,
    earliest_dilution: cleanText(result.earliestDilution || "") || null,
    headline: cleanText(result.headline || "") || null,
    summary: cleanText(result.summary || "") || null,
    positives_json: jsonStringify(Array.isArray(result.positives) ? result.positives : []),
    negatives_json: jsonStringify(Array.isArray(result.negatives) ? result.negatives : []),
    ai_tickers_json: jsonStringify(Array.isArray(result.tickers) ? result.tickers : []),
    openai_usage_json: jsonStringify(result.openaiUsage || null),
    document_selection_json: jsonStringify(selection),
    selected_document_url: cleanText(selection?.selectedDocumentUrl || "") || null,
    selected_document_type: cleanText(selection?.selectedDocumentType || "") || null,
    selected_document_kind: cleanText(selection?.selectionKind || "") || null,
    document_diagnostics_json: jsonStringify(diagnostics),
    wrapper_risk_level: cleanText(diagnostics?.wrapperRiskLevel || "") || null,
    signal_diagnostics_json: jsonStringify(signalDiagnostics),
    signal_quality: cleanText(signalDiagnostics?.signalQuality || "") || null,
    latency_metrics_json: jsonStringify(latencyMetrics),
    queue_delay_ms: Number.isFinite(latencyMetrics?.queueDelayMs) ? latencyMetrics.queueDelayMs : null,
    total_processing_ms: Number.isFinite(latencyMetrics?.totalProcessingMs) ? latencyMetrics.totalProcessingMs : null,
    duplicate_diagnostics_json: jsonStringify(duplicateDiagnostics),
    reason_codes_json: jsonStringify(reasonCodes),
    review_queue_flag: reviewQueueDecision?.shouldQueue ? 1 : 0,
    review_queue_reasons_json: jsonStringify(
      Array.isArray(reviewQueueDecision?.reviewReasons) ? reviewQueueDecision.reviewReasons : []
    ),
    article_text_hash: buildContentHash(articleText),
    article_text: articleText,
    ai_json: jsonStringify(ai),
    webhook_targets_json: jsonStringify(Array.isArray(result.webhookTargets) ? result.webhookTargets : []),
    posted_messages_json: jsonStringify(Array.isArray(result.postedMessages) ? result.postedMessages : []),
    processed_at: processedAt,
    updated_at: processedAt
  });
}

function recordFailedEvent(id, error) {
  updateFailedEvent.run({
    id: String(id),
    processing_error: cleanText(error?.message || error || "Unknown processing error"),
    updated_at: toIsoString(new Date())
  });
}

function findRecentDuplicateContext({ id, articleLink, lookbackHours = 72 }) {
  const normalizedArticleUrl = normalizeUrl(articleLink);
  if (!normalizedArticleUrl) {
    return {
      duplicateGroupKey: null,
      recentDuplicateCount: 0,
      recentDuplicates: [],
      isRecentDuplicate: false
    };
  }

  const cutoffObservedAt = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const rows = selectRecentDuplicatesByUrl.all({
    id: String(id),
    normalized_article_url: normalizedArticleUrl,
    cutoff_observed_at: cutoffObservedAt
  });

  return {
    duplicateGroupKey: normalizedArticleUrl,
    recentDuplicateCount: rows.length,
    recentDuplicates: rows,
    isRecentDuplicate: rows.length > 0
  };
}

const selectTrackedPostedMessages = db.prepare(`
  SELECT
    id,
    ticker,
    observed_at,
    headline,
    posted_messages_json
  FROM ingest_events
  WHERE posted_messages_json IS NOT NULL
    AND posted_messages_json != ''
  ORDER BY observed_at DESC
`);

function getTrackedPostedMessages() {
  const rows = selectTrackedPostedMessages.all();
  const tracked = [];

  for (const row of rows) {
    let postedMessages = [];
    try {
      postedMessages = JSON.parse(row.posted_messages_json || "[]");
    } catch (_) {
      postedMessages = [];
    }

    for (const message of postedMessages) {
      if (!cleanText(message?.webhookUrl || "") || !cleanText(message?.messageId || "")) {
        continue;
      }

      tracked.push({
        ingestEventId: row.id,
        ticker: row.ticker,
        observedAt: row.observed_at,
        headline: row.headline || null,
        webhookUrl: String(message.webhookUrl),
        messageId: String(message.messageId),
        channelId: cleanText(message.channelId || "") || null,
        guildId: cleanText(message.guildId || "") || null
      });
    }
  }

  return tracked;
}

module.exports = {
  INGEST_DATABASE_PATH,
  recordObservedEvent,
  recordProcessedEvent,
  recordFailedEvent,
  findRecentDuplicateContext,
  getTrackedPostedMessages
};
