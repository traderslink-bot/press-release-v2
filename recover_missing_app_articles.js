// Recover only alerts already delivered to Discord, without reposting there.
const Database = require("better-sqlite3");
const { INGEST_DATABASE_PATH } = require("./lib/config");
const { buildNewsArticlePayload, publishNewsArticle } = require("./lib/pipeline");
const { getIngestEventById, recordWebsiteArticlePost } = require("./lib/ingestStore");

async function main() {
  const args = process.argv.slice(2);
  const date = args[args.indexOf("--date") + 1];
  if (!args.includes("--date") || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    throw new Error("Use --date YYYY-MM-DD [--publish]; date is the UTC ingest date.");
  }
  const db = new Database(INGEST_DATABASE_PATH, { readonly: true });
  const after = args.includes("--after") ? args[args.indexOf("--after") + 1] : date;
  if (!after.startsWith(date) || !Number.isFinite(Date.parse(after))) throw new Error("--after must be a timestamp within --date");
  const rows = db.prepare(`
    SELECT e.id, e.article_text, e.article_source_mode
    FROM ingest_events e
    LEFT JOIN website_article_posts w ON w.ingest_event_id = e.id
    WHERE e.observed_at >= ? AND e.observed_at < ?
      AND w.ingest_event_id IS NULL
      AND length(trim(COALESCE(e.article_text, ''))) > 0
      AND COALESCE(json_extract(e.ai_json, '$.isFallback'), 1) = 0
      AND (
        json_extract(e.ai_json, '$.openaiUsage.operation') = 'summary'
        OR (
          json_extract(e.ai_json, '$.openaiUsage.operation') = 'url_fallback'
          AND json_extract(e.ai_json, '$.urlFallbackReadSucceeded') = 1
        )
      )
      AND json_valid(e.posted_messages_json)
      AND json_array_length(e.posted_messages_json) > 0
    ORDER BY e.observed_at
  `).all(after, new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10));
  db.close();
  for (const row of rows) {
    const data = getIngestEventById(row.id);
    if (!data?.ai) throw new Error(`Missing saved AI summary for ${row.id}`);
    const payload = buildNewsArticlePayload({
      data, ai: data.ai,
      articleText: row.article_text || "", articleSourceMode: row.article_source_mode,
      reasonCodes: data.reasonCodes, latencyMetrics: data.latencyMetrics
    });
    if (!args.includes("--publish")) {
      console.log(JSON.stringify({ id: data.id, ticker: data.ticker, route: data.routeTag, headline: payload.headline, publishedAt: payload.publishedAt }));
      continue;
    }
    const result = await publishNewsArticle(payload);
    if (!result?.articleUrl) throw new Error(`No app URL returned for ${data.id}`);
    const saved = recordWebsiteArticlePost({
      ingestEventId: data.id, ticker: data.ticker, articleUrl: result.articleUrl,
      articlePath: result.articlePath, title: payload.headline, eventType: payload.eventType,
      routeTag: data.routeTag, sourceUrl: data.articleLink,
      publishedAt: payload.publishedAt, observedAt: data.originalObservedAt
    });
    if (!saved) throw new Error(`Could not record app receipt for ${data.id}`);
    console.log(JSON.stringify({ ticker: data.ticker, route: data.routeTag, articleUrl: result.articleUrl }));
  }
  console.log(JSON.stringify({ candidates: rows.length, published: args.includes("--publish") }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
