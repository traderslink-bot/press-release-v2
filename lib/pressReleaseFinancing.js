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

function detectPressReleaseTransactionStage(text) {
  const cleaned = cleanText(text || "");
  if (!cleaned) return null;

  if (/(announced the closing of|offering closed on|transaction closed|private placement closed|closing has occurred|gross proceeds were received|shares were issued)/i.test(cleaned)) {
    return "closed";
  }

  if (/(announced the pricing of|pricing of|priced .*offering|priced at-the-market|public offering price)/i.test(cleaned)) {
    return "priced";
  }

  if (/(proposed (?:underwritten )?public offering|launch of .*offering|commenced an .*offering|commencement of .*offering|intends to offer|subject to market and other conditions|no assurance as to whether or when)/i.test(cleaned)) {
    return "proposed";
  }

  return null;
}

function extractPressReleasePhase1Signals({ articleText = "", summaryText = "", eventType = "" }) {
  const combinedText = cleanText(`${articleText} ${summaryText}`.trim());
  const loweredEventType = cleanText(eventType).toLowerCase();
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
    /private placement|\bpipe\b/i.test(combinedText);
  const isRegisteredDirect =
    loweredEventType === "press_release_registered_direct" ||
    /registered direct/i.test(combinedText);
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
  const combinedText = `${cleanText(rawDiscordMessage || "")} ${cleanText(articleText || "")}`.toUpperCase();
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
  const combinedText = `${cleanText(rawDiscordMessage || "")} ${cleanText(articleText || "")} ${normalizedAI}`.toLowerCase();

  if (/registered direct/.test(combinedText)) return "press_release_registered_direct";
  if (/at[- ]the[- ]market|priced at[- ]the[- ]market/.test(combinedText)) return "press_release_at_the_market_financing";
  if (
    /warrant inducement|announces? exercise of (?:existing )?warrants?|exercise of warrants for cash|cash exercise of (?:existing )?warrants?|warrant holders .*? exercised|warrants? (?:have|has|were) exercised/i.test(
      combinedText
    ) &&
    !/warrant exercise price|warrant exercise proceeds|future warrant exercise|later through warrant exercise|become exercisable|warrants become exercisable|potential future cash exercise/i.test(
      combinedText
    )
  ) {
    return "press_release_warrant_financing";
  }
  if (/proposed public offering|commenced an underwritten public offering|launch of underwritten public offering|launch of public offering/.test(combinedText)) {
    return "press_release_offering_proposed";
  }
  if (/pricing of .*offering|priced .*offering|public offering price|best efforts public offering|underwritten public offering|public offering/.test(combinedText)) {
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

  if (phase1Signals.isSecondaryOffering && phase1Signals.isSellingShareholderOnly) {
    return {
      rawStatus: closingDate ? "conditional" : null,
      rawTriggerType: closingDate ? "closing" : null,
      rawTriggerDate: closingDate || null,
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
    /announces? exercise of (?:existing )?warrants?|exercise of warrants for cash|cash exercise of (?:existing )?warrants?|warrant holders .*? have already exercised|already exercised or agreed to exercise|already triggered warrant exercise|warrants? (?:have|has|were) exercised/i.test(
      combinedText
    ) &&
    !/warrant exercise price|warrant exercise proceeds|future warrant exercise|later through warrant exercise|become exercisable|warrants become exercisable|potential future cash exercise/i.test(
      combinedText
    )
  ) {
    return {
      rawStatus: "live_now",
      rawTriggerType: "already_triggered",
      rawTriggerDate: null,
      phase1Signals
    };
  }

  if (phase1Signals.isRightsOffering && phase1Signals.rightsExpiryDate) {
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

function harmonizePressReleaseFinancingSummary(summary, timingMeta) {
  const text = cleanText(summary || "");
  if (!text) return text;

  const canDiluteToday = cleanText(timingMeta?.canDiluteToday || "");
  const triggerType = cleanText(timingMeta?.dilutionTriggerType || "");
  const earliestDilution = cleanText(timingMeta?.earliestDilution || "");

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
    } else if (triggerType === "closing") {
      replacement = earliestDilution.includes("date unknown")
        ? "Timing: Dilution depends on the offering closing, but the press release does not give a firm closing date."
        : "Timing: Dilution depends on the offering closing, and the press release does not make clear whether that can happen today.";
    } else if (triggerType === "conversion") {
      replacement = "Timing: Same-day dilution is possible if holders convert, but the press release does not provide a firm first-dilution date.";
    } else if (earliestDilution.includes("after company starts sales")) {
      replacement = "Timing: Same-day dilution is possible only if the company begins selling under the facility, and the press release does not say when that will start.";
    }

    return replaceOrAppendTimingSentence(text, replacement);
  }

  if (canDiluteToday === "Dilution status: Delayed") {
    const replacement = earliestDilution
      ? `Timing: The press release does not indicate dilution today. ${earliestDilution}.`
      : "Timing: The press release does not indicate dilution today.";

    return replaceOrAppendTimingSentence(text, replacement);
  }

  if (canDiluteToday === "Dilution status: Immediate" && !/Timing:/i.test(text) && earliestDilution) {
    return `${text} Timing: ${earliestDilution}.`.trim();
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
