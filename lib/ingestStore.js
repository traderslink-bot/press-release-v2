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

function toOptionalIsoString(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
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
    feed_type TEXT,
    flag_text TEXT,
    float_text TEXT,
    io_text TEXT,
    market_cap_text TEXT,
    market_cap_value REAL,
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

  CREATE TABLE IF NOT EXISTS ingest_rerun_audit (
    id TEXT PRIMARY KEY,
    ingest_event_id TEXT NOT NULL,
    executed_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    db_updated INTEGER NOT NULL DEFAULT 0,
    preserve_observed_at INTEGER NOT NULL DEFAULT 0,
    post_enabled INTEGER NOT NULL DEFAULT 0,
    prior_process_status TEXT,
    prior_processing_error TEXT,
    original_observed_at TEXT,
    rerun_observed_at TEXT,
    outcome_status TEXT NOT NULL,
    outcome_error TEXT,
    result_event_type TEXT,
    result_filing_type TEXT,
    result_article_source_mode TEXT,
    result_confidence REAL,
    reason_codes_json TEXT,
    review_reasons_json TEXT,
    latency_metrics_json TEXT,
    posted_messages_json TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ingest_rerun_audit_event_executed
    ON ingest_rerun_audit (ingest_event_id, executed_at DESC);

  CREATE TABLE IF NOT EXISTS website_article_posts (
    ingest_event_id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    article_url TEXT NOT NULL,
    article_path TEXT,
    title TEXT,
    event_type TEXT,
    filing_type TEXT,
    route_tag TEXT,
    source_url TEXT,
    website_published_at TEXT NOT NULL,
    observed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_website_article_posts_ticker_published
    ON website_article_posts (ticker, website_published_at DESC);
`);

function ensureColumn(tableName, columnName, columnSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some(column => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
  }
}

ensureColumn("ingest_events", "document_selection_json", "TEXT");
ensureColumn("ingest_events", "feed_type", "TEXT");
ensureColumn("ingest_events", "flag_text", "TEXT");
ensureColumn("ingest_events", "market_cap_value", "REAL");
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
ensureColumn("ingest_events", "processing_started_at", "TEXT");
ensureColumn("ingest_events", "processing_attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("ingest_events", "retry_after_at", "TEXT");
ensureColumn("ingest_events", "deferred_retry_count", "INTEGER NOT NULL DEFAULT 0");

ensureColumn("website_article_posts", "updated_at", "TEXT");

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
    feed_type,
    flag_text,
    float_text,
    io_text,
    market_cap_text,
    market_cap_value,
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
    @feed_type,
    @flag_text,
    @float_text,
    @io_text,
    @market_cap_text,
    @market_cap_value,
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
    processing_started_at = NULL,
    retry_after_at = NULL,
    processed_at = @processed_at,
    processing_error = NULL,
    updated_at = @updated_at
  WHERE id = @id
`);

const updateFailedEvent = db.prepare(`
  UPDATE ingest_events
  SET
    process_status = 'failed',
    processing_started_at = NULL,
    retry_after_at = NULL,
    processing_error = @processing_error,
    updated_at = @updated_at
  WHERE id = @id
`);

const selectQueuedEventById = db.prepare(`
  SELECT
    id,
    observed_at,
    message_timestamp,
    ticker,
    tickers_json,
    route_tag,
    article_url,
    raw_discord_message,
    feed_type,
    float_text,
    io_text,
    market_cap_text,
    extra_info_json,
    deferred_retry_count
  FROM ingest_events
  WHERE id = @id
`);

const selectIngestEventById = db.prepare(`
  SELECT
    id,
    observed_at,
    message_timestamp,
    ticker,
    tickers_json,
    route_tag,
    article_url,
    raw_discord_message,
    float_text,
    io_text,
    market_cap_text,
    extra_info_json,
    process_status,
    article_source_mode,
    filing_type,
    event_type,
    can_dilute_today,
    earliest_dilution,
    headline,
    summary,
    ai_json,
    reason_codes_json,
    latency_metrics_json,
    posted_messages_json,
    processing_error,
    updated_at,
    deferred_retry_count
  FROM ingest_events
  WHERE id = @id
`);

const selectNextEligibleQueuedEvent = db.prepare(`
  SELECT
    id,
    process_status
  FROM ingest_events
  WHERE process_status = 'observed'
     OR (process_status = 'retry_wait' AND retry_after_at IS NOT NULL AND retry_after_at <= @now)
  ORDER BY observed_at ASC
  LIMIT 1
`);

const markQueuedEventProcessing = db.prepare(`
  UPDATE ingest_events
  SET
    process_status = 'processing',
    processing_started_at = @processing_started_at,
    processing_attempts = COALESCE(processing_attempts, 0) + 1,
    processing_error = NULL,
    updated_at = @updated_at
  WHERE id = @id
    AND (
      process_status = 'observed'
      OR (process_status = 'retry_wait' AND retry_after_at IS NOT NULL AND retry_after_at <= @retry_ready_at)
    )
`);

const updateQueuedRetrySchedule = db.prepare(`
  UPDATE ingest_events
  SET
    process_status = 'retry_wait',
    deferred_retry_count = @deferred_retry_count,
    retry_after_at = @retry_after_at,
    processing_started_at = NULL,
    processing_error = @processing_error,
    updated_at = @updated_at
  WHERE id = @id
`);

const recoverInterruptedQueuedEventsStatement = db.prepare(`
  UPDATE ingest_events
  SET
    process_status = 'observed',
    processing_started_at = NULL,
    updated_at = @updated_at
  WHERE process_status = 'processing'
`);

const selectNextRetryAfter = db.prepare(`
  SELECT MIN(retry_after_at) AS retry_after_at
  FROM ingest_events
  WHERE process_status = 'retry_wait'
    AND retry_after_at IS NOT NULL
`);

const selectQueueStatusCounts = db.prepare(`
  SELECT
    SUM(CASE WHEN process_status = 'observed' THEN 1 ELSE 0 END) AS observed_count,
    SUM(CASE WHEN process_status = 'processing' THEN 1 ELSE 0 END) AS processing_count,
    SUM(CASE WHEN process_status = 'retry_wait' THEN 1 ELSE 0 END) AS retry_wait_count,
    SUM(CASE WHEN process_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
    SUM(CASE WHEN process_status = 'processed' THEN 1 ELSE 0 END) AS processed_count
  FROM ingest_events
`);

const selectOldestPendingObserved = db.prepare(`
  SELECT id, ticker, observed_at
  FROM ingest_events
  WHERE process_status = 'observed'
  ORDER BY observed_at ASC
  LIMIT 1
`);

const selectOldestProcessing = db.prepare(`
  SELECT id, ticker, processing_started_at, processing_attempts
  FROM ingest_events
  WHERE process_status = 'processing'
  ORDER BY processing_started_at ASC
  LIMIT 1
`);

const selectTopFailedQueueEvents = db.prepare(`
  SELECT id, ticker, updated_at, processing_attempts, processing_error
  FROM ingest_events
  WHERE process_status = 'failed'
  ORDER BY updated_at DESC
  LIMIT @limit
`);

const selectTopRetryQueueEvents = db.prepare(`
  SELECT id, ticker, retry_after_at, deferred_retry_count, processing_error
  FROM ingest_events
  WHERE process_status = 'retry_wait'
  ORDER BY retry_after_at ASC
  LIMIT @limit
`);

const selectAttemptStats = db.prepare(`
  SELECT
    MAX(COALESCE(processing_attempts, 0)) AS max_processing_attempts,
    AVG(CASE WHEN COALESCE(processing_attempts, 0) > 0 THEN processing_attempts END) AS average_processing_attempts
  FROM ingest_events
  WHERE process_status IN ('processed', 'failed', 'retry_wait', 'processing')
`);

const requeueAllowedStatuses = new Set(["failed", "retry_wait", "observed"]);

function normalizeRequeueStatus(value) {
  const normalized = cleanText(value || "").toLowerCase();
  return requeueAllowedStatuses.has(normalized) ? normalized : "failed";
}

const selectRecentDuplicatesByUrl = db.prepare(`
  SELECT
    id,
    ticker,
    route_tag,
    feed_type,
    observed_at,
    normalized_article_url,
    headline,
    event_type,
    process_status,
    posted_messages_json
  FROM ingest_events
  WHERE normalized_article_url = @normalized_article_url
    AND id != @id
    AND observed_at >= @cutoff_observed_at
  ORDER BY observed_at DESC
  LIMIT 5
`);

const selectRecentProcessedAnalysisByUrl = db.prepare(`
  SELECT
    id,
    ticker,
    route_tag,
    processed_at,
    article_source_mode,
    article_text,
    ai_json
  FROM ingest_events
  WHERE normalized_article_url = @normalized_article_url
    AND id != @id
    AND process_status = 'processed'
    AND COALESCE(article_source_mode, '') != 'market_cap_stale_skip'
    AND ai_json IS NOT NULL
    AND ai_json != ''
    AND processed_at >= @cutoff_processed_at
  ORDER BY
    CASE WHEN route_tag IN ('default', 'spike') THEN 0 ELSE 1 END,
    processed_at DESC
  LIMIT 1
`);

const insertWebsiteArticlePost = db.prepare(`
  INSERT INTO website_article_posts (
    ingest_event_id,
    ticker,
    article_url,
    article_path,
    title,
    event_type,
    filing_type,
    route_tag,
    source_url,
    website_published_at,
    observed_at,
    created_at,
    updated_at
  ) VALUES (
    @ingest_event_id,
    @ticker,
    @article_url,
    @article_path,
    @title,
    @event_type,
    @filing_type,
    @route_tag,
    @source_url,
    @website_published_at,
    @observed_at,
    @created_at,
    @updated_at
  )
  ON CONFLICT(ingest_event_id) DO UPDATE SET
    ticker = excluded.ticker,
    article_url = excluded.article_url,
    article_path = excluded.article_path,
    title = excluded.title,
    event_type = excluded.event_type,
    filing_type = excluded.filing_type,
    route_tag = excluded.route_tag,
    source_url = excluded.source_url,
    website_published_at = excluded.website_published_at,
    observed_at = excluded.observed_at,
    updated_at = excluded.updated_at
`);

const selectRecentWebsiteArticlesByTicker = db.prepare(`
  SELECT
    posts.ingest_event_id,
    posts.ticker,
    posts.article_url,
    posts.article_path,
    posts.title,
    posts.event_type,
    posts.filing_type,
    posts.route_tag,
    posts.source_url,
    posts.website_published_at,
    posts.observed_at,
    posts.created_at,
    posts.updated_at,
    events.summary,
    events.positives_json,
    events.negatives_json
  FROM website_article_posts AS posts
  LEFT JOIN ingest_events AS events ON events.id = posts.ingest_event_id
  WHERE UPPER(posts.ticker) = @ticker
    AND posts.article_url IS NOT NULL
    AND posts.article_url != ''
    AND datetime(posts.website_published_at) >= datetime(@cutoff_published_at)
  ORDER BY datetime(posts.website_published_at) DESC, datetime(posts.created_at) DESC
  LIMIT @limit
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
    feed_type: cleanText(data.feedType || "") || null,
    flag_text: cleanText(data.flag || "") || null,
    float_text: cleanText(data.float || "") || null,
    io_text: cleanText(data.io || "") || null,
    market_cap_text: cleanText(data.marketCap || "") || null,
    market_cap_value: Number.isFinite(Number(data.marketCapValue)) ? Number(data.marketCapValue) : null,
    extra_info_json: jsonStringify(Array.isArray(data.extraInfo) ? data.extraInfo : []),
    created_at: observedAt,
    updated_at: observedAt
  });
}

function isWeekday(date) {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isTraderLinkWebsiteArticleUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "traderslink.pro" || hostname.endsWith(".traderslink.pro");
  } catch (_) {
    return false;
  }
}

function getBusinessDayCutoff({ businessDays = 5, now = new Date() } = {}) {
  const targetBusinessDays = Math.max(1, Math.floor(Number(businessDays) || 5));
  const cursor = startOfLocalDay(new Date(now));
  let counted = 0;

  while (counted < targetBusinessDays) {
    if (isWeekday(cursor)) {
      counted += 1;
      if (counted >= targetBusinessDays) break;
    }
    cursor.setDate(cursor.getDate() - 1);
  }

  return cursor;
}

function recordWebsiteArticlePost(entry) {
  const ingestEventId = cleanText(entry?.ingestEventId || entry?.sourceEventId || "");
  const ticker = cleanText(entry?.ticker || "").toUpperCase();
  const articleUrl = cleanText(entry?.articleUrl || entry?.url || "");
  if (!ingestEventId || !ticker || !articleUrl || !isTraderLinkWebsiteArticleUrl(articleUrl)) {
    return false;
  }

  const now = toIsoString(new Date());
  insertWebsiteArticlePost.run({
    ingest_event_id: ingestEventId,
    ticker,
    article_url: articleUrl,
    article_path: cleanText(entry?.articlePath || "") || null,
    title: cleanText(entry?.title || entry?.headline || "") || null,
    event_type: cleanText(entry?.eventType || "") || null,
    filing_type: cleanText(entry?.filingType || "") || null,
    route_tag: cleanText(entry?.routeTag || "") || null,
    source_url: cleanText(entry?.sourceUrl || "") || null,
    website_published_at: toOptionalIsoString(entry?.publishedAt) || now,
    observed_at: toOptionalIsoString(entry?.observedAt),
    created_at: now,
    updated_at: now
  });

  return true;
}

function findRecentWebsiteArticlesForTicker({ ticker, businessDays = 5, limit = 10, now = new Date() } = {}) {
  const normalizedTicker = cleanText(ticker || "").toUpperCase();
  const normalizedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
  const normalizedBusinessDays = Math.max(1, Math.floor(Number(businessDays) || 5));
  const cutoff = getBusinessDayCutoff({ businessDays: normalizedBusinessDays, now });

  if (!normalizedTicker) {
    return {
      ticker: "",
      businessDays: normalizedBusinessDays,
      generatedAt: toIsoString(now),
      cutoffPublishedAt: toIsoString(cutoff),
      count: 0,
      articles: []
    };
  }

  const rows = selectRecentWebsiteArticlesByTicker
    .all({
      ticker: normalizedTicker,
      cutoff_published_at: toIsoString(cutoff),
      limit: Math.min(400, normalizedLimit * 4)
    })
    .filter(row => isTraderLinkWebsiteArticleUrl(row.article_url));

  const routePriority = value => ["default", "spike"].includes(cleanText(value || "").toLowerCase()) ? 0 : 1;
  const canonicalRows = new Map();
  for (const row of rows) {
    const sourceKey = normalizeUrl(row.source_url) || `event:${row.ingest_event_id}`;
    const existing = canonicalRows.get(sourceKey);
    if (
      !existing ||
      routePriority(row.route_tag) < routePriority(existing.route_tag) ||
      (
        routePriority(row.route_tag) === routePriority(existing.route_tag) &&
        new Date(row.website_published_at).getTime() < new Date(existing.website_published_at).getTime()
      )
    ) {
      canonicalRows.set(sourceKey, row);
    }
  }

  const articles = [...canonicalRows.values()]
    .sort((left, right) => new Date(right.website_published_at).getTime() - new Date(left.website_published_at).getTime())
    .slice(0, normalizedLimit)
    .map(row => ({
      ingestEventId: row.ingest_event_id,
      ticker: row.ticker,
      url: row.article_url,
      articlePath: cleanText(row.article_path || "") || null,
      title: cleanText(row.title || "") || null,
      publishedAt: row.website_published_at,
      eventType: cleanText(row.event_type || "") || null,
      filingType: cleanText(row.filing_type || "") || null,
      routeTag: cleanText(row.route_tag || "") || null,
      observedAt: row.observed_at || null,
      summary: cleanText(row.summary || "") || null,
      positives: parseJsonArrayValue(row.positives_json).map(cleanText).filter(Boolean),
      negatives: parseJsonArrayValue(row.negatives_json).map(cleanText).filter(Boolean)
    }));

  return {
    ticker: normalizedTicker,
    businessDays: normalizedBusinessDays,
    generatedAt: toIsoString(now),
    cutoffPublishedAt: toIsoString(cutoff),
    count: articles.length,
    articles
  };
}

function buildPersistableProcessedResultSnapshot(result) {
  const articleText = result?.reviewArtifacts?.articleText || result?.articleText || null;
  const ai = result?.reviewArtifacts?.ai || result?.ai || null;
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

  return {
    id: String(result?.id || ""),
    articleSourceMode: cleanText(result?.articleSourceMode || "") || null,
    filingType: cleanText(result?.filingType || "") || null,
    eventType: cleanText(result?.eventType || "") || null,
    dilutionStatus: cleanText(result?.dilutionStatus || "") || null,
    dilutionTriggerType: cleanText(result?.dilutionTriggerType || "") || null,
    dilutionTriggerDate: cleanText(result?.dilutionTriggerDate || "") || null,
    canDiluteToday: cleanText(result?.canDiluteToday || "") || null,
    earliestDilution: cleanText(result?.earliestDilution || "") || null,
    headline: cleanText(result?.headline || "") || null,
    summary: cleanText(result?.summary || "") || null,
    positives: Array.isArray(result?.positives) ? result.positives : [],
    negatives: Array.isArray(result?.negatives) ? result.negatives : [],
    tickers: Array.isArray(result?.tickers) ? result.tickers : [],
    openaiUsage: result?.openaiUsage || null,
    articleSelectionMeta: selection,
    documentDiagnostics: diagnostics,
    signalDiagnostics,
    latencyMetrics,
    duplicateDiagnostics,
    reasonCodes,
    reviewQueueDecision: reviewQueueDecision
      ? {
          shouldQueue: Boolean(reviewQueueDecision.shouldQueue),
          reviewReasons: Array.isArray(reviewQueueDecision.reviewReasons)
            ? reviewQueueDecision.reviewReasons
            : []
        }
      : {
          shouldQueue: false,
          reviewReasons: []
        },
    articleText,
    ai,
    webhookTargets: Array.isArray(result?.webhookTargets) ? result.webhookTargets : [],
    postedMessages: Array.isArray(result?.postedMessages) ? result.postedMessages : []
  };
}

function safeJsonParseArray(value) {
  if (!cleanText(value || "")) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function mapQueuedEventRowToData(row) {
  if (!row) return null;

  return {
    id: String(row.id),
    observedAt: row.observed_at || null,
    messageTimestamp: row.message_timestamp || null,
    ticker: cleanText(row.ticker || "UNKNOWN").toUpperCase(),
    tickers: safeJsonParseArray(row.tickers_json)
      .map(value => cleanText(value || "").toUpperCase())
      .filter(Boolean),
    routeTag: cleanText(row.route_tag || "default").toLowerCase(),
    feedType: cleanText(row.feed_type || "") || null,
    articleLink: cleanText(row.article_url || "") || null,
    rawText: String(row.raw_discord_message || ""),
    flag: cleanText(row.flag_text || "") || null,
    float: cleanText(row.float_text || "") || null,
    io: cleanText(row.io_text || "") || null,
    marketCap: cleanText(row.market_cap_text || "") || null,
    marketCapValue: Number.isFinite(Number(row.market_cap_value)) ? Number(row.market_cap_value) : null,
    extraInfo: safeJsonParseArray(row.extra_info_json).map(value => cleanText(value || "")).filter(Boolean),
    deferredRetryCount: Number(row.deferred_retry_count || 0)
  };
}

function getIngestEventById(id) {
  const normalizedId = cleanText(id || "");
  if (!normalizedId) {
    return null;
  }

  const row = selectIngestEventById.get({ id: normalizedId });
  if (!row) {
    return null;
  }

  return {
    ...mapQueuedEventRowToData(row),
    processStatus: cleanText(row.process_status || "") || null,
    articleSourceMode: cleanText(row.article_source_mode || "") || null,
    filingType: cleanText(row.filing_type || "") || null,
    eventType: cleanText(row.event_type || "") || null,
    canDiluteToday: cleanText(row.can_dilute_today || "") || null,
    earliestDilution: cleanText(row.earliest_dilution || "") || null,
    headline: cleanText(row.headline || "") || null,
    summary: cleanText(row.summary || "") || null,
    ai: parseJsonObjectValue(row.ai_json),
    reasonCodes: parseJsonArrayValue(row.reason_codes_json),
    latencyMetrics: parseJsonObjectValue(row.latency_metrics_json),
    postedMessages: parseJsonArrayValue(row.posted_messages_json),
    processingError: cleanText(row.processing_error || "") || null,
    updatedAt: row.updated_at || null,
    originalObservedAt: row.observed_at || null
  };
}

const claimNextQueuedEvent = db.transaction(() => {
  const now = toIsoString(new Date());
  const candidate = selectNextEligibleQueuedEvent.get({ now });
  if (!candidate?.id) {
    return null;
  }

  const claimResult = markQueuedEventProcessing.run({
    id: String(candidate.id),
    processing_started_at: now,
    updated_at: now,
    retry_ready_at: now
  });

  if (!claimResult.changes) {
    return null;
  }

  const claimedRow = selectQueuedEventById.get({ id: String(candidate.id) });
  return mapQueuedEventRowToData(claimedRow);
});

function scheduleQueuedRetry(id, error, retryCount, delayMs) {
  const now = new Date();
  const retryAfterAt = new Date(now.getTime() + Math.max(0, Number(delayMs) || 0));
  updateQueuedRetrySchedule.run({
    id: String(id),
    deferred_retry_count: Math.max(0, Number(retryCount) || 0),
    retry_after_at: toIsoString(retryAfterAt),
    processing_error: cleanText(error?.message || error || "Retry scheduled"),
    updated_at: toIsoString(now)
  });
}

function recordProcessedEvent(result) {
  const processedAt = toIsoString(new Date());
  const persisted = buildPersistableProcessedResultSnapshot(result);
  updateProcessedEvent.run({
    id: persisted.id,
    article_source_mode: persisted.articleSourceMode,
    filing_type: persisted.filingType,
    event_type: persisted.eventType,
    dilution_status: persisted.dilutionStatus,
    dilution_trigger_type: persisted.dilutionTriggerType,
    dilution_trigger_date: persisted.dilutionTriggerDate,
    can_dilute_today: persisted.canDiluteToday,
    earliest_dilution: persisted.earliestDilution,
    headline: persisted.headline,
    summary: persisted.summary,
    positives_json: jsonStringify(persisted.positives),
    negatives_json: jsonStringify(persisted.negatives),
    ai_tickers_json: jsonStringify(persisted.tickers),
    openai_usage_json: jsonStringify(persisted.openaiUsage),
    document_selection_json: jsonStringify(persisted.articleSelectionMeta),
    selected_document_url: cleanText(persisted.articleSelectionMeta?.selectedDocumentUrl || "") || null,
    selected_document_type: cleanText(persisted.articleSelectionMeta?.selectedDocumentType || "") || null,
    selected_document_kind: cleanText(persisted.articleSelectionMeta?.selectionKind || "") || null,
    document_diagnostics_json: jsonStringify(persisted.documentDiagnostics),
    wrapper_risk_level: cleanText(persisted.documentDiagnostics?.wrapperRiskLevel || "") || null,
    signal_diagnostics_json: jsonStringify(persisted.signalDiagnostics),
    signal_quality: cleanText(persisted.signalDiagnostics?.signalQuality || "") || null,
    latency_metrics_json: jsonStringify(persisted.latencyMetrics),
    queue_delay_ms: Number.isFinite(persisted.latencyMetrics?.queueDelayMs)
      ? persisted.latencyMetrics.queueDelayMs
      : null,
    total_processing_ms: Number.isFinite(persisted.latencyMetrics?.totalProcessingMs)
      ? persisted.latencyMetrics.totalProcessingMs
      : null,
    duplicate_diagnostics_json: jsonStringify(persisted.duplicateDiagnostics),
    reason_codes_json: jsonStringify(persisted.reasonCodes),
    review_queue_flag: persisted.reviewQueueDecision?.shouldQueue ? 1 : 0,
    review_queue_reasons_json: jsonStringify(
      Array.isArray(persisted.reviewQueueDecision?.reviewReasons)
        ? persisted.reviewQueueDecision.reviewReasons
        : []
    ),
    article_text_hash: buildContentHash(persisted.articleText),
    article_text: persisted.articleText,
    ai_json: jsonStringify(persisted.ai),
    webhook_targets_json: jsonStringify(persisted.webhookTargets),
    posted_messages_json: jsonStringify(persisted.postedMessages),
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

function recoverInterruptedQueuedEvents() {
  const updatedAt = toIsoString(new Date());
  const result = recoverInterruptedQueuedEventsStatement.run({ updated_at: updatedAt });
  return Number(result.changes || 0);
}

function getNextRetryDelayMs() {
  const row = selectNextRetryAfter.get();
  const retryAfterAt = cleanText(row?.retry_after_at || "");
  if (!retryAfterAt) {
    return null;
  }

  const retryAtMs = new Date(retryAfterAt).getTime();
  if (!Number.isFinite(retryAtMs)) {
    return null;
  }

  return Math.max(0, retryAtMs - Date.now());
}

function getAgeMsFromIso(isoValue) {
  const value = cleanText(isoValue || "");
  if (!value) return null;

  const timestampMs = new Date(value).getTime();
  if (!Number.isFinite(timestampMs)) {
    return null;
  }

  return Math.max(0, Date.now() - timestampMs);
}

function getIngestQueueStatus(limit = 5) {
  const normalizedLimit = Math.max(1, Number(limit) || 5);
  const counts = selectQueueStatusCounts.get() || {};
  const oldestObserved = selectOldestPendingObserved.get() || null;
  const oldestProcessing = selectOldestProcessing.get() || null;
  const nextRetryDelayMs = getNextRetryDelayMs();
  const attemptStats = selectAttemptStats.get() || {};
  const retrying = selectTopRetryQueueEvents.all({ limit: normalizedLimit }).map(row => ({
    id: String(row.id),
    ticker: cleanText(row.ticker || "UNKNOWN").toUpperCase(),
    retryAfterAt: row.retry_after_at || null,
    deferredRetryCount: Number(row.deferred_retry_count || 0),
    processingError: cleanText(row.processing_error || "") || null
  }));
  const failed = selectTopFailedQueueEvents.all({ limit: normalizedLimit }).map(row => ({
    id: String(row.id),
    ticker: cleanText(row.ticker || "UNKNOWN").toUpperCase(),
    updatedAt: row.updated_at || null,
    processingAttempts: Number(row.processing_attempts || 0),
    processingError: cleanText(row.processing_error || "") || null
  }));

  return {
    ingestDatabasePath: INGEST_DATABASE_PATH,
    generatedAt: toIsoString(new Date()),
    counts: {
      observed: Number(counts.observed_count || 0),
      processing: Number(counts.processing_count || 0),
      retryWait: Number(counts.retry_wait_count || 0),
      failed: Number(counts.failed_count || 0),
      processed: Number(counts.processed_count || 0)
    },
    oldestObserved: oldestObserved
      ? {
          id: String(oldestObserved.id),
          ticker: cleanText(oldestObserved.ticker || "UNKNOWN").toUpperCase(),
          observedAt: oldestObserved.observed_at || null,
          ageMs: getAgeMsFromIso(oldestObserved.observed_at)
        }
      : null,
    oldestProcessing: oldestProcessing
      ? {
          id: String(oldestProcessing.id),
          ticker: cleanText(oldestProcessing.ticker || "UNKNOWN").toUpperCase(),
          processingStartedAt: oldestProcessing.processing_started_at || null,
          ageMs: getAgeMsFromIso(oldestProcessing.processing_started_at),
          processingAttempts: Number(oldestProcessing.processing_attempts || 0)
        }
      : null,
    nextRetryDelayMs,
    processingAttemptStats: {
      max: Number(attemptStats.max_processing_attempts || 0),
      average: Number.isFinite(Number(attemptStats.average_processing_attempts))
        ? Number(Number(attemptStats.average_processing_attempts).toFixed(2))
        : null
    },
    retrying,
    failed
  };
}

function buildRequeueCandidateQuery({ status = "failed", ticker = null, id = null, limit = 10 } = {}) {
  const normalizedStatus = normalizeRequeueStatus(status);
  const normalizedTicker = cleanText(ticker || "").toUpperCase() || null;
  const normalizedId = cleanText(id || "") || null;
  const normalizedLimit = Math.max(1, Number(limit) || 10);
  const clauses = ["process_status = @status"];
  const params = {
    status: normalizedStatus,
    limit: normalizedLimit
  };

  if (normalizedTicker) {
    clauses.push("ticker = @ticker");
    params.ticker = normalizedTicker;
  }

  if (normalizedId) {
    clauses.push("id = @id");
    params.id = normalizedId;
  }

  const sql = `
    SELECT
      id,
      ticker,
      process_status,
      observed_at,
      updated_at,
      processing_attempts,
      deferred_retry_count,
      retry_after_at,
      processing_error
    FROM ingest_events
    WHERE ${clauses.join(" AND ")}
    ORDER BY updated_at DESC, observed_at DESC
    LIMIT @limit
  `;

  return {
    params,
    sql
  };
}

function findRequeueCandidates(options = {}) {
  const { sql, params } = buildRequeueCandidateQuery(options);
  const statement = db.prepare(sql);
  const rows = statement.all(params);

  return rows.map(row => ({
    id: String(row.id),
    ticker: cleanText(row.ticker || "UNKNOWN").toUpperCase(),
    processStatus: cleanText(row.process_status || "") || null,
    observedAt: row.observed_at || null,
    updatedAt: row.updated_at || null,
    processingAttempts: Number(row.processing_attempts || 0),
    deferredRetryCount: Number(row.deferred_retry_count || 0),
    retryAfterAt: row.retry_after_at || null,
    processingError: cleanText(row.processing_error || "") || null
  }));
}

function requeueIngestEvents(options = {}) {
  const candidates = findRequeueCandidates(options);
  if (!candidates.length) {
    return {
      matchedCount: 0,
      requeuedCount: 0,
      candidates: []
    };
  }

  const updatedAt = toIsoString(new Date());
  const ids = candidates.map(candidate => candidate.id);
  const placeholders = ids.map((_id, index) => `@id${index}`).join(", ");
  const params = ids.reduce(
    (accumulator, value, index) => ({
      ...accumulator,
      [`id${index}`]: value
    }),
    { updated_at: updatedAt }
  );

  const result = db
    .prepare(`
      UPDATE ingest_events
      SET
        process_status = 'observed',
        processing_started_at = NULL,
        retry_after_at = NULL,
        deferred_retry_count = 0,
        processing_error = NULL,
        updated_at = @updated_at
      WHERE id IN (${placeholders})
    `)
    .run(params);

  return {
    matchedCount: candidates.length,
    requeuedCount: Number(result.changes || 0),
    candidates
  };
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
  const postedRows = rows.filter(row => {
    const postedMessages = cleanText(row.posted_messages_json || "");
    return postedMessages && postedMessages !== "[]";
  });

  return {
    duplicateGroupKey: normalizedArticleUrl,
    recentDuplicateCount: rows.length,
    recentDuplicates: rows,
    recentPostedDuplicateCount: postedRows.length,
    recentPostedDuplicates: postedRows,
    isRecentDuplicate: rows.length > 0,
    isRecentPostedDuplicate: postedRows.length > 0
  };
}

function findRecentProcessedArticleAnalysis({ id, articleLink, lookbackHours = 72 }) {
  const normalizedArticleUrl = normalizeUrl(articleLink);
  if (!normalizedArticleUrl) return null;

  const cutoffProcessedAt = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const row = selectRecentProcessedAnalysisByUrl.get({
    id: String(id),
    normalized_article_url: normalizedArticleUrl,
    cutoff_processed_at: cutoffProcessedAt
  });
  if (!row) return null;

  const ai = parseJsonObjectValue(row.ai_json);
  if (!ai) return null;

  return {
    ingestEventId: row.id,
    ticker: row.ticker,
    routeTag: row.route_tag,
    processedAt: row.processed_at,
    articleSourceMode: cleanText(row.article_source_mode || "") || "fetched_direct",
    articleText: typeof row.article_text === "string" ? row.article_text : "",
    ai
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

const insertRerunAuditEntry = db.prepare(`
  INSERT INTO ingest_rerun_audit (
    id,
    ingest_event_id,
    executed_at,
    mode,
    db_updated,
    preserve_observed_at,
    post_enabled,
    prior_process_status,
    prior_processing_error,
    original_observed_at,
    rerun_observed_at,
    outcome_status,
    outcome_error,
    result_event_type,
    result_filing_type,
    result_article_source_mode,
    result_confidence,
    reason_codes_json,
    review_reasons_json,
    latency_metrics_json,
    posted_messages_json,
    payload_json,
    created_at
  ) VALUES (
    @id,
    @ingest_event_id,
    @executed_at,
    @mode,
    @db_updated,
    @preserve_observed_at,
    @post_enabled,
    @prior_process_status,
    @prior_processing_error,
    @original_observed_at,
    @rerun_observed_at,
    @outcome_status,
    @outcome_error,
    @result_event_type,
    @result_filing_type,
    @result_article_source_mode,
    @result_confidence,
    @reason_codes_json,
    @review_reasons_json,
    @latency_metrics_json,
    @posted_messages_json,
    @payload_json,
    @created_at
  )
`);

const selectRecentRerunAuditEntries = db.prepare(`
  SELECT
    id,
    ingest_event_id,
    executed_at,
    mode,
    db_updated,
    preserve_observed_at,
    post_enabled,
    prior_process_status,
    prior_processing_error,
    original_observed_at,
    rerun_observed_at,
    outcome_status,
    outcome_error,
    result_event_type,
    result_filing_type,
    result_article_source_mode,
    result_confidence,
    reason_codes_json,
    review_reasons_json,
    latency_metrics_json,
    posted_messages_json,
    payload_json
  FROM ingest_rerun_audit
  WHERE (@ingest_event_id IS NULL OR ingest_event_id = @ingest_event_id)
  ORDER BY executed_at DESC
  LIMIT @limit
`);

function buildAuditId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

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

function recordIngestRerunAudit(entry) {
  const executedAt = toIsoString(new Date());
  insertRerunAuditEntry.run({
    id: buildAuditId("rerun"),
    ingest_event_id: cleanText(entry?.ingestEventId || "") || null,
    executed_at: executedAt,
    mode: cleanText(entry?.mode || "rerun") || "rerun",
    db_updated: entry?.dbUpdated ? 1 : 0,
    preserve_observed_at: entry?.preserveObservedAt ? 1 : 0,
    post_enabled: entry?.postEnabled ? 1 : 0,
    prior_process_status: cleanText(entry?.priorProcessStatus || "") || null,
    prior_processing_error: cleanText(entry?.priorProcessingError || "") || null,
    original_observed_at: entry?.originalObservedAt || null,
    rerun_observed_at: entry?.rerunObservedAt || null,
    outcome_status: cleanText(entry?.outcomeStatus || "unknown") || "unknown",
    outcome_error: cleanText(entry?.outcomeError || "") || null,
    result_event_type: cleanText(entry?.resultEventType || "") || null,
    result_filing_type: cleanText(entry?.resultFilingType || "") || null,
    result_article_source_mode: cleanText(entry?.resultArticleSourceMode || "") || null,
    result_confidence: Number.isFinite(Number(entry?.resultConfidence))
      ? Number(entry.resultConfidence)
      : null,
    reason_codes_json: jsonStringify(Array.isArray(entry?.reasonCodes) ? entry.reasonCodes : []),
    review_reasons_json: jsonStringify(Array.isArray(entry?.reviewReasons) ? entry.reviewReasons : []),
    latency_metrics_json: jsonStringify(entry?.latencyMetrics || null),
    posted_messages_json: jsonStringify(Array.isArray(entry?.postedMessages) ? entry.postedMessages : []),
    payload_json: jsonStringify(entry?.payload || null),
    created_at: executedAt
  });
}

function parseJsonArrayValue(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function parseJsonObjectValue(value) {
  try {
    const parsed = JSON.parse(value || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function buildCurrentIngestComparisonSummary(event) {
  const currentConfidence = normalizeOptionalNumber(event?.ai?.confidence);

  return {
    processStatus: event?.processStatus || null,
    articleSourceMode: event?.articleSourceMode || null,
    eventType: event?.eventType || null,
    filingType: event?.filingType || null,
    confidence: currentConfidence === null ? null : Number(currentConfidence.toFixed(2)),
    canDiluteToday: event?.canDiluteToday || null,
    earliestDilution: event?.earliestDilution || null,
    headline: event?.headline || null,
    summary: event?.summary || null,
    reasonCodes: Array.isArray(event?.reasonCodes) ? event.reasonCodes : [],
    latencyMetrics: event?.latencyMetrics || null,
    postedMessages: Array.isArray(event?.postedMessages) ? event.postedMessages : [],
    processingError: event?.processingError || null,
    updatedAt: event?.updatedAt || null
  };
}

function buildLatestRerunSummary(auditEntry) {
  if (!auditEntry) {
    return null;
  }

  const latestResult = auditEntry?.payload?.result || auditEntry?.payload?.currentAfter || {};
  const latestConfidence = normalizeOptionalNumber(latestResult.confidence);
  const fallbackConfidence = normalizeOptionalNumber(auditEntry.resultConfidence);
  return {
    auditId: auditEntry.id,
    executedAt: auditEntry.executedAt,
    outcomeStatus: auditEntry.outcomeStatus,
    mode: auditEntry.mode,
    dbUpdated: auditEntry.dbUpdated,
    postEnabled: auditEntry.postEnabled,
    articleSourceMode:
      cleanText(latestResult.articleSourceMode || auditEntry.resultArticleSourceMode || "") || null,
    eventType: cleanText(latestResult.eventType || auditEntry.resultEventType || "") || null,
    filingType: cleanText(latestResult.filingType || auditEntry.resultFilingType || "") || null,
    confidence: latestConfidence ?? fallbackConfidence,
    canDiluteToday: cleanText(latestResult.canDiluteToday || "") || null,
    earliestDilution: cleanText(latestResult.earliestDilution || "") || null,
    headline: cleanText(latestResult.headline || "") || null,
    summary: cleanText(latestResult.summary || "") || null,
    reasonCodes: Array.isArray(auditEntry.reasonCodes) ? auditEntry.reasonCodes : [],
    latencyMetrics: auditEntry.latencyMetrics || null,
    postedMessages: Array.isArray(auditEntry.postedMessages) ? auditEntry.postedMessages : []
  };
}

function findLatestSuccessfulPromotableRerun(ingestEventId) {
  const reruns = getRecentIngestRerunAuditEntries({
    ingestEventId,
    limit: 50
  });

  return (
    reruns.find(
      entry =>
        entry?.outcomeStatus === "succeeded" &&
        entry?.payload?.persistedResult &&
        typeof entry.payload.persistedResult === "object"
    ) || null
  );
}

function buildPromotionChangedFields(currentSummary, rerunSummary) {
  const comparisons = [
    ["processStatus", currentSummary?.processStatus, "processed"],
    ["articleSourceMode", currentSummary?.articleSourceMode, rerunSummary?.articleSourceMode],
    ["eventType", currentSummary?.eventType, rerunSummary?.eventType],
    ["filingType", currentSummary?.filingType, rerunSummary?.filingType],
    ["confidence", currentSummary?.confidence, rerunSummary?.confidence],
    ["canDiluteToday", currentSummary?.canDiluteToday, rerunSummary?.canDiluteToday],
    ["earliestDilution", currentSummary?.earliestDilution, rerunSummary?.earliestDilution],
    ["headline", currentSummary?.headline, rerunSummary?.headline],
    ["summary", currentSummary?.summary, rerunSummary?.summary],
    ["reasonCodes", currentSummary?.reasonCodes, rerunSummary?.reasonCodes],
    ["postedMessages", currentSummary?.postedMessages, rerunSummary?.postedMessages]
  ];

  return comparisons
    .filter(([_field, currentValue, nextValue]) => JSON.stringify(currentValue ?? null) !== JSON.stringify(nextValue ?? null))
    .map(([field]) => field);
}

function getRecentIngestRerunAuditEntries({ ingestEventId = null, limit = 20 } = {}) {
  const normalizedLimit = Math.max(1, Number(limit) || 20);
  const normalizedId = cleanText(ingestEventId || "") || null;
  const rows = selectRecentRerunAuditEntries.all({
    ingest_event_id: normalizedId,
    limit: normalizedLimit
  });

  return rows.map(row => ({
    id: String(row.id),
    ingestEventId: String(row.ingest_event_id),
    executedAt: row.executed_at || null,
    mode: cleanText(row.mode || "") || null,
    dbUpdated: Boolean(row.db_updated),
    preserveObservedAt: Boolean(row.preserve_observed_at),
    postEnabled: Boolean(row.post_enabled),
    priorProcessStatus: cleanText(row.prior_process_status || "") || null,
    priorProcessingError: cleanText(row.prior_processing_error || "") || null,
    originalObservedAt: row.original_observed_at || null,
    rerunObservedAt: row.rerun_observed_at || null,
    outcomeStatus: cleanText(row.outcome_status || "") || null,
    outcomeError: cleanText(row.outcome_error || "") || null,
    resultEventType: cleanText(row.result_event_type || "") || null,
    resultFilingType: cleanText(row.result_filing_type || "") || null,
    resultArticleSourceMode: cleanText(row.result_article_source_mode || "") || null,
    resultConfidence: Number.isFinite(Number(row.result_confidence))
      ? Number(row.result_confidence)
      : null,
    reasonCodes: parseJsonArrayValue(row.reason_codes_json),
    reviewReasons: parseJsonArrayValue(row.review_reasons_json),
    latencyMetrics: parseJsonObjectValue(row.latency_metrics_json),
    postedMessages: parseJsonArrayValue(row.posted_messages_json),
    payload: parseJsonObjectValue(row.payload_json)
  }));
}

function getIngestEventLatestRerunComparison(id) {
  const event = getIngestEventById(id);
  if (!event) {
    return null;
  }

  const latestRerun = getRecentIngestRerunAuditEntries({
    ingestEventId: event.id,
    limit: 1
  })[0] || null;

  return {
    ingestEventId: event.id,
    current: buildCurrentIngestComparisonSummary(event),
    latestRerun: buildLatestRerunSummary(latestRerun)
  };
}

function getIngestEventLatestSuccessfulRerunPromotionPreview(id) {
  const event = getIngestEventById(id);
  if (!event) {
    return null;
  }

  const latestSuccessfulRerun = findLatestSuccessfulPromotableRerun(event.id);
  const current = buildCurrentIngestComparisonSummary(event);
  const rerunSummary = buildLatestRerunSummary(latestSuccessfulRerun);
  const changedFields = rerunSummary ? buildPromotionChangedFields(current, rerunSummary) : [];

  return {
    ingestDatabasePath: INGEST_DATABASE_PATH,
    ingestEventId: event.id,
    canPromote: Boolean(latestSuccessfulRerun),
    current,
    latestSuccessfulRerun: latestSuccessfulRerun
      ? {
          ...rerunSummary,
          rerunObservedAt: latestSuccessfulRerun.rerunObservedAt || null,
          persistedResult: latestSuccessfulRerun.payload.persistedResult
        }
      : null,
    changedFields
  };
}

function promoteIngestEventFromLatestSuccessfulRerun(id) {
  const preview = getIngestEventLatestSuccessfulRerunPromotionPreview(id);
  if (!preview) {
    return null;
  }

  if (!preview.latestSuccessfulRerun?.persistedResult) {
    throw new Error(
      `No successful promotable rerun snapshot found for ingest event ${preview.ingestEventId}. Run rerun-ingest:v2 again first.`
    );
  }

  const currentEvent = getIngestEventById(preview.ingestEventId);
  const currentBefore = buildCurrentIngestComparisonSummary(currentEvent);
  recordProcessedEvent({
    ...preview.latestSuccessfulRerun.persistedResult,
    id: preview.ingestEventId
  });
  const currentAfterEvent = getIngestEventById(preview.ingestEventId);
  const currentAfter = buildCurrentIngestComparisonSummary(currentAfterEvent);

  recordIngestRerunAudit({
    ingestEventId: preview.ingestEventId,
    mode: "promote_latest_rerun",
    dbUpdated: true,
    preserveObservedAt: true,
    postEnabled: preview.latestSuccessfulRerun.postEnabled,
    priorProcessStatus: currentEvent?.processStatus || null,
    priorProcessingError: currentEvent?.processingError || null,
    originalObservedAt: currentEvent?.originalObservedAt || null,
    rerunObservedAt: preview.latestSuccessfulRerun.rerunObservedAt || null,
    outcomeStatus: "succeeded",
    resultEventType: preview.latestSuccessfulRerun.eventType || null,
    resultFilingType: preview.latestSuccessfulRerun.filingType || null,
    resultArticleSourceMode: preview.latestSuccessfulRerun.articleSourceMode || null,
    resultConfidence: Number.isFinite(Number(preview.latestSuccessfulRerun.confidence))
      ? Number(preview.latestSuccessfulRerun.confidence)
      : null,
    reasonCodes: Array.isArray(preview.latestSuccessfulRerun.reasonCodes)
      ? preview.latestSuccessfulRerun.reasonCodes
      : [],
    reviewReasons: Array.isArray(preview.latestSuccessfulRerun.persistedResult?.reviewQueueDecision?.reviewReasons)
      ? preview.latestSuccessfulRerun.persistedResult.reviewQueueDecision.reviewReasons
      : [],
    latencyMetrics: preview.latestSuccessfulRerun.latencyMetrics || null,
    postedMessages: Array.isArray(preview.latestSuccessfulRerun.persistedResult?.postedMessages)
      ? preview.latestSuccessfulRerun.persistedResult.postedMessages
      : [],
    payload: {
      action: "promote_latest_rerun",
      sourceAuditId: preview.latestSuccessfulRerun.auditId,
      changedFields: preview.changedFields,
      currentBefore,
      currentAfter
    }
  });

  return {
    ingestDatabasePath: INGEST_DATABASE_PATH,
    ingestEventId: preview.ingestEventId,
    promotedFromAuditId: preview.latestSuccessfulRerun.auditId,
    changedFields: preview.changedFields,
    currentBefore,
    currentAfter
  };
}

module.exports = {
  INGEST_DATABASE_PATH,
  recordObservedEvent,
  getIngestEventById,
  claimNextQueuedEvent,
  recordProcessedEvent,
  recordFailedEvent,
  scheduleQueuedRetry,
  recoverInterruptedQueuedEvents,
  getNextRetryDelayMs,
  getIngestQueueStatus,
  findRequeueCandidates,
  requeueIngestEvents,
  buildPersistableProcessedResultSnapshot,
  recordIngestRerunAudit,
  getRecentIngestRerunAuditEntries,
  getIngestEventLatestRerunComparison,
  getIngestEventLatestSuccessfulRerunPromotionPreview,
  promoteIngestEventFromLatestSuccessfulRerun,
  findRecentDuplicateContext,
  findRecentProcessedArticleAnalysis,
  getTrackedPostedMessages,
  recordWebsiteArticlePost,
  findRecentWebsiteArticlesForTicker,
  getBusinessDayCutoff
};
