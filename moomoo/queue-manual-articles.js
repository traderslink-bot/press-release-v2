const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  MOOMOO_DIR,
  cleanText,
  ensureDir,
  normalizeTicker,
  readJsonFile
} = require("./queue");
const { enqueueMoomooDraft } = require("./pipelineQueue");
const { scheduleMoomooOneShotWorkerForDraft } = require("./workerLauncher");

const MANUAL_DIR = path.join(MOOMOO_DIR, "manual-articles");
const DEFAULT_SCHEDULE_FILE = path.join(MANUAL_DIR, "schedule.json");
const DEFAULT_TOP_GAINERS_FILE = path.join(MANUAL_DIR, "top-gainers.json");
const DEFAULT_SOURCE = "manual_article";
const DEFAULT_PREFLIGHT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 60 * 1000;
const STOCKANALYSIS_GAINERS_URL = "https://stockanalysis.com/markets/gainers/";

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseArgs(argv) {
  const args = {
    once: false,
    scheduleFile: process.env.MOOMOO_MANUAL_ARTICLE_SCHEDULE_FILE || DEFAULT_SCHEDULE_FILE,
    topGainersFile: process.env.MOOMOO_TOP_GAINERS_FILE || DEFAULT_TOP_GAINERS_FILE,
    preflightMs: numberFromEnv("MOOMOO_MANUAL_ARTICLE_PREFLIGHT_MS", DEFAULT_PREFLIGHT_MS),
    pollMs: numberFromEnv("MOOMOO_MANUAL_ARTICLE_POLL_MS", DEFAULT_POLL_MS),
    dryRun: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") {
      args.once = true;
    } else if (arg === "--schedule-file") {
      args.scheduleFile = argv[index + 1] || args.scheduleFile;
      index += 1;
    } else if (arg === "--top-gainers-file") {
      args.topGainersFile = argv[index + 1] || args.topGainersFile;
      index += 1;
    } else if (arg === "--preflight-ms") {
      args.preflightMs = Number(argv[index + 1] || args.preflightMs);
      index += 1;
    } else if (arg === "--poll-ms") {
      args.pollMs = Number(argv[index + 1] || args.pollMs);
      index += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    }
  }

  args.scheduleFile = path.resolve(args.scheduleFile);
  args.topGainersFile = path.resolve(args.topGainersFile);
  if (!Number.isFinite(args.preflightMs) || args.preflightMs < 0) args.preflightMs = DEFAULT_PREFLIGHT_MS;
  if (!Number.isFinite(args.pollMs) || args.pollMs < 5000) args.pollMs = DEFAULT_POLL_MS;
  return args;
}

function normalizeSchedule(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.posts)) return raw.posts;
  return [];
}

function parseScheduledAt(value) {
  const text = cleanText(value || "");
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date : null;
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function extractTextFromDocx(filePath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "moomoo-docx-"));
  const tempZip = path.join(tempDir, "article.zip");
  try {
    fs.copyFileSync(filePath, tempZip);
    const expandedDir = path.join(tempDir, "expanded");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "& { param($zipPath, $destinationPath) Expand-Archive -LiteralPath $zipPath -DestinationPath $destinationPath -Force }",
      tempZip,
      expandedDir
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(cleanText(result.stderr || result.stdout || "PowerShell Expand-Archive failed"));
    }

    const documentXml = path.join(expandedDir, "word", "document.xml");
    if (!fs.existsSync(documentXml)) {
      throw new Error("word/document.xml not found in docx");
    }

    const xml = fs.readFileSync(documentXml, "utf8");
    const paragraphs = [...xml.matchAll(/<w:p[\s\S]*?<\/w:p>/g)].map(match => {
      const paragraphXml = match[0]
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<w:br\/>/g, "\n")
        .replace(/<w:br [^>]*\/>/g, "\n");
      const runs = [...paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
        .map(textMatch => decodeXmlText(textMatch[1]))
        .join("");
      return cleanText(runs);
    }).filter(Boolean);

    return paragraphs.join("\n\n").trim();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function readArticleFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".docx") return extractTextFromDocx(filePath);
  return fs.readFileSync(filePath, "utf8").trim();
}

function extractArticleTitleAndBody(filePath, configuredTitle) {
  const raw = readArticleFile(filePath).trim();
  if (!raw) return { title: cleanText(configuredTitle || ""), body: "" };

  const lines = raw.split(/\r?\n/);
  const firstNonEmptyIndex = lines.findIndex(line => cleanText(line));
  let title = cleanText(configuredTitle || "");
  let body = raw;

  if (!title && firstNonEmptyIndex >= 0) {
    const first = lines[firstNonEmptyIndex].trim();
    title = cleanText(first.replace(/^#{1,3}\s+/, ""));
    lines.splice(firstNonEmptyIndex, 1);
    body = lines.join("\n").trim();
  }

  return {
    title,
    body
  };
}

function extractTopGainerRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.tickers)) return raw.tickers;
  if (Array.isArray(raw?.gainers)) return raw.gainers;
  if (Array.isArray(raw?.topGainers)) return raw.topGainers;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

