const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "website-article-lookup-"));
const tempDbPath = path.join(tempDir, "ingest.sqlite");
process.env.INGEST_DATABASE_PATH = tempDbPath;

const {
  findRecentProcessedArticleAnalysis,
  findRecentWebsiteArticlesForTicker,
  getBusinessDayCutoff,
  recordObservedEvent,
  recordProcessedEvent,
  recordWebsiteArticlePost
} = require("./lib/ingestStore");

function iso(value) {
  return new Date(value).toISOString();
}

function record(overrides) {
  return recordWebsiteArticlePost({
    ingestEventId: overrides.ingestEventId,
    ticker: overrides.ticker || "AAPL",
    articleUrl: overrides.articleUrl || `https://traderslink.pro/news/${overrides.ingestEventId}`,
    articlePath: overrides.articlePath || `/news/${overrides.ingestEventId}`,
    title: overrides.title || `Title ${overrides.ingestEventId}`,
    eventType: overrides.eventType || "press_release",
    filingType: overrides.filingType || null,
    routeTag: overrides.routeTag || "default",
    sourceUrl: overrides.sourceUrl || "https://example.com/source",
    publishedAt: overrides.publishedAt,
    observedAt: overrides.observedAt || overrides.publishedAt
  });
}

const mondayCutoff = getBusinessDayCutoff({
  businessDays: 5,
  now: new Date("2026-06-22T12:00:00-04:00")
});
assert.strictEqual(
  mondayCutoff.toISOString(),
  new Date(2026, 5, 16).toISOString(),
  "Monday cutoff should include Monday plus the previous four weekdays"
);

const wednesdayNow = new Date("2026-06-24T12:00:00-04:00");
record({
  ingestEventId: "inside-window",
  title: "Inside Window",
  publishedAt: iso("2026-06-18T10:00:00-04:00")
});
record({
  ingestEventId: "outside-window",
  title: "Outside Window",
  publishedAt: iso("2026-06-17T10:00:00-04:00")
});
record({
  ingestEventId: "other-ticker",
  ticker: "MSFT",
  title: "Other Ticker",
  publishedAt: iso("2026-06-24T10:00:00-04:00")
});
assert.strictEqual(
  record({
    ingestEventId: "bad-nuntio",
    articleUrl: "https://news.nuntiobot.com/article/dfcd7d3c-094d-42e6-9622-192df5939503",
    title: "Bad Nuntio",
    publishedAt: iso("2026-06-24T10:00:00-04:00")
  }),
  false,
  "NuntioBot source links should never be tracked as website article links"
);
assert.strictEqual(
  record({
    ingestEventId: "bad-sec",
    articleUrl: "https://www.sec.gov/Archives/edgar/data/2029138/000121390026070184/0001213900-26-070184-index.htm",
    title: "Bad SEC",
    publishedAt: iso("2026-06-24T10:00:00-04:00")
  }),
  false,
  "SEC source links should never be tracked as website article links"
);

assert.strictEqual(
  record({
    ingestEventId: "inside-window",
    title: "Inside Window Updated",
    publishedAt: iso("2026-06-19T10:00:00-04:00")
  }),
  true,
  "Upsert should succeed for duplicate ingest ids"
);

const lookup = findRecentWebsiteArticlesForTicker({
  ticker: "aapl",
  businessDays: 5,
  limit: 10,
  now: wednesdayNow
});

assert.strictEqual(lookup.count, 1, "Only one AAPL row should remain inside the 5-business-day window");
assert.strictEqual(lookup.articles[0].title, "Inside Window Updated");
assert.strictEqual(lookup.articles[0].url, "https://traderslink.pro/news/inside-window");
assert.ok(
  lookup.articles.every(article => article.url.includes("traderslink.pro")),
  "Lookup should only return TradersLink website URLs"
);
assert.ok(
  lookup.articles.every(article => !Object.prototype.hasOwnProperty.call(article, "sourceUrl")),
  "Lookup output should not expose sourceUrl"
);

const sharedSourceUrl = "https://news.nuntiobot.com/article/shared-iqst-release";
record({
  ingestEventId: "iqst-market-cap",
  ticker: "IQST",
  routeTag: "market_cap_under_30m",
  sourceUrl: sharedSourceUrl,
  articleUrl: "https://traderslink.pro/news/IQST/market-cap-copy",
  title: "Market-cap AI rewrite",
  publishedAt: iso("2026-06-24T10:00:01-04:00")
});
record({
  ingestEventId: "iqst-spike",
  ticker: "IQST",
  routeTag: "spike",
  sourceUrl: sharedSourceUrl,
  articleUrl: "https://traderslink.pro/news/IQST/canonical-paid-copy",
  title: "Canonical paid headline",
  publishedAt: iso("2026-06-24T10:00:02-04:00")
});
const iqstLookup = findRecentWebsiteArticlesForTicker({
  ticker: "IQST",
  businessDays: 5,
  limit: 10,
  now: wednesdayNow
});
assert.strictEqual(iqstLookup.count, 1, "Same-source route copies should collapse to one article");
assert.strictEqual(iqstLookup.articles[0].routeTag, "spike");
assert.strictEqual(
  iqstLookup.articles[0].url,
  "https://traderslink.pro/news/IQST/canonical-paid-copy",
  "Paid/spike article should be canonical when the same source reached a market-cap route"
);

