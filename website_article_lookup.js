const {
  INGEST_DATABASE_PATH,
  findRecentWebsiteArticlesForTicker
} = require("./lib/ingestStore");

function parseArgs(argv) {
  const options = {
    ticker: "",
    businessDays: 5,
    limit: 10,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--ticker" && next) {
      options.ticker = next;
      i += 1;
      continue;
    }

    if (arg.startsWith("--ticker=")) {
      options.ticker = arg.replace(/^--ticker=/, "");
      continue;
    }

    if (arg === "--business-days" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.businessDays = parsed;
      }
      i += 1;
      continue;
    }

    if (arg.startsWith("--business-days=")) {
      const parsed = Number.parseInt(arg.replace(/^--business-days=/, ""), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.businessDays = parsed;
      }
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

    if (arg.startsWith("--limit=")) {
      const parsed = Number.parseInt(arg.replace(/^--limit=/, ""), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = parsed;
      }
      continue;
    }

    if (arg === "--json") {
      options.json = true;
    }
  }

  options.ticker = String(options.ticker || "").trim().toUpperCase();
  return options;
}

function printUsage() {
  console.error("Usage: node .\\website_article_lookup.js --ticker AAPL --json [--business-days 5] [--limit 10]");
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.ticker) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const result = findRecentWebsiteArticlesForTicker({
    ticker: options.ticker,
    businessDays: options.businessDays,
    limit: options.limit
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Ingest DB: ${INGEST_DATABASE_PATH}`);
  console.log(`Ticker: ${result.ticker}`);
  console.log(`Business days: ${result.businessDays}`);
  console.log(`Cutoff: ${result.cutoffPublishedAt}`);
  console.log(`Count: ${result.count}`);

  if (!result.articles.length) {
    console.log("No recent website articles found.");
    return;
  }

  for (const article of result.articles) {
    console.log(`${article.publishedAt} | ${article.title || "Untitled"} | ${article.url}`);
  }
}

run();
