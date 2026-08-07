const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");
const {
  DEFAULT_HISTORY_FILE,
  MOOMOO_DIR,
  buildMessage,
  loadQueue,
  readHistory,
  saveQueue,
  selectNextDuePost,
  withQueueLock
} = require("./queue");
const {
  buildMoomooMessage,
  enqueueMoomooDraft,
  queueIdForSource
} = require("./pipelineQueue");
const {
  buildComposerBody,
  buildComposerTitle
} = require("./automator");
const {
  scheduleMoomooOneShotWorkerForDraft
} = require("./workerLauncher");
const {
  loadTopGainerTickers,
  parseStockAnalysisGainerRows,
  processScheduleOnce
} = require("./queue-manual-articles");
const {
  buildTaskDefinitions
} = require("./install-manual-article-tasks");

const tempQueue = path.join(MOOMOO_DIR, "qa-temp-posts.json");
const tempManualDir = path.join(MOOMOO_DIR, "qa-temp-manual-articles");
process.env.MOOMOO_QUEUE_FILE = tempQueue;
process.env.MOOMOO_MAX_LENGTH = "240";
process.env.MOOMOO_MIN_POST_INTERVAL_MS = "0";
process.env.MOOMOO_AUTOSTART_WORKER_ENABLED = "false";

function cleanup() {
  for (const file of [tempQueue, `${tempQueue}.lock`, `${tempQueue}.tmp`]) {
    fs.rmSync(file, { force: true });
  }
  fs.rmSync(tempManualDir, { recursive: true, force: true });
}

function writeTextFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function createMinimalDocx(filePath, paragraphs) {
  const sourceDir = path.join(tempManualDir, "docx-source");
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(sourceDir, "_rels"), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, "word"), { recursive: true });
  writeTextFile(path.join(sourceDir, "[Content_Types].xml"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
    "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
    "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
    "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>",
    "</Types>"
  ].join(""));
  writeTextFile(path.join(sourceDir, "_rels", ".rels"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>",
    "</Relationships>"
  ].join(""));
  writeTextFile(path.join(sourceDir, "word", "document.xml"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>",
    paragraphs.map(text => `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`).join(""),
    "</w:body></w:document>"
  ].join(""));

  fs.rmSync(filePath, { force: true });
  const zipPath = `${filePath}.zip`;
  fs.rmSync(zipPath, { force: true });
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "& { param($sourceDir, $docxPath) Compress-Archive -Path (Join-Path $sourceDir '*') -DestinationPath $docxPath -Force }",
    sourceDir,
    zipPath
  ], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, `minimal docx fixture was created: ${result.stderr || result.stdout}`);
  fs.renameSync(zipPath, filePath);
}