function rowTicker(row) {
  if (typeof row === "string") return normalizeTicker(row);
  return normalizeTicker(row?.ticker || row?.symbol || row?.code);
}

function rowRankValue(row, fallbackIndex) {
  if (typeof row === "string") return fallbackIndex;
  const candidates = [
    row?.rank,
    row?.percentChange,
    row?.changePercent,
    row?.changePct,
    row?.gainPercent,
    row?.gain,
    row?.change
  ].map(Number).filter(Number.isFinite);
  if (!candidates.length) return fallbackIndex;
  if (Number.isFinite(Number(row?.rank))) return Number(row.rank) * -1;
  return Math.max(...candidates);
}

function loadTopGainerTickers(filePath, count = 3) {
  const raw = readJsonFile(filePath, null);
  const rows = extractTopGainerRows(raw);
  const ranked = rows
    .map((row, index) => ({
      ticker: rowTicker(row),
      rankValue: rowRankValue(row, index)
    }))
    .filter(row => row.ticker)
    .sort((a, b) => b.rankValue - a.rankValue);

  const tickers = [];
  for (const row of ranked) {
    if (!tickers.includes(row.ticker)) tickers.push(row.ticker);
    if (tickers.length >= count) break;
  }
  return tickers;
}

function decodeHtmlText(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function parseStockAnalysisGainerRows(html) {
  const rows = [];
  const rowMatches = String(html || "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const match of rowMatches) {
    const rowHtml = match[1];
    const symbolMatch = rowHtml.match(/<td[^>]*class=["'][^"']*\bsym\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
    const percentMatch = rowHtml.match(/<td[^>]*class=["'][^"']*\brg\b[^"']*["'][^>]*>\s*([^<]+?)\s*<\/td>/i);
    const rankMatch = rowHtml.match(/<td[^>]*>\s*(\d+)\s*<\/td>/i);
    const ticker = normalizeTicker(decodeHtmlText(symbolMatch?.[1] || ""));
    const percentText = decodeHtmlText(percentMatch?.[1] || "").replace(/[%+,]/g, "").trim();
    const percentChange = Number(percentText);
    const rank = Number(rankMatch?.[1]);
    if (ticker) rows.push({ ticker, percentChange, rank });
  }
  return rows;
}

async function fetchStockAnalysisTopGainerTickers(count = 3, url = STOCKANALYSIS_GAINERS_URL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "TraderLink-Moomoo-Manual-Queue/1.0"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`StockAnalysis returned HTTP ${response.status}`);
    const rows = parseStockAnalysisGainerRows(await response.text());
    const tickers = loadTopGainerTickersFromRows(rows, count);
    if (tickers.length < count) throw new Error(`StockAnalysis page yielded only ${tickers.length} valid gainer symbols`);
    return { tickers, rows, url };
  } finally {
    clearTimeout(timeout);
  }
}

function loadTopGainerTickersFromRows(rows, count = 3) {
  const ranked = rows
    .map((row, index) => ({
      ticker: rowTicker(row),
      rankValue: Number.isFinite(Number(row?.rank)) ? Number(row.rank) * -1 : rowRankValue(row, index)
    }))
    .filter(row => row.ticker)
    .sort((a, b) => b.rankValue - a.rankValue);
  const tickers = [];
  for (const row of ranked) {
    if (!tickers.includes(row.ticker)) tickers.push(row.ticker);
    if (tickers.length >= count) break;
  }
  return tickers;
}

async function resolveTopGainerTickers(filePath, count = 3) {
  const live = await fetchStockAnalysisTopGainerTickers(count);
  return { ...live, source: STOCKANALYSIS_GAINERS_URL };
}

function manualArticleNeedsTopGainers(item) {
  if (item?.topGainers === true) return true;
  if (item?.topGainers?.enabled === true) return true;
  return cleanText(item?.ticker || "").toLowerCase() === "top_gainers";
}

function articleFilePath(scheduleFile, fileName) {
  const text = cleanText(fileName || "");
  if (!text) return "";
  if (path.isAbsolute(text)) return text;
  return path.resolve(path.dirname(scheduleFile), text);
}

function shouldQueueNow(scheduledAt, preflightMs, now = new Date()) {
  const dueMs = scheduledAt.getTime();
  const nowMs = now.getTime();
  return nowMs >= dueMs - preflightMs;
}

function processScheduleOnce(args, now = new Date()) {
  return processScheduleOnceInternal(args, now, false);
}

async function processScheduleOnceAsync(args, now = new Date()) {
  return processScheduleOnceInternal(args, now, true);
}

async function processScheduleOnceInternal(args, now = new Date(), allowLiveTopGainerFetch) {
  ensureDir(MANUAL_DIR);
  const schedule = normalizeSchedule(readJsonFile(args.scheduleFile, []));
  const results = [];

  for (const item of schedule) {
    const id = cleanText(item?.id || "");
    const scheduledAt = parseScheduledAt(item?.scheduledAt);
    const source = cleanText(item?.source || DEFAULT_SOURCE);
    const topGainerMode = manualArticleNeedsTopGainers(item);
    const preflightMs = Number(item?.preflightMs ?? args.preflightMs);

    if (!id) {
      results.push({ ok: false, skipped: true, reason: "missing id" });
      continue;
    }
    if (!scheduledAt) {
      results.push({ ok: false, skipped: true, id, reason: "missing or invalid scheduledAt" });
      continue;
    }
    if (!shouldQueueNow(scheduledAt, Number.isFinite(preflightMs) ? preflightMs : args.preflightMs, now)) {
      results.push({ ok: true, skipped: true, id, reason: "not inside preflight window", scheduledAt: scheduledAt.toISOString() });
      continue;
    }

    const filePath = articleFilePath(args.scheduleFile, item?.file);
    if (!filePath || !fs.existsSync(filePath)) {
      results.push({ ok: false, skipped: true, id, reason: `article file not found: ${filePath || "(missing)"}` });
      continue;
    }

    const tickerCount = Number(item?.topGainers?.count || item?.tickerCount || 3);
    const topGainerCount = Number.isFinite(tickerCount) && tickerCount > 0 ? tickerCount : 3;
    let topGainerResolution = null;
    if (topGainerMode && allowLiveTopGainerFetch) {
      try {
        topGainerResolution = await resolveTopGainerTickers(args.topGainersFile, topGainerCount);
      } catch (error) {
        results.push({ ok: false, skipped: true, id, reason: `daily StockAnalysis gainers unavailable: ${error.message}` });
        continue;
      }
    }
    const tickers = topGainerMode
      ? (topGainerResolution?.tickers || loadTopGainerTickers(path.resolve(item?.topGainers?.file || args.topGainersFile), topGainerCount))
      : [item?.ticker, ...(Array.isArray(item?.tickers) ? item.tickers : [])].map(value => normalizeTicker(value)).filter(Boolean);

    const uniqueTickers = [...new Set(tickers)].slice(0, topGainerMode ? 3 : Math.max(1, tickers.length));
    if (topGainerMode && uniqueTickers.length < 3) {
      results.push({ ok: false, skipped: true, id, reason: `top gainers file has only ${uniqueTickers.length} valid ticker(s)` });
      continue;
    }
    if (!uniqueTickers.length) {
      results.push({ ok: false, skipped: true, id, reason: "missing ticker(s)" });
      continue;
    }

    const article = extractArticleTitleAndBody(filePath, item?.title);
    const articleTitle = cleanText(item?.title || article.title || "");
    if (!articleTitle) {
      results.push({ ok: false, skipped: true, id, reason: "article title is empty" });
      continue;
    }

    if (args.dryRun) {
      results.push({
        ok: true,
        dryRun: true,
        id,
        ticker: uniqueTickers[0],
        tickers: uniqueTickers,
        title: articleTitle,
        scheduledAt: scheduledAt.toISOString(),
        source,
        topGainerSource: topGainerResolution?.source
      });
      continue;
    }

    const queued = enqueueMoomooDraft({
      id,
      ticker: uniqueTickers[0],
      tickers: uniqueTickers,
      title: articleTitle,
      summary: article.body,
      scheduledAt: scheduledAt.toISOString(),
      source
    });
    if (queued.ok) {
      queued.workerStart = scheduleMoomooOneShotWorkerForDraft({
        ...queued,
        source,
        sourceFilter: source
      });
    }
    results.push({ ...queued, topGainerSource: topGainerResolution?.source, topGainerWarning: topGainerResolution?.warning });
  }

  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  do {
    const results = await processScheduleOnceAsync(args);
    console.log(JSON.stringify({
      ok: true,
      ts: new Date().toISOString(),
      scheduleFile: args.scheduleFile,
      topGainersFile: args.topGainersFile,
      once: args.once,
      results
    }, null, 2));
    if (args.once) break;
    await sleep(args.pollMs);
  } while (true);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  loadTopGainerTickers,
  loadTopGainerTickersFromRows,
  parseStockAnalysisGainerRows,
  fetchStockAnalysisTopGainerTickers,
  resolveTopGainerTickers,
  processScheduleOnce,
  processScheduleOnceAsync,
  extractTextFromDocx,
  parseArgs
};
