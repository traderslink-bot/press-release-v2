const { fetchArticleText, getArticleSelectionMeta } = require("./lib/sec");
const Database = require("better-sqlite3");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildTraderDilutionTiming } = require("./lib/dilutionFilings");
const {
  derivePressReleaseEventType,
  normalizePressReleaseTimingInputs,
  harmonizePressReleaseFinancingSummary
} = require("./lib/pressReleaseFinancing");
const {
  buildPostingDecision,
  buildSignalDiagnostics,
  buildDuplicateDiagnostics,
  isStaleMarketCapEvent,
  countNewsFilteredPosts,
  shouldScheduleDelayedNewsDump,
  buildFreeNewsArticleUrl,
  buildExternalFreeNewsBotPayload,
  isHostNewsTooOldForDiscord
} = require("./lib/pipeline");
const {
  sanitizeTraderBullets,
  sanitizeSourceAttributionText,
  buildUrlFallbackMetadataOnlyResult
} = require("./lib/ai");
const {
  buildDiscordEmbeds,
  getWebhookTargets,
  shouldUseFreeNewsBotTargets,
  assertExternalFreeNewsBotPayload
} = require("./lib/discord");
const { expandMarketCapBundleData } = require("./lib/liveBot");
const { recordObservedEvent, findRecentDuplicateContext } = require("./lib/ingestStore");
const { INGEST_DATABASE_PATH } = require("./lib/config");
const {
  getActiveFreeNewsSubscribers,
  setFreeNewsSubscriberForGuild,
  removeFreeNewsSubscribersForGuild,
  writeSubscriberStore
} = require("./lib/freeNewsSubscribers");
const {
  FREE_NEWS_BOT_COMMANDS,
  getSetupFailureMessage
} = require("./lib/discordFreeNewsBotGateway");

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

function runCompletedWarrantExerciseCase() {
  const articleText = [
    "Quantum Cyber Strengthens Balance Sheet with Over $15 Million in Aggregate Financing; Cap Table is Debt-Free.",
    "WEST PALM BEACH, Florida, May 26, 2026 -- Quantum Cyber N.V. announced that warrant holders have fully exercised outstanding warrants, resulting in gross proceeds of over $15,000,000 to the Company.",
    "The funds have been received and are currently held on the Company's balance sheet.",
    "As a result of the completed warrant exercises, Quantum Cyber's capital structure no longer includes any exercisable warrants and is debt-free.",
    "The Company's current outstanding shares are 22,767,254 as of the date of this release."
  ].join(" ");
  const initialSummary = [
    "Quantum Cyber says warrant holders fully exercised outstanding warrants, generating over $15.0M in gross proceeds that have been received and are held on the balance sheet.",
    "The company reports all outstanding debt has been satisfied, no exercisable warrants remain, and current shares outstanding are 22,767,254; the exercises are complete and dilution is immediate.",
    "Timing: Same-day dilution is possible, but the press release does not provide a firm first-dilution date."
  ].join(" ");

  const eventType = derivePressReleaseEventType("press_release", articleText, "QUCY financing");
  const normalized = normalizePressReleaseTimingInputs({
    rawStatus: "potential",
    rawTriggerType: "exercise",
    rawTriggerDate: null,
    articleText,
    summaryText: initialSummary,
    eventType
  });
  const timing = buildTraderDilutionTiming({
    rawStatus: normalized.rawStatus,
    rawTriggerType: normalized.rawTriggerType,
    rawTriggerDate: normalized.rawTriggerDate,
    summaryText: initialSummary
  });
  const summary = harmonizePressReleaseFinancingSummary(initialSummary, timing);

  const pass =
    eventType === "press_release_warrant_financing" &&
    timing.dilutionStatus === "live_now" &&
    timing.dilutionTriggerType === "already_triggered" &&
    timing.canDiluteToday === "Dilution status: Immediate" &&
    timing.earliestDilution === "Earliest dilution: already triggered" &&
    /dilution is already in effect/i.test(summary) &&
    !/date unknown|does not provide a firm first-dilution date/i.test(summary);

  return {
    name: "completed warrant exercise is immediate dilution",
    type: "press_release_timing",
    pass,
    eventType,
    normalizedStatus: normalized.rawStatus,
    normalizedTriggerType: normalized.rawTriggerType,
    canDiluteToday: timing.canDiluteToday,
    earliestDilution: timing.earliestDilution,
    summary
  };
}

function runLockedPipeCase() {
  const articleText = [
    "Skycorp Solar Group Limited announced it has entered into definitive Securities Purchase Agreements dated May 1, 2026 with three independent institutional investors to raise an aggregate of USD3,000,000 in a private placement (PIPE) transaction.",
    "Pursuant to the Agreements dated May 1, 2026, Skycorp will issue a total of 1,694,000 Class A Ordinary Shares.",
    "The purchase price is set at USD1.7703 per share.",
    "The subscribed shares are subject to a six-month lock-up commencing May 1, 2026.",
    "Separately, the Company signed a Share Acquisition Agreement to acquire the remaining 56% equity interests in Nanjing Cesun for consideration satisfied through the issuance of 7,983,000 newly issued Skycorp ordinary shares, subject to customary closing conditions."
  ].join(" ");

  const eventType = derivePressReleaseEventType("press_release_private_placement", articleText, "PN PIPE");
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
    summaryText: articleText,
    currentDateKeyOverride: "2026-05-01"
  });
  const summary = harmonizePressReleaseFinancingSummary(
    "The PIPE appears to be issued under May 1 agreements, so PIPE dilution is effectively immediate while the acquisition share issuance is delayed pending closing conditions. Timing: Same-day dilution is possible, but the press release does not provide a firm first-dilution date.",
    timing
  );

  const pass =
    eventType === "press_release_private_placement" &&
    timing.canDiluteToday === "Dilution status: Delayed" &&
    timing.earliestDilution === "Earliest sellable supply: Nov 1, 2026 lock-up expiry" &&
    timing.dilutionTriggerType === "lockup_expiry" &&
    /cap-table issuance may be immediate, but the PIPE shares appear locked up/i.test(summary);

  return {
    name: "locked PIPE uses lock-up expiry as sellable-supply timing",
    type: "press_release_timing",
    pass,
    eventType,
    canDiluteToday: timing.canDiluteToday,
    earliestDilution: timing.earliestDilution,
    dilutionTriggerType: timing.dilutionTriggerType,
    summary
  };
}