async function main() {
  cleanup();
  saveQueue([], tempQueue);

  const message = buildMoomooMessage({
    ticker: "AAPL",
    title: "Apple announces a long headline ".repeat(8),
    summary: "Summary ".repeat(100)
  });
  assert(message.startsWith("$AAPL "), "message starts with cashtag");
  assert(message.length <= 240, "message respects configured max length");

  const multiTickerMessage = buildMoomooMessage({
    ticker: "AAA",
    tickers: ["BBB", "CCC"],
    title: "Top gainer setup",
    summary: "Manual article body"
  });
  assert(multiTickerMessage.startsWith("$AAA $BBB $CCC "), "manual top-gainer message starts with three cashtags");
  assert.strictEqual(queueIdForSource("manual_article", "qa-manual"), "manual_article-qa-manual", "manual article queue ids are source-aware");
  assert.strictEqual(
    buildComposerTitle({
      ticker: "AAPL",
      title: "$AAPL Apple announces a long headline ".repeat(12),
      message
    }).length,
    200,
    "composer title is capped at moomoo title limit"
  );
  assert(
    !buildComposerTitle({ ticker: "AAPL", title: "$AAPL Apple title", message }).startsWith("$AAPL"),
    "moomoo composer title does not use a plain cashtag"
  );
  assert.strictEqual(
    buildComposerBody({ ticker: "AAPL", title: "Title", summary: "AI summary", message: "$AAPL Title\n\nAI summary" }),
    "AI summary",
    "composer body prefers summary"
  );

  const first = enqueueMoomooDraft({
    id: "qa-1",
    ticker: "AAPL",
    title: "Apple test title",
    summary: "AI summary ".repeat(80),
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    source: "press_release_v2"
  });
  assert.strictEqual(first.ok, true, "first enqueue succeeds");
  assert.strictEqual(first.truncatedSummary, true, "long summary is truncated instead of failing");
  assert.strictEqual(
    scheduleMoomooOneShotWorkerForDraft(first).reason,
    "autostart disabled",
    "moomoo one-shot autostart can be disabled without launching a browser"
  );

  const duplicate = enqueueMoomooDraft({
    id: "qa-1",
    ticker: "AAPL",
    title: "Apple test title",
    summary: "AI summary",
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    source: "press_release_v2"
  });
  assert.strictEqual(duplicate.skipped, true, "duplicate enqueue is skipped");

  withQueueLock(tempQueue, () => {
    const rows = loadQueue(tempQueue);
    rows.push({
      id: "pr-v2-qa-skipped",
      ticker: "NVDA",
      message: "$NVDA Old skipped item",
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      status: "skipped",
      postedAt: "",
      error: "qa skipped row",
      source: "press_release_v2"
    });
    saveQueue(rows, tempQueue);
  });

  const replayedSkippedId = enqueueMoomooDraft({
    id: "qa-skipped",
    ticker: "NVDA",
    title: "A different title for the same source event",
    summary: "A different summary",
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    source: "press_release_v2"
  });
  assert.strictEqual(replayedSkippedId.skipped, true, "same source id is not requeued after a skipped row");

  withQueueLock(tempQueue, () => {
    const rows = loadQueue(tempQueue);
    rows.push({
      id: "manual-1",
      ticker: "MSFT",
      message: "$MSFT Manual item",
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      status: "pending",
      postedAt: "",
      error: "",
      source: "manual"
    });
    rows.push({
      id: "manual-1-duplicate",
      ticker: "MSFT",
      message: "$MSFT Manual item",
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      status: "pending",
      postedAt: "",
      error: "",
      source: "manual"
    });
    saveQueue(rows, tempQueue);
  });

  const rows = loadQueue(tempQueue);
  const liveSelection = selectNextDuePost(rows, readHistory(DEFAULT_HISTORY_FILE), new Date(), {
    maxLength: 240,
    minPostIntervalMs: 0,
    sourceFilter: "press_release_v2"
  });
  assert.strictEqual(liveSelection.validation.ticker, "AAPL", "source filter selects live item");

  const manualSelection = selectNextDuePost(rows, readHistory(DEFAULT_HISTORY_FILE), new Date(), {
    maxLength: 240,
    minPostIntervalMs: 0,
    sourceFilter: "manual"
  });
  assert.strictEqual(manualSelection.validation.ticker, "MSFT", "source filter selects manual item");

  const manualDuplicateSelection = selectNextDuePost(rows.slice(2), readHistory(DEFAULT_HISTORY_FILE), new Date(), {
    maxLength: 240,
    minPostIntervalMs: 0,
    sourceFilter: "manual"
  });
  assert.strictEqual(manualDuplicateSelection.validation.ticker, "MSFT", "first duplicate pair item remains eligible");

  const postedThenDuplicate = rows.slice(2).map(row => ({ ...row }));
  postedThenDuplicate[0].status = "posted";
  postedThenDuplicate[0].postedAt = new Date().toISOString();
  const duplicateAfterPostedSelection = selectNextDuePost(postedThenDuplicate, readHistory(DEFAULT_HISTORY_FILE), new Date(), {
    maxLength: 240,
    minPostIntervalMs: 0,
    sourceFilter: "manual"
  });
  assert.strictEqual(duplicateAfterPostedSelection.post, null, "pending duplicate is skipped after first copy posts");
  assert.strictEqual(
    duplicateAfterPostedSelection.skipped[0].reason,
    "duplicate id/message hash in queue",
    "duplicate skip reason is explicit"
  );

  const built = buildMessage({ ticker: "TSLA", title: "Title", summary: "Summary" });
  assert.strictEqual(built, "$TSLA Title\n\nSummary", "queue buildMessage fallback format");

  const builtMulti = buildMessage({ ticker: "AAA", tickers: ["BBB", "CCC"], title: "Title", summary: "Summary" });
  assert.strictEqual(builtMulti, "$AAA $BBB $CCC Title\n\nSummary", "queue buildMessage supports multiple ticker tags");

  fs.mkdirSync(path.join(tempManualDir, "articles"), { recursive: true });
  const topGainersFile = path.join(tempManualDir, "top-gainers.json");
  fs.writeFileSync(topGainersFile, JSON.stringify([
    { ticker: "THIRD", percentChange: 12 },
    { ticker: "FIRST", percentChange: 44 },
    { ticker: "SECOND", percentChange: 20 },
    { ticker: "FOURTH", percentChange: 5 }
  ], null, 2), "utf8");
  assert.deepStrictEqual(
    loadTopGainerTickers(topGainersFile, 3),
    ["FIRST", "SECOND", "THIRD"],
    "top-gainer resolver selects the top three symbols"
  );
  assert.deepStrictEqual(
    parseStockAnalysisGainerRows('<table><tbody><tr><td>1</td><td class="sym"><a href="/stocks/aaa/">AAA</a></td><td class="rg">125.40%</td></tr><tr><td>2</td><td class="sym"><a href="/stocks/bbb/">BBB</a></td><td class="rg">80.10%</td></tr></tbody></table>'),
    [
      { ticker: "AAA", percentChange: 125.4, rank: 1 },
      { ticker: "BBB", percentChange: 80.1, rank: 2 }
    ],
    "StockAnalysis gainers table parser reads ranked symbols and percent changes"
  );

  const articleFile = path.join(tempManualDir, "articles", "qa-note.docx");
  createMinimalDocx(articleFile, [
    "QA Manual Note",
    "This is a manual moomoo article body from a Word docx for a three ticker dry-run."
  ]);
  const scheduleFile = path.join(tempManualDir, "schedule.json");
  fs.writeFileSync(scheduleFile, JSON.stringify({
    posts: [{
      id: "qa-manual-note",
      file: "articles/qa-note.docx",
      scheduledAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      topGainers: {
        enabled: true,
        count: 3,
        file: topGainersFile
      }
    }]
  }, null, 2), "utf8");
  const dryManual = await processScheduleOnce({
    scheduleFile,
    topGainersFile,
    preflightMs: 10 * 60 * 1000,
    dryRun: true
  });
  assert.strictEqual(dryManual[0].dryRun, true, "manual article scheduler can dry-run without browser work");
  assert.deepStrictEqual(dryManual[0].tickers, ["FIRST", "SECOND", "THIRD"], "manual article scheduler resolves three top-gainer tags");

  const taskDefinitions = buildTaskDefinitions({
    scheduleFile,
    topGainersFile,
    preflightMs: 60 * 1000
  }, new Date(Date.now() - 60 * 1000));
  assert.strictEqual(taskDefinitions.length, 1, "manual task preview finds one scheduled article");
  assert.strictEqual(taskDefinitions[0].valid, true, "manual task preview marks future task valid");
  assert(taskDefinitions[0].taskName.includes("qa-manual-note"), "manual task name includes the article id");

  const statusCheck = spawnSync(process.execPath, [path.join(MOOMOO_DIR, "worker-status.js")], {
    encoding: "utf8"
  });
  assert([0, 2, 3].includes(statusCheck.status), "worker status exits with an expected operational code");
  assert.doesNotThrow(() => JSON.parse(statusCheck.stdout), "worker status prints JSON");

  cleanup();
  process.stdout.write("moomoo QA checks passed.\n");
}

main().catch(err => {
  cleanup();
  console.error(err.stack || err.message);
  process.exit(1);
});