recordObservedEvent({
  id: "processed-source-event",
  ticker: "IQST",
  routeTag: "market_cap_under_30m",
  articleLink: sharedSourceUrl,
  rawText: "IQST shared release"
});
recordProcessedEvent({
  id: "processed-source-event",
  headline: "Reusable canonical analysis",
  summary: "One AI result should serve every route.",
  eventType: "press_release",
  articleSourceMode: "fetched_direct",
  ai: {
    headline: "Reusable canonical analysis",
    summary: "One AI result should serve every route.",
    eventType: "press_release"
  },
  articleText: "Shared article body",
  postedMessages: []
});
const reusableAnalysis = findRecentProcessedArticleAnalysis({
  id: "later-spike-event",
  articleLink: sharedSourceUrl
});
assert.strictEqual(reusableAnalysis.ai.headline, "Reusable canonical analysis");
assert.strictEqual(reusableAnalysis.articleText, "Shared article body");

recordObservedEvent({
  id: "stored-analysis-event",
  ticker: "SUMM",
  routeTag: "spike",
  articleLink: "https://example.com/stored-analysis",
  rawText: "SUMM stored analysis"
});
recordProcessedEvent({
  id: "stored-analysis-event",
  headline: "Stored analysis headline",
  summary: "Stored factual summary.",
  positives: ["Stored positive point."],
  negatives: ["Stored negative point."],
  eventType: "press_release",
  articleSourceMode: "fetched_direct",
  ai: {
    headline: "Stored analysis headline",
    summary: "Stored factual summary.",
    positives: ["Stored positive point."],
    negatives: ["Stored negative point."],
    eventType: "press_release"
  },
  articleText: "Stored article body",
  postedMessages: []
});
record({
  ingestEventId: "stored-analysis-event",
  ticker: "SUMM",
  title: "Stored analysis headline",
  articleUrl: "https://traderslink.pro/news/stored-analysis",
  sourceUrl: "https://example.com/stored-analysis",
  publishedAt: iso("2026-06-24T10:00:00-04:00")
});
const storedAnalysisLookup = findRecentWebsiteArticlesForTicker({
  ticker: "SUMM",
  businessDays: 5,
  limit: 10,
  now: wednesdayNow
});
assert.strictEqual(storedAnalysisLookup.articles[0].summary, "Stored factual summary.");
assert.deepStrictEqual(storedAnalysisLookup.articles[0].positives, ["Stored positive point."]);
assert.deepStrictEqual(storedAnalysisLookup.articles[0].negatives, ["Stored negative point."]);

const unknown = findRecentWebsiteArticlesForTicker({
  ticker: "ZZZZ",
  businessDays: 5,
  now: wednesdayNow
});
assert.strictEqual(unknown.count, 0);
assert.deepStrictEqual(unknown.articles, []);

record({
  ingestEventId: "cli-current-window",
  title: "CLI Current Window",
  publishedAt: new Date().toISOString()
});

const cliResult = spawnSync(
  process.execPath,
  [path.join(__dirname, "website_article_lookup.js"), "--ticker", "AAPL", "--json"],
  {
    cwd: __dirname,
    env: {
      ...process.env,
      INGEST_DATABASE_PATH: tempDbPath
    },
    encoding: "utf8"
  }
);
assert.strictEqual(cliResult.status, 0, cliResult.stderr);
const cliJson = JSON.parse(cliResult.stdout);
assert.strictEqual(cliJson.ticker, "AAPL");
assert.ok(cliJson.count >= 1);
assert.ok(
  cliJson.articles.some(article => article.title === "CLI Current Window"),
  "CLI output should include the current AAPL article"
);

const missingTickerResult = spawnSync(
  process.execPath,
  [path.join(__dirname, "website_article_lookup.js"), "--json"],
  {
    cwd: __dirname,
    env: {
      ...process.env,
      INGEST_DATABASE_PATH: tempDbPath
    },
    encoding: "utf8"
  }
);
assert.notStrictEqual(missingTickerResult.status, 0);
assert.match(missingTickerResult.stderr, /Usage:/);

console.log("website_article_lookup_smoke_test passed");