function runNexrRegisteredDirectExpectedCloseCase() {
  const articleText = [
    'Nexera Technologies Ltd ("Nexera" or the "Company") (NASDAQ: NEXR, NEXRW) announced that it has entered into a securities purchase agreement with institutional investors for the purchase and sale of 1,200,000 ordinary shares at a purchase price of $1.00 per share in a registered direct offering.',
    'The gross proceeds from the Offering are expected to be approximately $1.2 million, before deducting offering expenses.',
    'In addition, in a concurrent private placement, the Company will issue and sell warrants to purchase up to 1,200,000 ordinary shares.',
    'The Warrants will have an exercise price of $1.00 per share, will be exercisable immediately upon issuance, and will expire 5.5 years following the issuance date.',
    'The closing of the Offering is expected to occur on or about June 9, 2026, subject to the satisfaction of customary closing conditions.',
    'The Shares offered to the institutional investor described above are being offered pursuant to a registration statement on Form F-3 which was declared effective by the SEC on January 3, 2025.',
    'The Warrants will be issued in a concurrent private placement.'
  ].join(" ");
  const initialSummary = [
    "Nexera priced a registered direct offering of 1,200,000 ordinary shares at $1.00 per share for approximately $1.2M in gross proceeds and concurrently agreed to issue warrants to purchase up to 1,200,000 shares.",
    "The warrants are exercisable immediately upon issuance, but closing is expected on or about June 9, 2026, subject to customary conditions.",
    "Timing: Same-day dilution is possible because the shares will be issued at closing."
  ].join(" ");

  const eventType = derivePressReleaseEventType("press_release", articleText, "NEXR pricing registered direct");
  const normalized = normalizePressReleaseTimingInputs({
    rawStatus: "live_now",
    rawTriggerType: "closing",
    rawTriggerDate: "June 9, 2026",
    articleText,
    summaryText: initialSummary,
    eventType
  });
  const timing = buildTraderDilutionTiming({
    rawStatus: normalized.rawStatus,
    rawTriggerType: normalized.rawTriggerType,
    rawTriggerDate: normalized.rawTriggerDate,
    summaryText: initialSummary,
    currentDateKeyOverride: "2026-06-08"
  });
  const summary = harmonizePressReleaseFinancingSummary(initialSummary, timing);

  const pass =
    eventType === "press_release_registered_direct" &&
    normalized.rawStatus === "delayed" &&
    normalized.rawTriggerType === "closing" &&
    normalized.rawTriggerDate === "June 9, 2026" &&
    timing.dilutionStatus === "delayed" &&
    timing.dilutionTriggerType === "closing" &&
    timing.dilutionTriggerDate === "Jun 9, 2026" &&
    timing.canDiluteToday === "Dilution status: Delayed" &&
    timing.earliestDilution === "Earliest dilution: Jun 9, 2026 close" &&
    /does not indicate dilution today/i.test(summary) &&
    /initial share dilution occurs at the offering close \(Jun 9, 2026\)/i.test(summary) &&
    /once the offering closes those shares have been issued/i.test(summary) &&
    !/same-day dilution is possible/i.test(summary);

  return {
    name: "NEXR registered direct pricing stays delayed until expected close",
    type: "press_release_timing",
    pass,
    eventType,
    normalized,
    canDiluteToday: timing.canDiluteToday,
    earliestDilution: timing.earliestDilution,
    summary
  };
}

function runTghlConditionalMergerDilutionCase() {
  const summary = [
    "TGHL entered into an Agreement and Plan of Merger to acquire EnChem America in exchange for roughly 142,848,176 newly issued Class A ordinary shares, or enough shares to equal 85% of the pro forma fully diluted company.",
    "Issuance is not immediate: the merger requires a new Form F-1 to be declared effective, Nasdaq listing approval, shareholder approval, and other closing conditions before the shares are issued at closing.",
    "A registration rights agreement and lock-up are contemplated at or before closing, so future resale supply remains gated."
  ].join(" ");
  const timing = buildTraderDilutionTiming({
    rawTiming: "Dilution status: Immediate",
    rawStatus: "live_now",
    rawTriggerType: "resale_eligibility",
    rawTriggerDate: null,
    summaryText: summary,
    currentDateKeyOverride: "2026-07-15"
  });
  const decision = buildPostingDecision({
    ai: {
      headline: "GrowHub signs definitive EnChem merger agreement",
      summary,
      eventType: "sec_current_report",
      ...timing
    },
    data: {
      ticker: "TGHL",
      routeTag: "default",
      rawText: "TGHL SEC Form 6-K"
    },
    articleText: summary,
    articleSourceMode: "fetched_direct",
    signalDiagnostics: {
      signalQuality: "normal",
      companySpecificCatalyst: "present"
    },
    secSource: true,
    duplicateDiagnostics: {
      isRecentPostedDuplicate: false
    }
  });

  const pass =
    timing.dilutionStatus === "conditional" &&
    timing.dilutionTriggerType === "closing" &&
    timing.canDiluteToday === "Dilution status: Undetermined" &&
    timing.earliestDilution === "Earliest dilution: date unknown" &&
    decision.allowPrimary === true &&
    !decision.reasons.includes("immediate_dilution_suppressed");

  return {
    name: "TGHL merger shares stay conditional until closing",
    type: "sec_dilution_timing",
    pass,
    timing,
    postingDecision: decision
  };
}

