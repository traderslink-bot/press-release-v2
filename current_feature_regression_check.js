const { fetchArticleText, getArticleSelectionMeta } = require("./lib/sec");
const { buildTraderDilutionTiming } = require("./lib/dilutionFilings");
const {
  derivePressReleaseEventType,
  normalizePressReleaseTimingInputs,
  harmonizePressReleaseFinancingSummary
} = require("./lib/pressReleaseFinancing");
const { buildSignalDiagnostics } = require("./lib/pipeline");
const { sanitizeTraderBullets } = require("./lib/ai");
const { recordObservedEvent, findRecentDuplicateContext } = require("./lib/ingestStore");

async function runSecSelectionCase({ name, url, rawText, expectedKind, expectedUrlIncludes }) {
  await fetchArticleText(url, rawText || "");
  const meta = getArticleSelectionMeta(url);
  const kindMatch = meta?.selectionKind === expectedKind;
  const urlMatch = expectedUrlIncludes
    ? String(meta?.selectedDocumentUrl || "").includes(expectedUrlIncludes)
    : true;

  return {
    name,
    type: "sec_selection",
    pass: Boolean(kindMatch && urlMatch),
    expectedKind,
    actualKind: meta?.selectionKind || null,
    expectedUrlIncludes,
    actualSelectedUrl: meta?.selectedDocumentUrl || null,
    meta
  };
}

function runClosedOfferingCase() {
  const articleText = [
    "Univest Securities, LLC Announces Closing of $5.0 Million Public Offering for its Client Fitness Champs Holdings Limited (NASDAQ: FCHL).",
    "Fitness Champs closed a best-efforts public offering raising approximately $5.0 million through the sale of 3,225,000 units at $1.55 per unit.",
    "Each Unit consisted of one Class A ordinary share (or, in lieu thereof, a pre-funded warrant) and one warrant exercisable for one Class A ordinary share at $2.635; the warrants are exercisable immediately and expire six months after issuance."
  ].join(" ");

  const eventType = derivePressReleaseEventType("press_release", articleText, "FCHL host message");
  const normalized = normalizePressReleaseTimingInputs({
    rawStatus: null,
    rawTriggerType: null,
    rawTriggerDate: null,
    articleText,
    summaryText: articleText,
    eventType
  });
  const timing = buildTraderDilutionTiming({
    rawStatus: normalized.rawStatus,
    rawTriggerType: normalized.rawTriggerType,
    rawTriggerDate: normalized.rawTriggerDate,
    summaryText: articleText
  });
  const summary = harmonizePressReleaseFinancingSummary(articleText, timing);

  const pass =
    eventType === "press_release_financing" &&
    timing.canDiluteToday === "Dilution status: Immediate" &&
    timing.earliestDilution === "Earliest dilution: shares issued at closing" &&
    /primary dilution is already in effect/i.test(summary);

  return {
    name: "FCHL closed offering wording",
    type: "press_release_timing",
    pass,
    eventType,
    canDiluteToday: timing.canDiluteToday,
    earliestDilution: timing.earliestDilution,
    summary
  };
}

function runLowSignalPressReleaseCase() {
  const articleText = [
    "Clearmind Medicine Welcomes President Trump's Executive Order as a Historic Catalyst for Psychedelic Innovation and Veteran Mental Health Care.",
    "The company announced the first paragraph of the press release is incorporated by reference into existing registration statements.",
    "The release does not announce customer orders, pricing, or firm delivery schedules."
  ].join(" ");

  const diagnostics = buildSignalDiagnostics({
    ai: {
      eventType: "press_release",
      headline: "Clearmind Medicine Welcomes President Trump's Executive Order as a Historic Catalyst",
      summary: articleText
    },
    data: {
      rawText: "CMND [news] Clearmind Medicine Welcomes President Trump's Executive Order"
    },
    articleText,
    secSource: false
  });

  const pass =
    diagnostics.signalQuality === "low" &&
    Array.isArray(diagnostics.flags) &&
    diagnostics.flags.includes("policy_tailwind_narrative_pr") &&
    diagnostics.flags.includes("sector_tailwind_without_company_specifics") &&
    diagnostics.flags.includes("low_signal_press_release");

  return {
    name: "CMND narrative press release flagged low-signal",
    type: "signal_diagnostics",
    pass,
    signalQuality: diagnostics.signalQuality,
    flags: diagnostics.flags
  };
}

