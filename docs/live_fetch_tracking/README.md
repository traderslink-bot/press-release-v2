# Live Fetch Tracking

This folder is the review point for live article-fetch behavior.

Main runtime log:

- `live_events.jsonl`
- `review_queue.jsonl`

That file is written automatically during live runs and records article-fetch events such as:

- direct fetch attempts
- direct fetch failures
- status codes by domain
- Nuntio cooldown events
- OpenAI URL fallback usage
- final article source resolution mode

`review_queue.jsonl` is written automatically for suspicious live cases such as:

- high wrapper-risk SEC selections
- fallback-driven summaries
- low-confidence results
- short or wrapper-like selected documents
- low-signal / awareness-style press releases

Most useful values to watch:

- `hostname`
- `url`
- `kind`
- `status`
- `articleSourceMode`
- `directFetchError`
- `openaiUrlFallbackError`

Typical `articleSourceMode` values:

- `fetched_direct`
- `openai_url_fallback`
- `headline_only_fallback`
- `sec_unreadable_fallback`

Important live-output note:

- even when `articleSourceMode` is `openai_url_fallback` or `headline_only_fallback`, the current live Discord formatter for non-SEC posts suppresses user-facing disclosure phrases such as:
  - `Article text unavailable; summary based on raw Discord metadata.`
  - `Full article text unavailable ...`

So the fetch logs / DB remain the source of truth for fallback diagnosis, not the live Discord wording.

Most useful review queue values:

- `ticker`
- `routeTag`
- `reviewReasons`
- `reasonCodes`
- `selectedDocumentKind`
- `selectedDocumentType`
- `wrapperRiskLevel`
- `signalQuality`
- `signalFlags`
- `latencyMetrics`
- `duplicateDiagnostics`

Review queue helper:

- `node .\review_queue_viewer.js`
- `node .\review_queue_summary.js`

Useful filters:

- `node .\review_queue_viewer.js --last 25`
- `node .\review_queue_viewer.js --ticker CMND`
- `node .\review_queue_viewer.js --reason wrapper_risk_high`
- `node .\review_queue_viewer.js --route spike`
- `node .\review_queue_viewer.js --json`
- `node .\review_queue_summary.js --last 100`
- `node .\review_queue_summary.js --json`

Useful latency values:

- `latencyMetrics.queueDelayMs`
- `latencyMetrics.fetchMs`
- `latencyMetrics.aiMs`
- `latencyMetrics.levelsMs`
- `latencyMetrics.postMs`
- `latencyMetrics.totalProcessingMs`

Current runtime resilience additions:

- delayed requeue for retryable OpenAI failures
- supervisor restart loop for the live Discord bot
- watcher heartbeat checks
- periodic rescans of visible host-channel messages
- long-idle warnings when no host messages have been detected for an unusual amount of time

Useful duplicate values:

- `duplicateDiagnostics.isRecentDuplicate`
- `duplicateDiagnostics.recentDuplicateCount`
- `duplicateDiagnostics.duplicateGroupKey`

This folder is intentionally inside `docs` so it is easy to inspect after market sessions, but the runtime `.jsonl` log is ignored by git.
