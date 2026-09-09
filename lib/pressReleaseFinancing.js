const { cleanText } = require("./utils");

function normalizeTimingDate(rawValue) {
  const text = cleanText(rawValue || "");
  if (!text) return null;

  const match = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|May|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?)\s+\d{1,2},\s+\d{4}\b/i
  );

  if (!match) return null;

  return match[0]
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .replace(/^Sept\b/i, "Sep");
}

function inferClosingDate(text) {
  const cleaned = cleanText(text || "");
  if (!cleaned) return null;

  const patterns = [
    /expected to close on ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expects to close on ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expected to close on or about ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expects to close on or about ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expects to close .*? on or about ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expected to close .*? on or about ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /closing expected on ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expected to occur on or about ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /offering is expected to close on or about ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /private placement is expected to close on or about ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expected closing date(?: is)? ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      return normalizeTimingDate(match[1]);
    }
  }

  return null;
}

function inferFundingDate(text) {
  const cleaned = cleanText(text || "");
  if (!cleaned) return null;

  const patterns = [
    /funding expected on ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /funding expected ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expected funding on ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /funding .*? expected .*? ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      return normalizeTimingDate(match[1]);
    }
  }

  return null;
}

function monthNumberFromName(value) {
  const normalized = String(value || "").toLowerCase().replace(/\./g, "");
  const map = {
    january: 0,
    jan: 0,
    february: 1,
    feb: 1,
    march: 2,
    mar: 2,
    april: 3,
    apr: 3,
    may: 4,
    june: 5,
    jun: 5,
    july: 6,
    jul: 6,
    august: 7,
    aug: 7,
    september: 8,
    sep: 8,
    sept: 8,
    october: 9,
    oct: 9,
    november: 10,
    nov: 10,
    december: 11,
    dec: 11
  };

  return Object.prototype.hasOwnProperty.call(map, normalized) ? map[normalized] : null;
}

function monthNameFromNumber(value) {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][value] || null;
}

function parseMonthCount(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const wordMap = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    eighteen: 18,
    twentyfour: 24,
    "twenty-four": 24,
    twenty_four: 24
  };

  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  return wordMap[normalized.replace(/\s+/g, "")] || wordMap[normalized] || null;
}

