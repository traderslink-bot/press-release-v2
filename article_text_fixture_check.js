const fs = require("fs");
const path = require("path");

const { cleanText } = require("./lib/utils");
const { buildTraderDilutionTiming } = require("./lib/dilutionFilings");
const {
  derivePressReleaseEventType,
  extractPressReleasePhase1Signals,
  normalizePressReleaseTimingInputs
} = require("./lib/pressReleaseFinancing");

function parseSimpleCsv(raw) {
  const lines = String(raw || "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const cells = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === "\"") {
        if (inQuotes && line[i + 1] === "\"") {
          current += "\"";
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        cells.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current);

    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    return row;
  });
}

function readArticleBody(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const split = raw.split(/^## Article\s*$/m);
  return cleanText(split[1] || raw);
}

function dateKeyFromCsvDate(csvDate) {
  const text = cleanText(csvDate || "");
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeEarliestLineForCompare(value) {
  return cleanText(value || "")
    .replace(/,\s+\d{4}\b/g, "")
    .replace(/\bclosing\b/gi, "close")
    .toLowerCase();
}

function run() {
  const repoRoot = __dirname;
  const indexPath = path.join(repoRoot, "docs", "article_texts", "pr_test_index.csv");
  const outputPath = path.join(repoRoot, "docs", "replay_results", "pr_article_fixture_check.json");
  const rows = parseSimpleCsv(fs.readFileSync(indexPath, "utf8"));

  const results = rows.map(row => {
    const localFile = path.join(repoRoot, row.local_file);
    const articleText = readArticleBody(localFile);
    const eventType = derivePressReleaseEventType("", articleText, row.headline || "");
    const phase1Signals = extractPressReleasePhase1Signals({
      articleText,
      summaryText: "",
      eventType
    });
    const normalized = normalizePressReleaseTimingInputs({
      rawStatus: null,
      rawTriggerType: null,
      rawTriggerDate: null,
      articleText,
      summaryText: "",
      eventType
    });
    const timing = buildTraderDilutionTiming({
      rawTiming: null,
      rawStatus: normalized.rawStatus,
      rawTriggerType: normalized.rawTriggerType,
      rawTriggerDate: normalized.rawTriggerDate,
      summaryText: articleText,
      currentDateKeyOverride: dateKeyFromCsvDate(row.date)
    });

    const actualStatus = cleanText((timing.canDiluteToday || "").replace(/^Dilution status:\s*/i, ""));
    const actualEarliest = cleanText((timing.earliestDilution || "").replace(/^Earliest dilution:\s*/i, ""));
    const expectedStatus = cleanText(row.expected_card_status || "");
    const expectedEarliest = cleanText(row.expected_earliest_line || "");

    return {
      ticker: row.ticker,
      localFile: row.local_file,
      offeringFamily: row.offering_family,
      timingPattern: row.timing_pattern,
      expectedCardStatus: expectedStatus,
      expectedEarliestLine: expectedEarliest,
      actualCardStatus: actualStatus,
      actualEarliestLine: actualEarliest,
      cardStatusMatch: !expectedStatus || actualStatus.toLowerCase() === expectedStatus.toLowerCase(),
      earliestLineMatch: !expectedEarliest || normalizeEarliestLineForCompare(actualEarliest) === normalizeEarliestLineForCompare(expectedEarliest),
      eventType,
      phase1Signals,
      normalizedTiming: {
        rawStatus: normalized.rawStatus,
        rawTriggerType: normalized.rawTriggerType,
        rawTriggerDate: normalized.rawTriggerDate,
        phase1Signals: normalized.phase1Signals
      }
    };
  });

  const summary = {
    total: results.length,
    statusMatches: results.filter(item => item.cardStatusMatch).length,
    earliestMatches: results.filter(item => item.earliestLineMatch).length
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary,
        results
      },
      null,
      2
    )
  );

  console.log(JSON.stringify({ outputPath, summary }, null, 2));
}

run();