function runHostStartupBackfillContractCase() {
  const liveBotSource = fs.readFileSync(path.join(__dirname, "lib", "liveBot.js"), "utf8");
  const configSource = fs.readFileSync(path.join(__dirname, "lib", "config.js"), "utf8");
  const pipelineSource = fs.readFileSync(path.join(__dirname, "lib", "pipeline.js"), "utf8");
  const now = new Date("2026-07-16T16:00:00.000Z");
  const recentHostEvent = {
    routeTag: "default",
    feedType: "host_startup_backfill",
    messageTimestamp: "2026-07-16T15:31:00.000Z"
  };
  const normalDelayedHostEvent = {
    routeTag: "default",
    feedType: null,
    messageTimestamp: "2026-07-16T15:20:00.000Z"
  };
  const staleHostEvent = {
    routeTag: "default",
    feedType: "host_startup_backfill",
    messageTimestamp: "2026-07-16T15:29:00.000Z"
  };
  const staleMarketCapEvent = {
    routeTag: "market_cap_under_30m",
    feedType: "market_cap",
    messageTimestamp: "2026-07-16T15:29:00.000Z"
  };
  const pass =
    liveBotSource.includes("HOST_STARTUP_BACKFILL_HOURS") &&
    liveBotSource.includes("processStartupHistory") &&
    liveBotSource.includes("startupCutoffTime") &&
    liveBotSource.includes("scrollContainer.scrollTo({ top: 0") &&
    liveBotSource.includes("messageTime < startupCutoffTime") &&
    liveBotSource.includes("new Date(tsAttr).getTime() < startTime") &&
    configSource.includes("HOST_STARTUP_BACKFILL_MAX_MESSAGES") &&
    configSource.includes("HOST_DISCORD_MAX_EVENT_AGE_MS") &&
    liveBotSource.includes("runMarketCapDiscordBot") &&
    !isHostNewsTooOldForDiscord(recentHostEvent, now) &&
    isHostNewsTooOldForDiscord(staleHostEvent, now) &&
    !isHostNewsTooOldForDiscord(staleMarketCapEvent, now) &&
    !isHostNewsTooOldForDiscord(normalDelayedHostEvent, now) &&
    !pipelineSource.includes("buildDiscordDelayNotice") &&
    !pipelineSource.includes('name: "Delayed Alert"') &&
    !pipelineSource.includes("Original article time:");

  return {
    name: "host startup backfills missed articles without changing scanner runtime",
    type: "startup_recovery",
    pass,
    discordCutoffMinutes: 30
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

  cleanupRegressionDuplicateRows(articleLink);

  try {
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
  } finally {
    cleanupRegressionDuplicateRows(articleLink);
  }
}

function runCrossDestinationDuplicateCase() {
  const articleLink = "https://news.nuntiobot.com/article/regression-cross-destination-duplicate-url";
  const marketCapId = `dup-market-cap-${Date.now()}`;
  const primaryId = `dup-primary-${Date.now()}`;

  cleanupRegressionDuplicateRows(articleLink);

  const db = new Database(INGEST_DATABASE_PATH);

  try {
    recordObservedEvent({
      id: marketCapId,
      observedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      messageTimestamp: new Date(Date.now() - 60 * 1000).toISOString(),
      ticker: "DUPY",
      tickers: ["DUPY"],
      routeTag: "market_cap_under_30m",
      feedType: "market_cap",
      articleLink,
      rawText: "DUPY market-cap duplicate message"
    });

    db.prepare(`
      UPDATE ingest_events
      SET process_status = 'processed',
          posted_messages_json = '[{"id":"regression-posted-market-cap"}]',
          updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), marketCapId);

    recordObservedEvent({
      id: primaryId,
      observedAt: new Date().toISOString(),
      messageTimestamp: new Date().toISOString(),
      ticker: "DUPY",
      tickers: ["DUPY"],
      routeTag: "default",
      articleLink,
      rawText: "DUPY primary duplicate message"
    });

    const duplicateDiagnostics = buildDuplicateDiagnostics({
      data: {
        id: primaryId,
        routeTag: "default",
        articleLink
      }
    });

    return {
      name: "market-cap duplicate post does not suppress primary destination",
      type: "duplicate_diagnostics",
      pass:
        duplicateDiagnostics.isRecentDuplicate === true &&
        duplicateDiagnostics.isRecentPostedDuplicate === false &&
        duplicateDiagnostics.recentPostedDuplicateCount === 0,
      duplicateDiagnostics
    };
  } finally {
    db.close();
    cleanupRegressionDuplicateRows(articleLink);
  }
}

function cleanupRegressionDuplicateRows(articleLink) {
  const db = new Database(INGEST_DATABASE_PATH);
  try {
    db.prepare("DELETE FROM ingest_events WHERE normalized_article_url = ?").run(articleLink);
  } finally {
    db.close();
  }
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

function runUnreadableUrlFallbackGroundingCase() {
  const rawText = "07:03 ↑ U < $30 ~ | Float: 357 M | IO: 63.53% | MC: 11.9 B 4 minutes ago PR Unity Reports First Quarter 2026 Financial Results - Link,";
  const result = buildUrlFallbackMetadataOnlyResult({
    rawDiscordMessage: rawText,
    parsed: {
      headline: "Unity Reports First Quarter 2026 Financial Results",
      summary: "I could not load the BusinessWire article body. Unity reported revenue of $505M and EBITDA above guidance.",
      positives: ["Revenue beat guidance."],
      negatives: ["Full article text unavailable."],
      tickers: ["U"],
      eventType: "press_release_earnings",
      confidence: 0.6,
      urlReadNotes: "Could not retrieve BusinessWire."
    },
    openaiUsage: { operation: "url_fallback" }
  });

  const pass =
    result.isFallback === true &&
    result.urlFallbackReadSucceeded === false &&
    /could not be AI summarized/i.test(result.summary) &&
    result.positives.length === 0 &&
    result.negatives.length === 0 &&
    result.confidence <= 0.35;

  return {
    name: "unreadable URL fallback stays metadata-only",
    type: "url_fallback_grounding",
    pass,
    result
  };
}

function runFallbackArticleLinkEmbedCase() {
  const embeds = buildDiscordEmbeds(
    {
      headline: "Unity Reports First Quarter 2026 Financial Results",
      summary: "The article page could not be read, so this item could not be AI summarized from the full article text.",
      positives: [],
      negatives: [],
      isFallback: true
    },
    {
      ticker: "U",
      float: "357 M",
      io: "63.53%",
      marketCap: "11.9 B"
    },
    "https://www.businesswire.com/news/home/20260507735008/en/",
    ""
  );
  const fields = embeds.flatMap(embed => Array.isArray(embed.fields) ? embed.fields : []);
  const articleField = fields.find(field => field.name === "Original Article");

  return {
    name: "fallback non-SEC Discord embed includes article link",
    type: "discord_fallback_link",
    pass: Boolean(articleField && /Open Original Article/.test(articleField.value)),
    articleField: articleField || null
  };
}

function runReadableSourceAttributionCleanupCase() {
  const summary = sanitizeSourceAttributionText(
    "Business Wire press release (dated May 6, 2026) reporting Pagaya Technologies' Q1 2026 results and updated full-year outlook. Key reported results: GAAP net income attributable to Pagaya shareholders of $25 million. The summary is grounded in the Business Wire release."
  );
  const bullets = sanitizeTraderBullets([
    "Business Wire release reporting GAAP profitability in 1Q26.",
    "Adjusted EBITDA growth: $94M, up 18% YoY."
  ]);

  const pass =
    !/Business\s*Wire|press release|grounded in/i.test(summary) &&
    /^Pagaya Technologies' Q1 2026 results/i.test(summary) &&
    bullets.length === 2 &&
    !/Business\s*Wire|release reporting/i.test(bullets[0]);

  return {
    name: "readable article summaries remove source attribution",
    type: "source_attribution_cleanup",
    pass,
    summary,
    bullets
  };
}

function runReadableUrlFallbackPostingCase() {
  const readableDecision = buildPostingDecision({
    ai: {
      headline: "Pagaya Reports First Quarter 2026 Results",
      summary: "Pagaya reported Q1 revenue growth, GAAP net income, and raised full-year net income guidance.",
      eventType: "press_release_earnings",
      urlFallbackReadSucceeded: true
    },
    data: {
      routeTag: "default",
      rawText: "PGY PR Pagaya Reports First Quarter 2026 Results & Raising Full-Year Net Income Guidance - Link"
    },
    articleText: "",
    articleSourceMode: "openai_url_fallback",
    signalDiagnostics: { signalQuality: "normal" },
    secSource: false,
    duplicateDiagnostics: {}
  });

  const unreadableDecision = buildPostingDecision({
    ai: {
      headline: "Unity Reports First Quarter 2026 Financial Results",
      summary: "The article page could not be read, so this item could not be AI summarized from the full article text.",
      eventType: "press_release_earnings",
      urlFallbackReadSucceeded: false
    },
    data: {
      routeTag: "default",
      rawText: "U PR Unity Reports First Quarter 2026 Financial Results - Link"
    },
    articleText: "",
    articleSourceMode: "headline_only_fallback",
    signalDiagnostics: { signalQuality: "normal" },
    secSource: false,
    duplicateDiagnostics: {}
  });

  const pass =
    readableDecision.allowPrimary === true &&
    readableDecision.reasons.includes("press_release_hard_catalyst") &&
    unreadableDecision.allowPrimary === true &&
    unreadableDecision.reasons.includes("press_release_headline_allowed");

  return {
    name: "readable URL fallback posts and headline-only PR stays eligible",
    type: "posting_decision",
    pass,
    readableDecision,
    unreadableDecision
  };
}

function formatLocalMonthDate(value = new Date()) {
  return value.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function runStandardPressReleasePostingCase() {
  const decision = buildPostingDecision({
    ai: {
      headline: "ENVB: USPTO issues patent covering carboxylated psilocybin methods for EVM301 series",
      summary:
        "Enveric announced the USPTO issued a patent covering method-of-use claims for its EVM301 series; the patent broadens IP protection but does not change clinical status.",
      eventType: "press_release"
    },
    data: {
      routeTag: "default",
      rawText:
        "ENVB < $3 - Enveric Biosciences Expands IP Portfolio with New U.S. Patent Issued for Methods of Treating Psychiatric Disorders - Link ~ | Float: 1.7 M | MC: 5.0 M | Reg SHO | SI: 52.1% | High CTB"
    },
    articleText:
      "Enveric Biosciences announced that the United States Patent and Trademark Office issued a patent pertaining to the Company's EVM301 Series of molecules.",
    articleSourceMode: "fetched_direct",
    signalDiagnostics: { signalQuality: "normal", companySpecificCatalyst: "present" },
    secSource: false,
    duplicateDiagnostics: {}
  });

  return {
    name: "standard fetched press release posts even without financing language",
    type: "posting_decision",
    pass:
      decision.allowPrimary === true &&
      decision.reasons.includes("press_release_standard_allowed") &&
      !decision.reasons.includes("press_release_default_filtered"),
    decision
  };
}

function runStandardSecPostingCase() {
  const decision = buildPostingDecision({
    ai: {
      headline: "QURE: State Street reports 3.6% stake on Schedule 13G",
      summary: "State Street filed a Schedule 13G reporting passive ownership.",
      eventType: "sec_beneficial_ownership",
      filingType: "SCHEDULE 13G"
    },
    data: {
      routeTag: "default",
      rawText: "QURE SEC Form SCHEDULE 13G - Link"
    },
    articleText: "Schedule 13G passive ownership filing.",
    articleSourceMode: "fetched_direct",
    signalDiagnostics: { signalQuality: "normal", companySpecificCatalyst: "present" },
    secSource: true,
    duplicateDiagnostics: {}
  });

  return {
    name: "standard SEC filing posts unless it has a suppressing reason",
    type: "posting_decision",
    pass:
      decision.allowPrimary === true &&
      decision.reasons.includes("sec_standard_allowed") &&
      !decision.reasons.includes("sec_default_filtered"),
    decision
  };
}

function runHeadlineOnlyCatalystPostingCase() {
  const decision = buildPostingDecision({
    ai: {
      headline:
        "Quantum Cyber N.V. Secures Exclusive Autonomous Drone Platform as Trump Administration Seeks $55 Billion for Drone Warfare",
      summary: "The article page could not be read, so this item could not be AI summarized from the full article text.",
      eventType: "press_release",
      confidence: 0.35,
      isFallback: true,
      urlFallbackReadSucceeded: false
    },
    data: {
      routeTag: "spike",
      rawText:
        "QUCY < $.50c - Quantum Cyber N.V. Secures Exclusive Autonomous Drone Platform as Trump Administration Seeks $55 Billion for Drone Warfare - Link ~ | Float: 10.7 M | MC: 4.0 M"
    },
    articleText: "",
    articleSourceMode: "headline_only_fallback",
    signalDiagnostics: { signalQuality: "normal", companySpecificCatalyst: "present" },
    secSource: false,
    duplicateDiagnostics: {}
  });

  return {
    name: "headline-only spike press release can post when catalyst is company-specific",
    type: "posting_decision",
    pass:
      decision.allowPrimary === true &&
      decision.allowSpike === true &&
      decision.reasons.includes("press_release_headline_catalyst_allowed") &&
      decision.reasons.includes("spike_channel_allowed"),
    decision
  };
}

function runSpikeRoutePostsCase() {
  const decision = buildPostingDecision({
    ai: {
      headline: "Wearable Devices launches Mudra Pro wristband for AI and XR intent decoding",
      summary:
        "Wearable Devices launched Mudra Pro, a wristband for gesture and intent decoding across AI and XR workflows.",
      eventType: "press_release"
    },
    data: {
      routeTag: "spike",
      rawText:
        "WLDS < $2 - Wearable Devices launches Mudra Pro wristband for AI/XR intent decoding - Link ~ | Float: 11.0 M | MC: 8.0 M"
    },
    articleText:
      "Wearable Devices launched Mudra Pro, a wristband for AI and XR gesture and intent decoding.",
    articleSourceMode: "fetched_direct",
    signalDiagnostics: {
      signalQuality: "low",
      flags: ["generic_product_news_without_customer_terms", "low_signal_press_release"]
    },
    secSource: false,
    duplicateDiagnostics: {}
  });

  return {
    name: "spike route posts unless a real suppression reason exists",
    type: "posting_decision",
    pass:
      decision.allowPrimary === true &&
      decision.allowSpike === true &&
      decision.reasons.includes("spike_channel_allowed") &&
      !decision.reasons.includes("spike_low_signal_suppressed") &&
      !decision.reasons.includes("spike_default_filtered"),
    decision
  };
}

function runCurrentDateDilutionSuppressionCase() {
  const todayLabel = formatLocalMonthDate();
  const decision = buildPostingDecision({
    ai: {
      headline: "ExampleCo prices registered direct offering",
      summary: `The offering is expected to close on ${todayLabel}.`,
      eventType: "press_release_registered_direct",
      dilutionStatus: "delayed",
      canDiluteToday: "Dilution status: Delayed",
      earliestDilution: `Earliest dilution: ${todayLabel} closing`,
      dilutionTriggerDate: todayLabel
    },
    data: {
      routeTag: "default",
      rawText: `EXCO PR ExampleCo prices registered direct offering expected to close ${todayLabel} - Link`
    },
    articleText: `The offering is expected to close on ${todayLabel}.`,
    articleSourceMode: "fetched_direct",
    signalDiagnostics: { signalQuality: "normal" },
    secSource: false,
    duplicateDiagnostics: {}
  });

  return {
    name: "current-date dilution is suppressed from News Filtered",
    type: "posting_decision",
    pass:
      decision.allowPrimary === false &&
      decision.allowSpike === false &&
      decision.reasons.includes("current_date_dilution_suppressed"),
    decision
  };
}

function runBadNewsSuppressionCase() {
  const decision = buildPostingDecision({
    ai: {
      headline: "ExampleCo receives Nasdaq delisting notice",
      summary: "The company received a Nasdaq delisting notice for continued listing non-compliance.",
      eventType: "press_release"
    },
    data: {
      routeTag: "default",
      rawText: "EXCO PR ExampleCo receives Nasdaq delisting notice - Link"
    },
    articleText: "ExampleCo received a Nasdaq delisting notice and is not in compliance with listing requirements.",
    articleSourceMode: "fetched_direct",
    signalDiagnostics: { signalQuality: "normal" },
    secSource: false,
    duplicateDiagnostics: {}
  });

  return {
    name: "bad news press release is suppressed from News Filtered",
    type: "posting_decision",
    pass:
      decision.allowPrimary === false &&
      decision.allowSpike === false &&
      decision.reasons.includes("bad_news_suppressed"),
    decision
  };
}

function runImmediateDilutionSuppressionCase() {
  const decision = buildPostingDecision({
    ai: {
      headline: "InflaRx to sell 75M new shares at $2.00",
      summary: "Primary issuance is immediate dilution to existing holders.",
      eventType: "sec_prospectus_supplement",
      dilutionStatus: "live_now",
      canDiluteToday: "Dilution status: Immediate",
      earliestDilution: "Earliest dilution: May 7, 2026 closing"
    },
    data: {
      routeTag: "default",
      rawText: "IFRX SEC - Form 424B5 - Link"
    },
    articleText: "InflaRx is offering 75,000,000 new ordinary shares at $2.00 per share.",
    articleSourceMode: "fetched_direct",
    signalDiagnostics: { signalQuality: "normal" },
    secSource: true,
    duplicateDiagnostics: {}
  });
  const targets = getWebhookTargets("default", { canDiluteToday: "Dilution status: Immediate" }, decision);

  return {
    name: "immediate dilution is suppressed from opportunity channel",
    type: "posting_decision",
    pass:
      decision.allowPrimary === false &&
      decision.allowSpike === false &&
      decision.reasons.includes("immediate_dilution_suppressed") &&
      targets.length === 0,
    decision,
    targets
  };
}

function runBusinessWireHeadlineOnlyCase() {
  const data = {
    routeTag: "default",
    ticker: "CNCK",
    float: "13.8 M",
    io: "2.02%",
    marketCap: "238 M",
    rawText:
      "07:45 ↑ CNCK < $3 ~ | Float: 13.8 M | IO: 2.02% | MC: 238 M 46 seconds ago PR Coincheck Reports Financial Results for Fourth Quarter of Year Ended March 31, 2026 - Link,",
    articleLink: "https://www.businesswire.com/news/home/20260512112558/en/"
  };
  const ai = {
    headline: "Coincheck Reports Financial Results for Fourth Quarter of Year Ended March 31, 2026",
    summary: "",
    positives: [],
    negatives: [],
    eventType: "press_release_businesswire_headline",
    isBusinessWireHeadlineOnly: true
  };
  const decision = buildPostingDecision({
    ai,
    data,
    articleText: "",
    articleSourceMode: "businesswire_headline_only",
    signalDiagnostics: { signalQuality: "normal" },
    secSource: false,
    duplicateDiagnostics: {}
  });
  const embeds = buildDiscordEmbeds(ai, data, data.articleLink, "", { includeLevels: false });
  const firstEmbed = embeds[0] || {};
  const field = firstEmbed.fields?.[0] || {};

  return {
    name: "BusinessWire posts headline-only without AI summary",
    type: "discord_businesswire_headline_only",
    pass:
      decision.allowPrimary === true &&
      decision.reasons.includes("businesswire_headline_only_allowed") &&
      embeds.length === 1 &&
      /BusinessWire Link/.test(field.name || "") &&
      /businesswire\.com/.test(field.value || "") &&
      !/Positives|Negatives|summary|unavailable/i.test(JSON.stringify(firstEmbed)),
    decision,
    embed: firstEmbed
  };
}

function runReverseSplitSuppressionCase() {
  const decision = buildPostingDecision({
    ai: {
      headline: "Sow Good Announces Reverse Stock Split",
      summary: "The company announced a 1-for-10 reverse stock split to regain exchange compliance.",
      eventType: "press_release"
    },
    data: {
      routeTag: "spike",
      rawText: "SOWG PR Sow Good Inc. Announces Reverse Stock Split - Link"
    },
    articleText: "Sow Good Inc. announced a one-for-ten reverse split of its common stock.",
    articleSourceMode: "fetched_direct",
    signalDiagnostics: { signalQuality: "normal" },
    secSource: false,
    duplicateDiagnostics: {}
  });
  const targets = getWebhookTargets("spike", {}, decision);

  return {
    name: "reverse split is suppressed from News Filtered",
    type: "posting_decision",
    pass:
      decision.allowPrimary === false &&
      decision.allowSpike === false &&
      decision.reasons.includes("reverse_split_suppressed") &&
      targets.length === 0,
    decision,
    targets
  };
}

function runStaleMarketCapSuppressionCase() {
  const observedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const data = {
    routeTag: "market_cap_under_30m",
    feedType: "market_cap",
    observedAt,
    rawText: "XYZ < $30M scanner alert - Link"
  };
  const decision = buildPostingDecision({
    ai: {
      headline: "XYZ scanner alert",
      summary: "Market-cap scanner item.",
      eventType: "press_release"
    },
    data,
    articleText: "",
    articleSourceMode: "fetched_direct",
    signalDiagnostics: { signalQuality: "normal" },
    secSource: false,
    duplicateDiagnostics: {}
  });

  return {
    name: "stale market-cap scanner events are suppressed",
    type: "posting_decision",
    pass:
      isStaleMarketCapEvent(data) === true &&
      decision.allowPrimary === false &&
      decision.reasons.includes("market_cap_stale_suppressed"),
    decision
  };
}

function runMarketCap30To50PostingCase() {
  const data = {
    routeTag: "market_cap_30m_to_50m",
    feedType: "market_cap",
    observedAt: new Date().toISOString(),
    rawText: "XYZ 42.5 M $XYZ Example market-cap scanner alert - Link"
  };
  const decision = buildPostingDecision({
    ai: {
      headline: "XYZ scanner alert",
      summary: "Market-cap scanner item.",
      eventType: "press_release"
    },
    data,
    articleText: "",
    articleSourceMode: "headline_only_fallback",
    signalDiagnostics: { signalQuality: "normal" },
    secSource: false,
    duplicateDiagnostics: {}
  });

  return {
    name: "30M-to-50M market-cap scanner route posts unfiltered",
    type: "posting_decision",
    pass:
      isStaleMarketCapEvent(data) === false &&
      decision.allowPrimary === true &&
      decision.allowSpike === false &&
      decision.reasons.includes("market_cap_feed_unfiltered"),
    decision
  };
}

function runMarketCap50To100PostingCase() {
  const data = {
    routeTag: "market_cap_50m_to_100m",
    feedType: "market_cap",
    observedAt: new Date().toISOString(),
    rawText: "XYZ 78.2 M $XYZ Example market-cap scanner alert - Link"
  };
  const decision = buildPostingDecision({
    ai: {
      headline: "XYZ scanner alert",
      summary: "Market-cap scanner item.",
      eventType: "press_release"
    },
    data,
    articleText: "",
    articleSourceMode: "headline_only_fallback",
    signalDiagnostics: { signalQuality: "normal" },
    secSource: false,
    duplicateDiagnostics: {}
  });

  return {
    name: "50M-to-100M market-cap scanner route posts unfiltered",
    type: "posting_decision",
    pass:
      isStaleMarketCapEvent(data) === false &&
      decision.allowPrimary === true &&
      decision.allowSpike === false &&
      decision.reasons.includes("market_cap_feed_unfiltered"),
    decision
  };
}

function runDelayedNewsDumpRoutingCase() {
  const sourceUrl = "https://www.prnewswire.com/news-releases/example-release-302816114.html";
  const websiteUrl = "https://traderslink.pro/news/IMCC/example-release";

  return {
    name: "delayed news dump covers news-filtered and source-url fallbacks",
    type: "delayed_news_dump",
    pass:
      shouldScheduleDelayedNewsDump({
        postedMessages: [{ webhookUrl: "https://discord.com/api/webhooks/news-filtered" }],
        webhookOverrideUrl: ""
      }) === true &&
      shouldScheduleDelayedNewsDump({
        postedMessages: [],
        webhookOverrideUrl: ""
      }) === false &&
      shouldScheduleDelayedNewsDump({
        postedMessages: [{ webhookUrl: "https://discord.com/api/webhooks/news-filtered" }],
        webhookOverrideUrl: "https://discord.com/api/webhooks/override"
      }) === false &&
      buildFreeNewsArticleUrl({ freeArticleUrl: "" }, websiteUrl).includes("/news/free/IMCC/example-release") &&
      buildFreeNewsArticleUrl(null, sourceUrl) === sourceUrl,
    details: {
      newsFilteredSchedules: shouldScheduleDelayedNewsDump({
        postedMessages: [{ webhookUrl: "https://discord.com/api/webhooks/news-filtered" }],
        webhookOverrideUrl: ""
      }),
      sourceFallbackUrl: buildFreeNewsArticleUrl(null, sourceUrl),
      freeArticleUrl: buildFreeNewsArticleUrl({ freeArticleUrl: "" }, websiteUrl)
    }
  };
}

function runFreeNewsBotRoutingCase() {
  const options = {
    enabled: true,
    botToken: "test-token",
    routeTags: [
      "default",
      "market_cap_under_30m",
      "market_cap_30m_to_50m",
      "market_cap_50m_to_100m"
    ],
    webhookOverrideUrl: ""
  };
  const allowedDecision = { allowPrimary: true };
  const suppressedDecision = { allowPrimary: false };

  return {
    name: "free Discord bot receives whitelisted news dump routes only",
    type: "discord_free_news_bot",
    pass:
      shouldUseFreeNewsBotTargets("default", allowedDecision, options) === true &&
      shouldUseFreeNewsBotTargets("market_cap_under_30m", allowedDecision, options) === true &&
      shouldUseFreeNewsBotTargets("scanner_paid", allowedDecision, options) === false &&
      shouldUseFreeNewsBotTargets("default", suppressedDecision, options) === false &&
      shouldUseFreeNewsBotTargets("default", allowedDecision, {
        ...options,
        webhookOverrideUrl: "https://discord.com/api/webhooks/override"
      }) === false &&
      countNewsFilteredPosts([{ delivery: "discord_bot", freeNewsBot: true, channelId: "123" }]) === 1,
    details: {
      defaultAllowed: shouldUseFreeNewsBotTargets("default", allowedDecision, options),
      marketCapAllowed: shouldUseFreeNewsBotTargets("market_cap_under_30m", allowedDecision, options),
      scannerAllowed: shouldUseFreeNewsBotTargets("scanner_paid", allowedDecision, options),
      suppressedAllowed: shouldUseFreeNewsBotTargets("default", suppressedDecision, options),
      botPostCount: countNewsFilteredPosts([
        { delivery: "discord_bot", freeNewsBot: true, channelId: "123" }
      ])
    }
  };
}

function runExternalFreeNewsBotPayloadCase() {
  const payload = buildExternalFreeNewsBotPayload({
    data: {
      ticker: "IMCC",
      headline: "Host channel text should not be used",
      articleLink: "https://news.nuntiobot.com/article/private-source",
      rawText: "https://discord.com/channels/111/222/333"
    },
    ai: {
      headline: "IMCC announces processed news"
    },
    newsPublishResult: {
      articleUrl: "https://app.traderslink.pro/news/IMCC/example-release",
      freeArticleUrl: "https://app.traderslink.pro/news/free/IMCC/example-release"
    },
    articleUrl: "https://app.traderslink.pro/news/IMCC/example-release"
  });
  let accepted = false;
  let serialized = "";

  try {
    assertExternalFreeNewsBotPayload(payload);
    accepted = true;
    serialized = JSON.stringify(payload);
  } catch (_) {
    accepted = false;
  }

  return {
    name: "external free Discord bot gets processed TradersLink payload only",
    type: "discord_free_news_bot_boundary",
    pass:
      accepted === true &&
      payload?.content?.includes("https://app.traderslink.pro/news/free/IMCC/example-release") &&
      !serialized.includes("discord.com/channels/") &&
      !serialized.includes("news.nuntiobot.com") &&
      !serialized.includes("api/webhooks") &&
      !serialized.includes("sec.gov"),
    payload
  };
}

function runExternalFreeNewsBotRejectsSourceLeakCase() {
  const rejectedPayloads = [
    { embeds: [{ title: "legacy embed" }] },
    { content: "https://traderslink.pro/news/IMCC/example-release" },
    { content: "https://traderslink.pro/news/free/IMCC/example-release https://discord.com/channels/111/222/333" },
    { content: "https://traderslink.pro/news/free/IMCC/example-release https://news.nuntiobot.com/article/private" },
    { content: "https://traderslink.pro/news/free/IMCC/example-release https://www.sec.gov/Archives/example" },
    { content: "https://traderslink.pro/news/free/IMCC/example-release https://discord.com/api/webhooks/1/token" }
  ];
  const rejected = rejectedPayloads.map(payload => {
    try {
      assertExternalFreeNewsBotPayload(payload);
      return false;
    } catch (_) {
      return true;
    }
  });

  return {
    name: "external free Discord bot rejects upstream/source leak payloads",
    type: "discord_free_news_bot_boundary",
    pass: rejected.every(Boolean),
    rejected
  };
}

function runFreeNewsSubscriberTierBoundaryCase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "free-news-subscribers-"));
  const tempFile = path.join(tempDir, "subscribers.json");
  writeSubscriberStore(
    {
      subscribers: [
        {
          guildId: "111111111111111111",
          channelId: "222222222222222222",
          label: "Free enabled",
          tier: "free",
          enabled: true
        },
        {
          guildId: "333333333333333333",
          channelId: "444444444444444444",
          label: "Paid install",
          tier: "paid",
          enabled: true
        },
        {
          guildId: "555555555555555555",
          channelId: "666666666666666666",
          label: "Free disabled",
          tier: "free",
          enabled: false
        }
      ]
    },
    tempFile
  );

  const active = getActiveFreeNewsSubscribers(tempFile);
  fs.rmSync(tempDir, { recursive: true, force: true });

  return {
    name: "free news subscriber registry excludes paid and disabled installs",
    type: "discord_free_news_bot_registry",
    pass:
      active.length === 1 &&
      active[0]?.guildId === "111111111111111111" &&
      active[0]?.channelId === "222222222222222222" &&
      active[0]?.tier === "free",
    active
  };
}

function runFreeNewsSubscriberSelfServeBoundaryCase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "free-news-self-serve-"));
  const tempFile = path.join(tempDir, "subscribers.json");
  writeSubscriberStore(
    {
      subscribers: [
        {
          guildId: "111111111111111111",
          channelId: "222222222222222222",
          label: "Old free channel",
          tier: "free",
          enabled: true,
          createdAt: "2026-07-01T00:00:00.000Z"
        },
        {
          guildId: "111111111111111111",
          channelId: "333333333333333333",
          label: "Paid channel",
          tier: "paid",
          enabled: true
        }
      ]
    },
    tempFile
  );

  const next = setFreeNewsSubscriberForGuild(
    {
      guildId: "111111111111111111",
      channelId: "444444444444444444",
      label: "Moved free channel"
    },
    tempFile
  );
  const active = getActiveFreeNewsSubscribers(tempFile);
  const removed = removeFreeNewsSubscribersForGuild("111111111111111111", tempFile);
  const afterRemove = getActiveFreeNewsSubscribers(tempFile);

  fs.rmSync(tempDir, { recursive: true, force: true });

  return {
    name: "self-serve free bot setup keeps one free channel without touching paid installs",
    type: "discord_free_news_bot_registry",
    pass:
      next.channelId === "444444444444444444" &&
      next.createdAt === "2026-07-01T00:00:00.000Z" &&
      active.length === 1 &&
      active[0]?.channelId === "444444444444444444" &&
      removed === 1 &&
      afterRemove.length === 0,
    details: {
      next,
      active,
      removed,
      afterRemove
    }
  };
}

function runFreeNewsBotCommandRegistrationCase() {
  const setupCommand = FREE_NEWS_BOT_COMMANDS.find(command => command.name === "tl-news-setup");
  const commandNames = FREE_NEWS_BOT_COMMANDS.map(command => command.name);

  return {
    name: "self-serve free bot commands expose setup status and remove only",
    type: "discord_free_news_bot_commands",
    pass:
      commandNames.includes("tl-news-setup") &&
      commandNames.includes("tl-news-status") &&
      commandNames.includes("tl-news-remove") &&
      setupCommand?.options?.[0]?.type === 7 &&
      setupCommand?.default_member_permissions === "32" &&
      FREE_NEWS_BOT_COMMANDS.every(command => command.dm_permission === false),
    details: {
      commandNames,
      setupCommand
    }
  };
}

function runFreeNewsBotSetupErrorSanitizationCase() {
  const rawDiscordError = new Error(
    "Discord bot post failed 403: {\"message\":\"Missing Permissions\",\"code\":50013,\"debug\":\"private api body\"}"
  );
  const rawNetworkError = new Error("Discord API POST /interactions/1/token/callback failed 502: upstream body");
  const unknownError = new Error("unexpected local stack details");
  const discordMessage = getSetupFailureMessage(rawDiscordError);
  const networkMessage = getSetupFailureMessage(rawNetworkError);
  const unknownMessage = getSetupFailureMessage(unknownError);

  return {
    name: "self-serve free bot setup errors are sanitized for server admins",
    type: "discord_free_news_bot_commands",
    pass:
      /cannot post in that channel/i.test(discordMessage) &&
      /could not reach Discord/i.test(networkMessage) &&
      unknownMessage === "Setup failed. Please try again in a minute." &&
      !/50013|private api body|upstream body|stack details/i.test(
        [discordMessage, networkMessage, unknownMessage].join(" ")
      ),
    details: {
      discordMessage,
      networkMessage,
      unknownMessage
    }
  };
}

function runMarketCapBundleExpansionCase() {
  const rawText = [
    "30.2 M OPTH : Optimi Health Completes Commercial Psilocybin Production to Address Treatment-Resistant Depression in Australia - Link",
    "78.2 M BODI : The Beachbody Company, Inc., to Participate in the Noble Capital Markets Emerging Growth Virtual Equity Conference - Link",
    "31.7 M QUCY : Quantum Cyber Assumes Direct Manufacturing of Autonomous Drone; Expands BP United Agreement - Link",
    "23.5 M SDST : Stardust Power Included in DOE-Funded Lithium Initiative - Link",
    "27.2 M DFLI : Will Prowse Sued by Dragonfly Energy Over Alleged False and Misleading Claims About Battle Born Batteries - Link",
    "3.1 M KIDZ : KIDZ AI Announces Strategic Treasury Pivot to Hyperliquid Ecosystem and Yield-Bearing Stablecoin Strategies - Link"
  ].join(" ");
  const articleLinks = [
    "https://news.nuntiobot.com/article/opth",
    "https://news.nuntiobot.com/article/bodi",
    "https://news.nuntiobot.com/article/qucy",
    "https://news.nuntiobot.com/article/sdst",
    "https://news.nuntiobot.com/article/dfli",
    "https://news.nuntiobot.com/article/kidz"
  ];
  const items = expandMarketCapBundleData(
    {
      id: "chat-messages-1280514882676199506-1511331075220050031",
      observedAt: "2026-06-02T11:30:07.305Z",
      messageTimestamp: "2026-06-02T11:30:07.506Z",
      rawText,
      articleLink: articleLinks[0],
      articleLinks,
      routeTag: "market_cap_bundle",
      feedType: "market_cap"
    },
    [
      {
        routeTag: "market_cap_under_30m",
        minExclusive: null,
        maxInclusive: 30000000,
        label: "<= $30M"
      },
      {
        routeTag: "market_cap_30m_to_50m",
        minExclusive: 30000000,
        maxInclusive: 50000000,
        label: "> $30M and <= $50M"
      },
      {
        routeTag: "market_cap_50m_to_100m",
        minExclusive: 50000000,
        maxInclusive: 100000000,
        label: "> $50M and <= $100M"
      }
    ]
  );
  const qucy = items.find(item => item.ticker === "QUCY");
  const bodi = items.find(item => item.ticker === "BODI");

  return {
    name: "market-cap bundle expands QUCY and BODI into routed events",
    type: "market_cap_bundle_expansion",
    pass:
      items.length === 6 &&
      Boolean(qucy) &&
      Boolean(bodi) &&
      qucy.routeTag === "market_cap_30m_to_50m" &&
      bodi.routeTag === "market_cap_50m_to_100m" &&
      qucy.articleLink === "https://news.nuntiobot.com/article/qucy" &&
      bodi.articleLink === "https://news.nuntiobot.com/article/bodi" &&
      qucy.id.endsWith(":mc2:QUCY") &&
      qucy.rawText.startsWith("31.7 M QUCY") &&
      bodi.rawText.startsWith("78.2 M BODI") &&
      !/OPTH|BODI/.test(qucy.rawText),
    routedTickers: items.map(item => item.ticker),
    qucy,
    bodi
  };
}

async function run() {
  const cases = [
    await runSecSelectionCase({
      name: "CMND 6-K chooses EX-99.1 press release",
      url: "https://www.sec.gov/Archives/edgar/data/1892500/000121390026045585/0001213900-26-045585-index.htm",
      rawText: "CMND SEC - Form 6-K - Link",
      expectedKind: "current_report_exhibit",
      expectedUrlIncludes: "ex99-1"
    }),
    await runSecSelectionCase({
      name: "EXTR 8-K avoids wrapper and chooses EX-99.1",
      url: "https://www.sec.gov/Archives/edgar/data/1078271/000119312526188948/0001193125-26-188948-index.htm",
      rawText: "EXTR SEC - Form 8-K - Link",
      expectedKind: "current_report_exhibit",
      expectedUrlIncludes: "extr-ex99_1"
    }),
    await runSecSelectionCase({
      name: "SLNH EFFECT follows underlying registration filing",
      url: "https://www.sec.gov/Archives/edgar/data/64463/999999999526001245/9999999995-26-001245-index.htm",
      rawText: "SLNH SEC - Form EFFECT - Link",
      expectedKind: "effect_underlying_registration",
      expectedUrlIncludes: "0001493152-26-018102"
    }),
    runClosedOfferingCase(),
    runCompletedWarrantExerciseCase(),
    runLockedPipeCase(),
    runNexrRegisteredDirectExpectedCloseCase(),
    runTghlConditionalMergerDilutionCase(),
    runHostStartupBackfillContractCase(),
    runLowSignalPressReleaseCase(),
    runRecentDuplicateCase(),
    runCrossDestinationDuplicateCase(),
    runBulletSanitizationCase(),
    runUnreadableUrlFallbackGroundingCase(),
    runFallbackArticleLinkEmbedCase(),
    runReadableSourceAttributionCleanupCase(),
    runReadableUrlFallbackPostingCase(),
    runStandardPressReleasePostingCase(),
    runStandardSecPostingCase(),
    runHeadlineOnlyCatalystPostingCase(),
    runSpikeRoutePostsCase(),
    runCurrentDateDilutionSuppressionCase(),
    runBadNewsSuppressionCase(),
    runImmediateDilutionSuppressionCase(),
    runBusinessWireHeadlineOnlyCase(),
    runReverseSplitSuppressionCase(),
    runStaleMarketCapSuppressionCase(),
    runMarketCap30To50PostingCase(),
    runMarketCap50To100PostingCase(),
    runDelayedNewsDumpRoutingCase(),
    runFreeNewsBotRoutingCase(),
    runExternalFreeNewsBotPayloadCase(),
    runExternalFreeNewsBotRejectsSourceLeakCase(),
    runFreeNewsSubscriberTierBoundaryCase(),
    runFreeNewsSubscriberSelfServeBoundaryCase(),
    runFreeNewsBotCommandRegistrationCase(),
    runFreeNewsBotSetupErrorSanitizationCase(),
    runMarketCapBundleExpansionCase()
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