function addMonthsToDisplayDate(displayDate, monthsToAdd) {
  const parts = cleanText(displayDate || "").match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  const months = Number(monthsToAdd);
  if (!parts || !Number.isFinite(months) || months <= 0) return null;

  const monthIndex = monthNumberFromName(parts[1]);
  if (monthIndex === null) return null;

  const date = new Date(Date.UTC(Number(parts[3]), monthIndex, Number(parts[2])));
  date.setUTCMonth(date.getUTCMonth() + months);

  const monthName = monthNameFromNumber(date.getUTCMonth());
  if (!monthName) return null;

  return `${monthName} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function inferLockupExpiryDate(text) {
  const cleaned = cleanText(text || "");
  if (!cleaned || !/(lock-?up|lockup)/i.test(cleaned)) return null;

  const date = normalizeTimingDate(cleaned);
  if (!date) return null;

  const patterns = [
    /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty[- ]?four)[-\s]?month\s+lock-?up.{0,120}?(?:commencing|beginning|starting|from)\s+(?:on\s+)?[A-Za-z.]+\s+\d{1,2},\s+\d{4}/i,
    /lock-?up\s+(?:period\s+)?(?:of\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty[- ]?four)\s+months?.{0,120}?(?:commencing|beginning|starting|from)\s+(?:on\s+)?[A-Za-z.]+\s+\d{1,2},\s+\d{4}/i,
    /subject to (?:a\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty[- ]?four)[-\s]?month\s+lock-?up.{0,120}?(?:commencing|beginning|starting|from)\s+(?:on\s+)?[A-Za-z.]+\s+\d{1,2},\s+\d{4}/i
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    const months = parseMonthCount(match?.[1]);
    const expiryDate = addMonthsToDisplayDate(date, months);
    if (expiryDate) return expiryDate;
  }

  return null;
}

function inferRightsExpiryDate(text) {
  const cleaned = cleanText(text || "");
  if (!cleaned) return null;

  const patterns = [
    /expected to expire at .*? on ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expected to expire .*? on ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /rights .*? expected to expire at .*? on ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expire at .*? on ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
    /expiration date(?: is)? ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      return normalizeTimingDate(match[1]);
    }
  }

  return null;
}

function buildPressReleaseFinancingScanText(rawDiscordMessage, articleText = "") {
  const raw = cleanText(rawDiscordMessage || "");
  let article = cleanText(articleText || "");

  // PRNewswire and similar pages include navigation/categories and "also from this source"
  // blocks that can mention offerings unrelated to the current article.
  article = article
    .replace(/^[\s\S]*?\bNews provided by\b/i, "")
    .replace(/\bAlso from this source\b[\s\S]*$/i, "")
    .replace(/\bMore Releases From This Source\b[\s\S]*$/i, "")
    .replace(/\bForward-Looking Statements\b[\s\S]*$/i, "");

  return `${raw} ${cleanText(article)}`.trim();
}

function isFinancialResultsPressRelease(rawDiscordMessage, articleText = "") {
  const scanText = buildPressReleaseFinancingScanText(rawDiscordMessage, articleText);
  if (!scanText) return false;

  const leadText = cleanText(scanText).slice(0, 2500);
  const hasResultsSignal = /(\b(?:reports?|announces?|posts?|expects?|preliminary|unaudited)\b.{0,120}\b(?:q[1-4]|first quarter|second quarter|third quarter|fourth quarter|quarterly|annual|fiscal|full[- ]year|fy\d{2,4}|revenue|revenues|eps|earnings|net income|net loss|financial results|guidance|outlook)\b|\b(?:q[1-4]|first quarter|second quarter|third quarter|fourth quarter|fy\d{2,4})\b.{0,80}\b(?:revenue|revenues|eps|earnings|net income|net loss|results|guidance)\b|\b(?:revenue|revenues|eps|net income|net loss)\b.{0,80}\b(?:up|down|increase|decrease|growth|year[- ]over[- ]year|yoy|quarter|fiscal|guidance)\b)/i.test(
    leadText
  );
  if (!hasResultsSignal) return false;

  const hasCurrentOfferingSignal = /(announces?\s+(?:pricing of|closing of|proposed|commencement of|launch of|upsized|registered direct|private placement)|public offering price|expected to close|securities purchase agreement|placement agent|underwritten offering|best[- ]efforts offering|gross proceeds from (?:the|this|its) offering|net proceeds from (?:the|this|its) offering)/i.test(
    scanText
  );

  return !hasCurrentOfferingSignal;
}

function detectPressReleaseTransactionStage(text) {
  const cleaned = cleanText(text || "");
  if (!cleaned) return null;

  if (/(announced the closing of|announces closing of|offering closed on|transaction closed|private placement closed|closing has occurred|gross proceeds were received|shares were issued|option exercise closed on|additional share option was exercised|over-allotment option.*exercised|full exercise of underwriters option|\bclosed (?:a|an|its|the) .*?(?:offering|private placement|registered direct|public offering)\b)/i.test(cleaned)) {
    return "closed";
  }

  if (/(announced the pricing of|pricing of|priced .*offering|priced at-the-market|public offering price)/i.test(cleaned)) {
    return "priced";
  }

  if (/(proposed (?:underwritten )?public offering|launch of .*offering|launch-stage .*offering|commenced an .*offering|commencement of .*offering|announce(?:s|d)? (?:a )?public offering|announce(?:s|d)? public offering of|intends to offer|subject to market and other conditions|no assurance as to whether or when)/i.test(cleaned)) {
    return "proposed";
  }

  return null;
}

function hasCompletedWarrantExerciseContext(text) {
  const cleaned = cleanText(text || "");
  if (!cleaned) return false;

  const completedExerciseSignal =
    /warrant inducement(?: transaction)?|announces? exercise of (?:existing )?warrants?|exercise of warrants for cash|cash exercise of (?:existing )?warrants?|warrant holders?.{0,120}exercised|holders?.{0,120}exercised.{0,80}warrants?|warrants?.{0,60}(?:have|has|were|was)(?:\s+been)?(?:\s+\w+){0,4}\s+exercised|completed warrant exercises?|exercises? (?:are|were|is|was) complete|no exercisable warrants remain/i.test(
      cleaned
    );
  if (!completedExerciseSignal) return false;

  const clearCompletionContext =
    /gross proceeds|net proceeds|funds (?:have been|were) received|proceeds (?:have been|were) received|received from (?:the )?warrant exercises?|completed warrant exercises?|no exercisable warrants remain|no longer includes any exercisable warrants|all outstanding debt obligations|debt-free|balance sheet/i.test(
      cleaned
    );
  const futureExerciseOnly =
    /future warrant exercise|later through warrant exercise|become exercisable|warrants become exercisable|potential future cash exercise|if fully exercised|upon exercise of (?:the )?warrants|excluding (?:the )?(?:exercise of warrants|warrant exercise proceeds)/i.test(
      cleaned
    );

  return clearCompletionContext || !futureExerciseOnly;
}

function extractPressReleasePhase1Signals({ articleText = "", summaryText = "", eventType = "" }) {
  const combinedText = cleanText(`${articleText} ${summaryText}`.trim());
  const loweredEventType = cleanText(eventType).toLowerCase();
  const mentionsPrivatePlacement = /private placement|\bpipe\b/i.test(combinedText);
  const negatesPrivatePlacement = /(?:not a private placement|rather than (?:a )?private placement|outside the ordinary .*private placement bucket)/i.test(
    combinedText
  );
  const mentionsRegisteredDirect = /registered direct/i.test(combinedText);
  const negatesRegisteredDirect = /(?:not a registered direct|rather than (?:a )?registered direct|outside the ordinary .*registered direct bucket)/i.test(
    combinedText
  );
  const transactionStage = detectPressReleaseTransactionStage(combinedText);
  const earliestKnownDate = inferClosingDate(combinedText);
  const rightsExpiryDate = inferRightsExpiryDate(combinedText);
  const needsClosing = Boolean(
    earliestKnownDate ||
    /(expected to close on|expected to close on or about|expected to occur on or about|subject to customary closing conditions|subject to the satisfaction of customary closing conditions)/i.test(
      combinedText
    ) ||
    /(expected future close date|clear expected future close date|clear future-close timing|clear future close timing|future close timing|future-close timing|future-close case|future close case|expected close date|expected close timing|clear close timing|delayed closing timing|delayed until closing|actual issuance is still delayed until closing|already closed)/i.test(
      combinedText
    )
  );
  const mentionsAnotherFiling = /(?:agreed to file (?:a )?(?:resale )?registration statement(?:\(s\))?|agreed to file a registration statement|registration rights agreement|registration-rights|resale-registration|resale registration|rights agreement and rights certificate.*filed|another filing needed|requires another filing|public resale requires another filing|depends on (?:a )?later (?:resale )?registration|may still depend on later registration|later registration or exemption language)/i.test(
    combinedText
  );
  const negatesAnotherFiling = /(?:not (?:a |the )?(?:(?:future|later|separate)\s+)*(?:public\s+)?(?:resale[- ]?)?registration(?: step| process| event)?|rather than (?:to )?(?:a |the )?(?:(?:future|later|separate)\s+)*(?:public\s+)?(?:resale[- ]?)?registration(?: step| process| event)?|rather than .*?(?:(?:future|later|separate)\s+)*(?:public\s+)?(?:resale[- ]?)?registration(?: timing|step|process|event)?|rather than a private placement (?:that )?(?:depends on|requiring) a later (?:public\s+)?(?:resale[- ]?)?registration|not a private placement (?:that )?(?:depends on|requires|requiring) a later (?:public\s+)?(?:resale[- ]?)?registration|not a future registration event)/i.test(
    combinedText
  );
  const needsAnotherFiling = mentionsAnotherFiling && !negatesAnotherFiling;
  const needsEffectiveness = /(upon effectiveness|after sec effectiveness|effectiveness date|effectiveness gating|later of the stockholder approval date and the effectiveness date|declared effective for resale)/i.test(
    combinedText
  );
  const needsShareholderApproval = /(shareholder approval|stockholder approval|shareholder-approval|stockholder-approval|authorized shares)/i.test(
    combinedText
  );
  const hasMixedImmediateAndFutureSupply =
    /(common stock|ordinary shares)/i.test(combinedText) &&
    /(pre-funded warrant|warrant|series a warrant|series b warrant|concurrent private placement)/i.test(combinedText);
  const isCompanyControlledFutureSales =
    (
      loweredEventType === "press_release_at_the_market_financing" &&
      !/(priced at-the-market under nasdaq rules|priced at the market under nasdaq rules|best-efforts offering|best efforts offering)/i.test(
        combinedText
      )
    ) ||
    (/(at-the-market|at the market|\batm\b)/i.test(combinedText) &&
      /(from time to time|sales, if any|may offer and sell|not obligated to sell|equity purchase agreement|committed equity facility|purchase notice|draw down)/i.test(combinedText));
  const isSecondaryOffering = /(secondary offering|selling shareholders?|selling stockholders?)/i.test(combinedText);
  const isSellingShareholderOnly =
    /(selling shareholders?|selling stockholders?)/i.test(combinedText) &&
    /(company is not selling any shares|company will not receive any proceeds|company is not offering any shares|will not receive any proceeds|not issuing or selling any shares)/i.test(combinedText);
  const hasConcurrentRepurchase = /(concurrent repurchase|concurrent share repurchase|intends to purchase shares from the underwriters|share repurchase)/i.test(
    combinedText
  );
  const hasResaleRestriction = /(have not been registered under the securities act|may not be offered or sold except pursuant to an effective registration statement or an applicable exemption|unregistered|reliance on an exemption from registration)/i.test(
    combinedText
  );
  const isPrivatePlacement =
    loweredEventType === "press_release_private_placement" ||
    (mentionsPrivatePlacement && !negatesPrivatePlacement);
  const isRegisteredDirect =
    loweredEventType === "press_release_registered_direct" ||
    (mentionsRegisteredDirect && !negatesRegisteredDirect);
  const isRightsOffering =
    /rights offering|subscription rights|oversubscription privilege|rights certificate|record date holders/i.test(combinedText);
  const isForwardSaleStructure =
    /offered on a forward basis|forward sale agreements?|forward purchasers?|upon settlement of the forward sale agreements/i.test(
      combinedText
    );

  const reasonCodes = [];
  if (transactionStage === "proposed") reasonCodes.push("proposed_offering_only");
  if (transactionStage === "priced" && needsClosing) reasonCodes.push("priced_not_closed");
  if (transactionStage === "closed") reasonCodes.push("closed_common_issued");
  if (earliestKnownDate && needsClosing) reasonCodes.push("close_expected_future_date");
  if (needsAnotherFiling) reasonCodes.push("needs_another_filing");
  if (needsEffectiveness) reasonCodes.push("needs_sec_effectiveness");
  if (needsShareholderApproval) reasonCodes.push("shareholder_approval_needed");
  if (isCompanyControlledFutureSales) reasonCodes.push("company_sale_activation_needed");
  if (hasMixedImmediateAndFutureSupply) reasonCodes.push("mixed_immediate_and_future_supply");
  if (isRightsOffering && rightsExpiryDate) reasonCodes.push("rights_offering_expiry_date");
  if (isForwardSaleStructure) reasonCodes.push("forward_sale_structure");
  if (/(milestone-linked warrants?|milestone warrants?|milestone trigger)/i.test(combinedText)) {
    reasonCodes.push("milestone_trigger");
  }
  if (isPrivatePlacement && (hasResaleRestriction || needsAnotherFiling)) {
    reasonCodes.push("private_placement_with_resale_rights");
  }
  if (isSecondaryOffering && isSellingShareholderOnly) {
    reasonCodes.push("secondary_offering_selling_shareholder");
  }
  if (hasConcurrentRepurchase) {
    reasonCodes.push("concurrent_share_repurchase");
  }

  return {
    transactionStage,
    earliestKnownDate,
    rightsExpiryDate,
    needsClosing,
    needsAnotherFiling,
    needsEffectiveness,
    needsShareholderApproval,
    hasMixedImmediateAndFutureSupply,
    isCompanyControlledFutureSales,
    isSecondaryOffering,
    isSellingShareholderOnly,
    hasConcurrentRepurchase,
    hasResaleRestriction,
    isPrivatePlacement,
    isRegisteredDirect,
    isRightsOffering,
    isForwardSaleStructure,
    reasonCodes
  };
}

function hasPressReleaseFinancingText(rawDiscordMessage, articleText = "") {
  if (isFinancialResultsPressRelease(rawDiscordMessage, articleText)) {
    return false;
  }

  const combinedText = buildPressReleaseFinancingScanText(rawDiscordMessage, articleText).toUpperCase();
  const keywordHits = [
    /PUBLIC OFFERING/,
    /PROPOSED PUBLIC OFFERING/,
    /REGISTERED DIRECT OFFERING/,
    /PRIVATE PLACEMENT/,
    /\bPIPE\b/,
    /SECURITIES PURCHASE AGREEMENT/,
    /PRE-FUNDED WARRANT/,
    /WARRANT/,
    /GROSS PROCEEDS/,
    /NET PROCEEDS/,
    /EXPECTED TO CLOSE/,
    /EXPECTED TO OCCUR/,
    /ON OR ABOUT/,
    /UNDERWRITTEN OFFERING/,
    /BEST[- ]EFFORTS/,
    /PLACEMENT AGENT/,
    /PRICED AT[- ]THE[- ]MARKET/,
    /AT[- ]THE[- ]MARKET/
  ].filter(pattern => pattern.test(combinedText)).length;

  if (
    /(ANNOUNCES\s+(?:PRICING OF|PROPOSED|COMMENCEMENT OF|LAUNCH OF|UPSIZED|REGISTERED DIRECT|PRIVATE PLACEMENT))/i.test(
      combinedText
    )
  ) {
    return true;
  }

  return keywordHits >= 2;
}

function derivePressReleaseEventType(aiEventType, articleText = "", rawDiscordMessage = "") {
  const normalizedAI = cleanText(aiEventType || "").toLowerCase();
  const combinedText = `${buildPressReleaseFinancingScanText(rawDiscordMessage, articleText)} ${normalizedAI}`.toLowerCase();

  if (isFinancialResultsPressRelease(rawDiscordMessage, articleText)) {
    return "press_release_earnings";
  }

  if (
    /(initial public offering|announces? (?:the )?(?:pricing|launch|closing) of .*initial public offering|announces? .*initial public offering|closing of .*initial public offering|\bipo launch\b|\bipo pricing\b|\bipo closes?\b)/.test(
      combinedText
    )
  ) {
    return "press_release_ipo";
  }
  if (/registered direct/.test(combinedText)) return "press_release_registered_direct";
  if (
    /(at[- ]the[- ]market|priced at[- ]the[- ]market).{0,80}(offering|facility|program|shares|stock|securities|nasdaq rules)|(?:offering|facility|program|shares|stock|securities).{0,80}(at[- ]the[- ]market|priced at[- ]the[- ]market)/.test(
      combinedText
    )
  ) {
    return "press_release_at_the_market_financing";
  }
  if (hasCompletedWarrantExerciseContext(combinedText)) {
    return "press_release_warrant_financing";
  }
  if (
    /proposed public offering|commenced an underwritten public offering|launch of underwritten public offering|launch of public offering|announce(?:s|d)? public offering of|announce(?:s|d)? a public offering of|announce(?:s|d)? launch of .*initial public offering|launch of .*initial public offering|commencement of secondary public offering|announce(?:s|d)? commencement of secondary public offering|launch of public offering by selling stockholders/i.test(
      combinedText
    ) &&
    !/announced pricing of|pricing of .*offering|priced .*offering|public offering price/i.test(combinedText)
  ) {
    return "press_release_offering_proposed";
  }
  if (/pricing of .*offering|priced .*offering|public offering price|announced pricing of .*offering|best efforts public offering/i.test(combinedText)) {
    return "press_release_offering_pricing";
  }
  if (/private placement|\bpipe\b/.test(combinedText)) return "press_release_private_placement";
  if (hasPressReleaseFinancingText(rawDiscordMessage, articleText)) {
    return "press_release_financing";
  }
  if (normalizedAI.includes("clinical")) return "press_release_clinical";
  if (normalizedAI.includes("earnings")) return "press_release_earnings";
  return "press_release";
}

function normalizePressReleaseTimingInputs({
  rawStatus,
  rawTriggerType,
  rawTriggerDate,
  articleText,
  summaryText,
  eventType
}) {
  const combinedText = `${cleanText(articleText || "")} ${cleanText(summaryText || "")}`.trim();
  const phase1Signals = extractPressReleasePhase1Signals({
    articleText,
    summaryText,
    eventType
  });
  const closingDate = normalizeTimingDate(rawTriggerDate) || inferClosingDate(combinedText);
  const fundingDate = inferFundingDate(combinedText);
  const lockupExpiryDate = inferLockupExpiryDate(combinedText);

  if (
    phase1Signals.isPrivatePlacement &&
    lockupExpiryDate &&
    /(class a ordinary shares|ordinary shares|common shares|common stock|pipe|private placement)/i.test(combinedText)
  ) {
    return {
      rawStatus: "delayed",
      rawTriggerType: "lockup_expiry",
      rawTriggerDate: lockupExpiryDate,
      phase1Signals
    };
  }

  if (phase1Signals.isSecondaryOffering && phase1Signals.isSellingShareholderOnly) {
    return {
      rawStatus: closingDate ? "conditional" : null,
      rawTriggerType: closingDate ? "closing" : null,
      rawTriggerDate: closingDate || null,
      phase1Signals
    };
  }

  if (phase1Signals.isSecondaryOffering && phase1Signals.hasConcurrentRepurchase) {
    return {
      rawStatus: "conditional",
      rawTriggerType: "settlement",
      rawTriggerDate: closingDate || null,
      phase1Signals
    };
  }

  if (
    eventType === "press_release_ipo" &&
    /(launch of .*initial public offering|announced the launch of .*initial public offering|ipo launch case|later ipo pricing)/i.test(
      combinedText
    )
  ) {
    return {
      rawStatus: "conditional",
      rawTriggerType: "ipo_pricing",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (phase1Signals.isCompanyControlledFutureSales) {
    return {
      rawStatus: "conditional",
      rawTriggerType: "purchase_trigger",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (
    hasCompletedWarrantExerciseContext(combinedText) ||
    /already exercised or agreed to exercise|already triggered warrant exercise/i.test(combinedText)
  ) {
    return {
      rawStatus: "live_now",
      rawTriggerType: "already_triggered",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (
    phase1Signals.isRightsOffering && phase1Signals.rightsExpiryDate) {
    return {
      rawStatus: "delayed",
      rawTriggerType: "rights_expiry",
      rawTriggerDate: phase1Signals.rightsExpiryDate,
      phase1Signals
    };
  }

  if (phase1Signals.isPrivatePlacement && fundingDate) {
    return {
      rawStatus: "delayed",
      rawTriggerType: "settlement",
      rawTriggerDate: fundingDate,
      phase1Signals
    };
  }

  if (
    phase1Signals.transactionStage === "closed" ||
    /has already closed|already closed|private placement closed/i.test(combinedText)
  ) {
    return {
      rawStatus: "live_now",
      rawTriggerType: "already_triggered",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (
    phase1Signals.isPrivatePlacement &&
    /(milestone-linked warrants?|milestone warrants?|milestone trigger)/i.test(combinedText)
  ) {
    return {
      rawStatus: "conditional",
      rawTriggerType: "milestone",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (phase1Signals.isForwardSaleStructure && phase1Signals.transactionStage === "priced") {
    return {
      rawStatus: "delayed",
      rawTriggerType: "settlement",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (phase1Signals.needsAnotherFiling) {
    if (
      phase1Signals.needsShareholderApproval &&
      /(later of the .*stockholder approval date|if stockholder approval is required|stockholder approval is required to increase authorized shares|following stockholder approval|upon stockholder approval|warrants become exercisable following stockholder approval)/i.test(
        combinedText
      )
    ) {
      return {
        rawStatus: "conditional",
        rawTriggerType: "shareholder_approval",
        rawTriggerDate: null,
        phase1Signals
      };
    }

    if (phase1Signals.isRegisteredDirect && phase1Signals.transactionStage === "priced" && phase1Signals.needsClosing && closingDate) {
      return {
        rawStatus: "delayed",
        rawTriggerType: "closing",
        rawTriggerDate: closingDate,
        phase1Signals
      };
    }

    return {
      rawStatus: "conditional",
      rawTriggerType: "filing_needed",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (phase1Signals.needsShareholderApproval) {
    return {
      rawStatus: "conditional",
      rawTriggerType: "shareholder_approval",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (
    phase1Signals.isRegisteredDirect &&
    (phase1Signals.needsClosing ||
      /announced .*registered direct offering|registered direct structure means|registered direct financing case|registered direct case|registered direct offering\./i.test(
        combinedText
      )) &&
    !closingDate
  ) {
    return {
      rawStatus: "delayed",
      rawTriggerType: null,
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (
    phase1Signals.isPrivatePlacement &&
    phase1Signals.needsClosing &&
    !closingDate
  ) {
    return {
      rawStatus: "conditional",
      rawTriggerType: null,
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (phase1Signals.transactionStage === "proposed") {
    return {
      rawStatus: "conditional",
      rawTriggerType: null,
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (
    phase1Signals.transactionStage === "priced" &&
    !closingDate &&
    !phase1Signals.needsAnotherFiling &&
    !phase1Signals.needsShareholderApproval &&
    !phase1Signals.isForwardSaleStructure &&
    !/(preferred stock|depositary shares|debt offering|debt financing|senior notes?|notes due|initial public offering|\bipo\b)/i.test(combinedText)
  ) {
    return {
      rawStatus: "delayed",
      rawTriggerType: null,
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (/(underwriters exercised (?:their )?over-allotment option|exercise of over-allotment option|recently completed marketed public offering|results in additional aggregate gross proceeds|additional share option was exercised|option exercise closed on|already closed)/i.test(combinedText)) {
    return {
      rawStatus: "live_now",
      rawTriggerType: "already_triggered",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (phase1Signals.isForwardSaleStructure) {
    return {
      rawStatus: "conditional",
      rawTriggerType: "settlement",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (/has closed the offering|closed the offering|consummated the private placement|closing has occurred/i.test(combinedText)) {
    return {
      rawStatus: "live_now",
      rawTriggerType: "closing",
      rawTriggerDate: closingDate,
      phase1Signals
    };
  }

  if (closingDate && /(expected to close on or about|expected to occur on or about|subject to satisfaction of customary closing conditions|subject to customary closing conditions)/i.test(combinedText)) {
    if (phase1Signals.isRegisteredDirect) {
      return {
        rawStatus: "delayed",
        rawTriggerType: "closing",
        rawTriggerDate: closingDate,
        phase1Signals
      };
    }

    if (phase1Signals.isPrivatePlacement && !phase1Signals.isRegisteredDirect) {
      if (!phase1Signals.needsAnotherFiling && !phase1Signals.needsShareholderApproval && /(bought deal|underwriter|underwritten)/i.test(combinedText)) {
        return {
          rawStatus: "delayed",
          rawTriggerType: "closing",
          rawTriggerDate: closingDate,
          phase1Signals
        };
      }

      return {
        rawStatus: "conditional",
        rawTriggerType: phase1Signals.hasResaleRestriction ? "filing_needed" : null,
        rawTriggerDate: null,
        phase1Signals
      };
    }

    return {
      rawStatus: "delayed",
      rawTriggerType: "closing",
      rawTriggerDate: closingDate,
      phase1Signals
    };
  }

  if (closingDate && phase1Signals.needsClosing) {
    if (phase1Signals.isRegisteredDirect) {
      return {
        rawStatus: "delayed",
        rawTriggerType: "closing",
        rawTriggerDate: closingDate,
        phase1Signals
      };
    }

    if (phase1Signals.isPrivatePlacement && !phase1Signals.isRegisteredDirect) {
      if (!phase1Signals.needsAnotherFiling && !phase1Signals.needsShareholderApproval && /(bought deal|underwriter|underwritten)/i.test(combinedText)) {
        return {
          rawStatus: "delayed",
          rawTriggerType: "closing",
          rawTriggerDate: closingDate,
          phase1Signals
        };
      }

      return {
        rawStatus: "conditional",
        rawTriggerType: phase1Signals.hasResaleRestriction ? "filing_needed" : null,
        rawTriggerDate: null,
        phase1Signals
      };
    }

    return {
      rawStatus: "delayed",
      rawTriggerType: "closing",
      rawTriggerDate: closingDate,
      phase1Signals
    };
  }

  if (
    eventType === "press_release_at_the_market_financing" &&
    /(at[- ]the[- ]market|at the market)/i.test(combinedText) &&
    /(sales agreement|sales agent|from time to time)/i.test(combinedText)
  ) {
    return {
      rawStatus: "conditional",
      rawTriggerType: "purchase_trigger",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (
    eventType === "press_release_offering_proposed" &&
    /(subject to market and other conditions|no assurance as to whether or when|no assurance.*actual size or terms)/i.test(combinedText)
  ) {
    return {
      rawStatus: "conditional",
      rawTriggerType: null,
      rawTriggerDate: null,
      phase1Signals
    };
  }

  return {
    rawStatus,
    rawTriggerType,
    rawTriggerDate,
    phase1Signals
  };
}

function replaceOrAppendTimingSentence(text, replacement) {
  if (/Timing:\s*[^.]+(?:\.)?/i.test(text)) {
    return text.replace(/Timing:\s*[^.]+(?:\.)?/i, replacement);
  }

  return `${text} ${replacement}`.trim();
}

function cleanEarliestDilutionDetail(earliestDilution) {
  return cleanText(earliestDilution || "")
    .replace(/^Earliest (?:dilution|sellable supply):\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanClosingDetail(earliestDilution) {
  return cleanEarliestDilutionDetail(earliestDilution)
    .replace(/\s+clos(?:e|ing)$/i, "")
    .trim();
}

function harmonizePressReleaseFinancingSummary(summary, timingMeta) {
  let text = cleanText(summary || "");
  if (!text) return text;

  const canDiluteToday = cleanText(timingMeta?.canDiluteToday || "");
  const triggerType = cleanText(timingMeta?.dilutionTriggerType || "");
  const earliestDilution = cleanText(timingMeta?.earliestDilution || "");

  if (triggerType === "lockup_expiry") {
    text = text
      .replace(
        /\bso PIPE dilution is effectively immediate\b/gi,
        "so cap-table issuance may be immediate, but the PIPE shares appear locked up"
      )
      .replace(
        /\bSame-day dilution is possible, but the press release does not provide a firm first-dilution date\b/gi,
        "New shares appear locked up, so sellable supply is delayed"
      );
  }

  if (canDiluteToday === "Dilution status: Undetermined") {
    let replacement = "Timing: Same-day dilution is possible, but the press release does not provide a firm first-dilution date.";

    if (triggerType === "effectiveness") {
      replacement = "Timing: Same-day dilution is possible only after SEC effectiveness, and the press release does not say when that could happen.";
    } else if (triggerType === "filing_needed") {
      replacement = "Timing: Public-market dilution depends on another filing or resale step first, and the press release does not say when that will be completed.";
    } else if (triggerType === "shareholder_approval") {
      replacement = "Timing: Dilution depends on stockholder approval first, and the press release does not say when that will happen.";
    } else if (triggerType === "milestone") {
      replacement = "Timing: Dilution depends on a later milestone trigger, and the press release does not provide a firm date.";
    } else if (triggerType === "purchase_trigger") {
      replacement = "Timing: Same-day dilution is possible only if the company starts sales under the facility, and the press release does not say when that could happen.";
    } else if (triggerType === "lockup_expiry") {
      replacement = earliestDilution && !earliestDilution.includes("date unknown")
        ? `Timing: New shares appear locked up; first sellable supply appears tied to ${earliestDilution.replace(/^Earliest (?:dilution|sellable supply):\s*/i, "")}.`
        : "Timing: New shares appear locked up; the press release does not give a clear first sellable date.";
    } else if (triggerType === "closing") {
      replacement = earliestDilution.includes("date unknown")
        ? "Timing: Dilution depends on the offering closing, but the press release does not give a firm closing date."
        : `Timing: Initial share dilution occurs at closing; the press release does not make clear whether ${cleanEarliestDilutionDetail(earliestDilution)} can happen today.`;
    } else if (triggerType === "conversion") {
      replacement = "Timing: Same-day dilution is possible if holders convert, but the press release does not provide a firm first-dilution date.";
    } else if (earliestDilution.includes("after company starts sales")) {
      replacement = "Timing: Same-day dilution is possible only if the company begins selling under the facility, and the press release does not say when that will start.";
    }

    return replaceOrAppendTimingSentence(text, replacement);
  }

  if (canDiluteToday === "Dilution status: Delayed") {
    const replacement = triggerType === "lockup_expiry"
      ? (
          earliestDilution
            ? `Timing: New shares appear locked up; first sellable supply appears tied to ${cleanEarliestDilutionDetail(earliestDilution)}.`
            : "Timing: New shares appear locked up; first sellable supply appears delayed."
        )
        : triggerType === "closing"
        ? (
            earliestDilution
              ? `Timing: The press release does not indicate dilution today; initial share dilution occurs at the offering close (${cleanClosingDetail(earliestDilution)}), and once the offering closes those shares have been issued.`
              : "Timing: The press release does not indicate dilution today; initial share dilution occurs when the offering closes."
          )
      : (
          earliestDilution
            ? `Timing: The press release does not indicate dilution today. ${earliestDilution}.`
            : "Timing: The press release does not indicate dilution today."
        );

    return replaceOrAppendTimingSentence(text, replacement);
  }

  if (canDiluteToday === "Dilution status: Immediate" && earliestDilution) {
    let replacement = `Timing: ${earliestDilution}.`;

    if (triggerType === "already_triggered" || /already triggered|exercised/i.test(earliestDilution)) {
      replacement = "Timing: Warrant exercises are already completed, so dilution is already in effect.";
    }

    if (/shares issued at closing/i.test(earliestDilution)) {
      replacement = "Timing: Shares were issued at closing, so the offering's primary dilution is already in effect.";
    }

    return replaceOrAppendTimingSentence(text, replacement);
  }

  return text;
}

function sanitizePressReleaseFinancingPositives(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map(item => cleanText(item || ""))
    .filter(Boolean)
    .filter(item => !/placement agent|bookrunner|co-manager/i.test(item))
    .filter(item => !/registration statement.*effective|effective form [a-z0-9-]+|automatically became effective|effective upon filing/i.test(item))
    .filter(item => !/includes pre-funded warrants/i.test(item));
}

function isPressReleaseFinancingOutput({ eventType, articleText, summaryText, rawTiming }) {
  if (
    [
      "press_release_private_placement",
      "press_release_registered_direct",
      "press_release_at_the_market_financing",
      "press_release_warrant_financing",
      "press_release_offering_proposed",
      "press_release_offering_pricing",
      "press_release_financing"
    ].includes(eventType)
  ) {
    return true;
  }

  return hasPressReleaseFinancingText(
    `${cleanText(summaryText || "")} ${cleanText(rawTiming || "")}`,
    articleText
  );
}

module.exports = {
  hasPressReleaseFinancingText,
  derivePressReleaseEventType,
  extractPressReleasePhase1Signals,
  normalizePressReleaseTimingInputs,
  harmonizePressReleaseFinancingSummary,
  sanitizePressReleaseFinancingPositives,
  isPressReleaseFinancingOutput
};