function runRecentDuplicateCase() {
  const articleLink = "https://news.nuntiobot.com/article/regression-duplicate-url";
  const historicalId = `dup-historical-${Date.now()}`;
  const currentId = `dup-current-${Date.now()}`;

  recordObservedEvent({
    id: historicalId,
    observedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    messageTimestamp: new Date(Date.now() - 60 * 1000).toISOString(),
    ticker: "DUPX",
    tickers: ["DUPX"],
    routeTag: "default",
    articleLink,
    rawText: "DUPX historical duplicate message"
  });

  recordObservedEvent({
    id: currentId,
    observedAt: new Date().toISOString(),
    messageTimestamp: new Date().toISOString(),
    ticker: "DUPX",
    tickers: ["DUPX"],
    routeTag: "default",
    articleLink,
    rawText: "DUPX current duplicate message"
  });

  const duplicateContext = findRecentDuplicateContext({
    id: currentId,
    articleLink
  });

  const pass =
    duplicateContext.isRecentDuplicate === true &&
    duplicateContext.recentDuplicateCount >= 1 &&
    Array.isArray(duplicateContext.recentDuplicates) &&
    duplicateContext.recentDuplicates.some(item => item.id === historicalId);

  return {
    name: "recent duplicate article URL is detected from ingest DB",
    type: "duplicate_diagnostics",
    pass,
    duplicateContext
  };
}

function runBulletSanitizationCase() {
  const positives = sanitizeTraderBullets(
    [
      "Presence at Data Center World 2026 increases visibility to potential customers and partners.",
      "Product moved to general availability.",
      "Univest Securities acted as sole placement agent."
    ],
    "positive"
  );
  const negatives = sanitizeTraderBullets(
    [
      "Claims are company statements in a press release and not independently validated within the article.",
      "No pricing or firm delivery schedule was disclosed."
    ],
    "negative"
  );

  const pass =
    positives.length === 1 &&
    positives[0] === "Product moved to general availability." &&
    negatives.length === 1 &&
    negatives[0] === "No pricing or firm delivery schedule was disclosed.";

  return {
    name: "boilerplate positives and negatives are trimmed",
    type: "bullet_sanitization",
    pass,
    positives,
    negatives
  };
}

async function run() {
  const cases = [
    await runSecSelectionCase({
      name: "CMND 6-K chooses EX-99.1 press release",
      url: "https://www.sec.gov/Archives/edgar/data/1892500/000121390026045585/0001213900-26-045585-index.htm",
      rawText: "CMND SEC - Form 6-K - Link",
      expectedKind: "index_primary",
      expectedUrlIncludes: "ex99-1"
    }),
    await runSecSelectionCase({
      name: "SLNH EFFECT follows underlying registration filing",
      url: "https://www.sec.gov/Archives/edgar/data/64463/999999999526001245/9999999995-26-001245-index.htm",
      rawText: "SLNH SEC - Form EFFECT - Link",
      expectedKind: "effect_underlying_registration",
      expectedUrlIncludes: "0001493152-26-018102"
    }),
    runClosedOfferingCase(),
    runLowSignalPressReleaseCase(),
    runRecentDuplicateCase(),
    runBulletSanitizationCase()
  ];

  const summary = {
    total: cases.length,
    passed: cases.filter(item => item.pass).length,
    failed: cases.filter(item => !item.pass).length
  };

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), summary, cases }, null, 2));
  process.exit(summary.failed ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
