const { cleanText, getCurrentEasternDateKey, dateKeyFromDisplayDate } = require("./utils");
const { normalizeSecFilingType } = require("./sec");

function normalizeTimingDate(rawValue) {
  const text = cleanText(rawValue || "");
  if (!text) return null;

  const match = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|May|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?)\s+\d{1,2},\s+\d{4}\b/i
  );

  if (!match) return null;

  const monthMap = {
    january: "Jan",
    jan: "Jan",
    february: "Feb",
    feb: "Feb",
    march: "Mar",
    mar: "Mar",
    april: "Apr",
    apr: "Apr",
    may: "May",
    june: "Jun",
    jun: "Jun",
    july: "Jul",
    jul: "Jul",
    august: "Aug",
    aug: "Aug",
    september: "Sep",
    sep: "Sep",
    sept: "Sep",
    october: "Oct",
    oct: "Oct",
    november: "Nov",
    nov: "Nov",
    december: "Dec",
    dec: "Dec"
  };

  const parts = match[0]
    .replace(/\./g, "")
    .split(/\s+/)
    .join(" ")
    .match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);

  if (!parts) return cleanText(match[0]);

  const [, monthRaw, day, year] = parts;
  const month = monthMap[monthRaw.toLowerCase()] || cleanText(monthRaw);
  return `${month} ${Number(day)}, ${year}`;
}

function inferDilutionStatus(rawStatus, combinedText) {
  const normalized = cleanText(rawStatus || "").toLowerCase();

  if (/(^|[\s_-])(live_now|live now|immediate)($|[\s_-])/.test(normalized)) return "live_now";
  if (normalized.includes("delayed")) return "delayed";
  if (normalized.includes("conditional")) return "conditional";
  if (normalized.includes("potential")) return "potential";

  if (/(not immediate|not live|cannot begin|cannot occur|delayed until|only after)/i.test(combinedText)) {
    return "delayed";
  }

  if (/(purchase notice|company controls timing|company may elect|company is not obligated|conditional)/i.test(combinedText)) {
    return "conditional";
  }

  if (/(potential|may be issued|may be sold|convertible|exercise|warrant|resale overhang)/i.test(combinedText)) {
    return "potential";
  }

  if (/(immediate|at closing|upon closing|expected delivery|expected settlement|issued at closing)/i.test(combinedText)) {
    return "live_now";
  }

  return null;
}

function inferDilutionTriggerType(rawType, combinedText) {
  const normalized = cleanText(rawType || "").toLowerCase().replace(/[\s-]+/g, "_");
  const hasGenericEffectiveShelfContext =
    /(shelf registration statement|registration statement on form s-3|registration statement on form f-3|declared effective by the sec)/i.test(combinedText) &&
    /(subject to market conditions|there can be no assurance|commencing an underwritten public offering|proposed public offering|preliminary prospectus supplement)/i.test(combinedText);
  if (
    normalized === "mixed_trigger" &&
    /(purchase notice|aggregate proceeds|commitment ads|commitment shares)/i.test(combinedText) &&
    !/(conversion|convertible|exercise|exercisable|warrant)/i.test(combinedText)
  ) {
    return "purchase_trigger";
  }

  if (
    [
      "closing",
      "settlement",
      "effectiveness",
      "lockup_expiry",
      "conversion",
      "exercise",
      "already_triggered",
      "purchase_trigger",
      "rights_expiry",
      "resale_eligibility",
      "filing_needed",
      "shareholder_approval",
      "milestone",
      "mixed_trigger"
    ].includes(normalized)
  ) {
    return normalized;
  }

  if (/(purchase notice|aggregate proceeds|commitment ads|commitment shares)/i.test(combinedText)) {
    return "purchase_trigger";
  }

  if (/(already triggered|already completed|exercise of over-allotment option|over-allotment option.*exercised|additional share option was exercised|option exercise closed on)/i.test(combinedText)) {
    return "already_triggered";
  }

  if (
    !hasGenericEffectiveShelfContext &&
    /(not yet effective|after effectiveness|upon effectiveness|until effective|until effectiveness|declared effective|effective date)/i.test(combinedText)
  ) {
    return "effectiveness";
  }

  if (/(lock-?up|lockup)/i.test(combinedText)) {
    return "lockup_expiry";
  }

  if (/(expected settlement|settlement)/i.test(combinedText)) {
    return "settlement";
  }

  if (/(at closing|upon closing|closing expected|expected delivery|delivered securities against payment)/i.test(combinedText)) {
    return "closing";
  }

  if (/(resale eligibility|eligible for resale)/i.test(combinedText)) {
    return "resale_eligibility";
  }

  if (/(agreed to file a (?:resale )?registration statement|registration rights agreement|rights agreement and rights certificate.*filed|another filing)/i.test(combinedText)) {
    return "filing_needed";
  }

  if (/(shareholder approval|stockholder approval|authorized shares)/i.test(combinedText)) {
    return "shareholder_approval";
  }

  if (/(fda approval|milestone warrant|milestone event|following fda approval|upon fda approval)/i.test(combinedText)) {
    return "milestone";
  }

  if (/(conversion)/i.test(combinedText) && /(exercise|warrant)/i.test(combinedText)) {
    return "mixed_trigger";
  }

  if (/(conversion|convertible)/i.test(combinedText)) {
    return "conversion";
  }

  if (/(exercise|exercisable|warrant)/i.test(combinedText)) {
    return "exercise";
  }

  return null;
}

function extractTriggerDateFromContext(combinedText, triggerType) {
  const text = cleanText(combinedText || "");
  if (!text || !triggerType) return null;

  if (triggerType === "effectiveness") {
    return null;
  }

  const datePattern = /(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|May|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?)\s+\d{1,2},\s+\d{4}/ig;
  const contextualPatterns = {
    closing: /(closing|expected delivery|deliver securities against payment|issued at closing)/i,
    settlement: /(settlement|expected settlement)/i,
    effectiveness: /(effective date|declared effective|becomes effective|registration statement is effective)/i,
    lockup_expiry: /(lock-?up|lockup)/i,
    already_triggered: /(already triggered|already completed|option exercise closed on|additional share option was exercised|over-allotment option.*exercised|exercise of over-allotment option)/i
  };

  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (!contextualPatterns[triggerType]?.test(sentence)) continue;
    const match = sentence.match(datePattern);
    if (match?.[0]) {
      return normalizeTimingDate(match[0]);
    }
  }

  return null;
}

function isAtmFacilityContext(combinedText) {
  const text = cleanText(combinedText || "");
  if (!text) return false;

  return (
    /(at-the-market|at the market|\bATM\b)/i.test(text) &&
    /(sales agreement|sales agent|from time to time)/i.test(text)
  );
}

function hasExecutedSaleContext(combinedText) {
  const text = cleanText(combinedText || "");
  if (!text) return false;

  return /(priced\s+(the\s+)?offering|public\s+offering\s+price|expected\s+close\s+on\s+or\s+about|expected\s+delivery\s+on\s+or\s+about|underwritten\s+offering|securities\s+purchase\s+agreement|sold\s+an\s+aggregate\s+of|have\s+sold\s+an\s+aggregate\s+of|we\s+sold|committed\s+to\s+purchase)/i.test(text);
}

function buildTraderDilutionTiming({
  rawTiming,
  rawStatus,
  rawTriggerType,
  rawTriggerDate,
  summaryText,
  currentDateKeyOverride = null
}) {
  const raw = cleanText(rawTiming || "");
  const combinedText = `${raw} ${cleanText(summaryText || "")}`.trim();
  let triggerType = inferDilutionTriggerType(rawTriggerType, combinedText);
  let status = inferDilutionStatus(rawStatus, combinedText);
  let normalizedDate = triggerType === "effectiveness" || triggerType === "purchase_trigger"
    ? null
    : normalizeTimingDate(rawTriggerDate) || extractTriggerDateFromContext(combinedText, triggerType);
  const todayDateKey = currentDateKeyOverride || getCurrentEasternDateKey();
  const triggerDateKey = dateKeyFromDisplayDate(normalizedDate);
  const atmFacilityContext = isAtmFacilityContext(combinedText);
  const executedSaleContext = hasExecutedSaleContext(combinedText);

  if (status === "delayed" && !cleanText(rawTriggerType || "") && !cleanText(rawTriggerDate || "")) {
    triggerType = null;
    normalizedDate = null;
  }

  const withSnapshot = (base, canDiluteToday, earliestDilution) => ({
    ...base,
    dilutionTiming: canDiluteToday,
    canDiluteToday,
    earliestDilution
  });

  const hasImmediateConvertibleSupply =
    triggerType === "effectiveness" &&
    /(convertible note|convertible notes|convert at holder option|holder option to convert|convertible at \$|convertible promissory note)/i.test(
      combinedText
    );

  if (hasImmediateConvertibleSupply) {
    return withSnapshot({
      dilutionStatus: "potential",
      dilutionTriggerType: "conversion",
      dilutionTriggerDate: null
    }, "Dilution status: Undetermined", "Earliest dilution: date unknown");
  }

  if (atmFacilityContext && !executedSaleContext) {
    triggerType = "purchase_trigger";
    normalizedDate = null;

    if (status === "live_now" || status === "potential" || !status) {
      status = "conditional";
    }
  }

  if (
    status !== "delayed" &&
    triggerType === "closing" &&
    !/(not immediate|not live|only after closing|cannot begin until closing)/i.test(combinedText) &&
    /(at closing|upon closing|expected to deliver|deliver(?:ed)? the securities against payment|issued at closing|issue at closing|shares are expected to be issued at closing|immediate primary dilution|new shares issued at closing)/i.test(
      combinedText
    )
  ) {
    status = "live_now";
  }

  if (!status && !triggerType && !raw) {
    return {
      dilutionTiming: null,
      dilutionStatus: null,
      dilutionTriggerType: null,
      dilutionTriggerDate: null,
      canDiluteToday: null,
      earliestDilution: null
    };
  }

  if (status === "live_now") {
    if (triggerType === "already_triggered") {
      return withSnapshot({
        dilutionStatus: "live_now",
        dilutionTriggerType: triggerType,
        dilutionTriggerDate: normalizedDate
      }, "Dilution status: Immediate", normalizedDate ? `Earliest dilution: ${normalizedDate} exercised` : "Earliest dilution: already triggered");
    }

    if (triggerType === "closing" && normalizedDate) {
      return withSnapshot({
        dilutionStatus: "live_now",
        dilutionTriggerType: triggerType,
        dilutionTriggerDate: normalizedDate
      }, "Dilution status: Immediate", `Earliest dilution: ${normalizedDate} closing`);
    }

    if (triggerType === "settlement" && normalizedDate) {
      return withSnapshot({
        dilutionStatus: "live_now",
        dilutionTriggerType: triggerType,
        dilutionTriggerDate: normalizedDate
      }, "Dilution status: Immediate", `Earliest dilution: ${normalizedDate} settlement`);
    }

    return withSnapshot({
      dilutionStatus: "live_now",
      dilutionTriggerType: triggerType,
      dilutionTriggerDate: normalizedDate
    }, "Dilution status: Immediate", normalizedDate ? `Earliest dilution: ${normalizedDate}` : "Earliest dilution: today");
  }

  if (status === "delayed") {
    if (!triggerType && !normalizedDate) {
      return withSnapshot({
        dilutionStatus: "delayed",
        dilutionTriggerType: null,
        dilutionTriggerDate: null
      }, "Dilution status: Delayed", "Earliest dilution: date unknown");
    }

    if (
      triggerType === "effectiveness" &&
      /(effective upon filing|becomes effective upon filing|effective immediately upon filing|rule 462\(b\))/i.test(combinedText)
    ) {
      return withSnapshot({
        dilutionStatus: "undetermined",
        dilutionTriggerType: triggerType,
        dilutionTriggerDate: null
      }, "Dilution status: Undetermined", "Earliest dilution: date unknown");
    }

    if (triggerType === "closing") {
      if (normalizedDate && triggerDateKey && triggerDateKey >= todayDateKey) {
        return withSnapshot({
          dilutionStatus: "delayed",
          dilutionTriggerType: triggerType,
          dilutionTriggerDate: normalizedDate
        }, "Dilution status: Delayed", `Earliest dilution: ${normalizedDate} close`);
      }

      return withSnapshot({
        dilutionStatus: "delayed",
        dilutionTriggerType: triggerType,
        dilutionTriggerDate: normalizedDate
      }, "Dilution status: Undetermined", normalizedDate ? `Earliest dilution: ${normalizedDate} closing` : "Earliest dilution: date unknown");
    }

    if (triggerType === "rights_expiry") {
      if (normalizedDate && triggerDateKey && triggerDateKey > todayDateKey) {
        return withSnapshot({
          dilutionStatus: "delayed",
          dilutionTriggerType: triggerType,
          dilutionTriggerDate: normalizedDate
        }, "Dilution status: Delayed", `Earliest dilution: ${normalizedDate} expiry`);
      }

      return withSnapshot({
        dilutionStatus: "delayed",
        dilutionTriggerType: triggerType,
        dilutionTriggerDate: normalizedDate
      }, "Dilution status: Undetermined", normalizedDate ? `Earliest dilution: ${normalizedDate} expiry` : "Earliest dilution: date unknown");
    }

    if (normalizedDate && triggerDateKey && triggerDateKey > todayDateKey) {
      return withSnapshot({
        dilutionStatus: "delayed",
        dilutionTriggerType: triggerType,
        dilutionTriggerDate: normalizedDate
      }, "Dilution status: Delayed", `Earliest dilution: ${normalizedDate}`);
    }

    if (triggerType === "settlement" && /forward sale agreements?|forward purchasers?/i.test(combinedText)) {
      return withSnapshot({
        dilutionStatus: "delayed",
        dilutionTriggerType: triggerType,
        dilutionTriggerDate: normalizedDate
      }, "Dilution status: Delayed", "Earliest dilution: date unknown");
    }

    const delayedLabelMap = {
      effectiveness: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: after SEC effectiveness"
      },
      filing_needed: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: another filing needed"
      },
      shareholder_approval: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: stockholder approval"
      },
      milestone: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: milestone trigger"
      },
      lockup_expiry: {
        canDiluteToday: normalizedDate && triggerDateKey && triggerDateKey > todayDateKey
          ? "Dilution status: Delayed"
          : "Dilution status: Undetermined",
        earliestDilution: normalizedDate
          ? `Earliest dilution: ${normalizedDate}`
          : "Earliest dilution: date unknown"
      },
      settlement: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: normalizedDate
          ? `Earliest dilution: ${normalizedDate} settlement`
          : /forward sale agreements?|forward purchasers?/i.test(combinedText)
            ? "Earliest dilution: future settlement"
            : "Earliest dilution: date unknown"
      },
      conversion: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: date unknown"
      },
      exercise: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: date unknown"
      },
      resale_eligibility: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: date unknown"
      },
      purchase_trigger: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: after company starts sales"
      },
      rights_expiry: {
        canDiluteToday: normalizedDate && triggerDateKey && triggerDateKey > todayDateKey
          ? "Dilution status: Delayed"
          : "Dilution status: Undetermined",
        earliestDilution: normalizedDate
          ? `Earliest dilution: ${normalizedDate} expiry`
          : "Earliest dilution: date unknown"
      },
      filing_needed: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: another filing needed"
      },
      shareholder_approval: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: stockholder approval"
      },
      milestone: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: milestone trigger"
      },
      mixed_trigger: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: date unknown"
      }
    };

    const delayedLabels = delayedLabelMap[triggerType] || {
      canDiluteToday: "Dilution status: Undetermined",
      earliestDilution: normalizedDate
        ? `Earliest dilution: ${normalizedDate}`
        : "Earliest dilution: date unknown"
    };

    return withSnapshot({
      dilutionStatus: "delayed",
      dilutionTriggerType: triggerType,
      dilutionTriggerDate: normalizedDate
    }, delayedLabels.canDiluteToday, delayedLabels.earliestDilution);
  }

  if (status === "conditional") {
    const conditionalLabelMap = {
      purchase_trigger: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: after company starts sales"
      },
      rights_expiry: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: normalizedDate
          ? `Earliest dilution: ${normalizedDate} expiry`
          : "Earliest dilution: date unknown"
      },
      effectiveness: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: after SEC effectiveness"
      },
      closing: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: normalizedDate
          ? `Earliest dilution: ${normalizedDate} closing`
          : "Earliest dilution: date unknown"
      },
      filing_needed: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: another filing needed"
      },
      shareholder_approval: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: stockholder approval"
      },
      milestone: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: milestone trigger"
      },
      settlement: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: normalizedDate
          ? `Earliest dilution: ${normalizedDate} settlement`
          : /forward sale agreements?|forward purchasers?/i.test(combinedText)
            ? "Earliest dilution: future settlement"
            : "Earliest dilution: date unknown"
      },
      mixed_trigger: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: date unknown"
      }
    };

    const conditionalLabels = conditionalLabelMap[triggerType] || {
      canDiluteToday: "Dilution status: Undetermined",
      earliestDilution: normalizedDate
        ? `Earliest dilution: ${normalizedDate}`
        : "Earliest dilution: date unknown"
    };

    return withSnapshot({
      dilutionStatus: "conditional",
      dilutionTriggerType: triggerType,
      dilutionTriggerDate: normalizedDate
    }, conditionalLabels.canDiluteToday, conditionalLabels.earliestDilution);
  }

  if (status === "potential") {
    const potentialLabelMap = {
      conversion: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: date unknown"
      },
      exercise: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: date unknown"
      },
      mixed_trigger: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: date unknown"
      },
      resale_eligibility: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: date unknown"
      },
      filing_needed: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: another filing needed"
      },
      shareholder_approval: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: stockholder approval"
      },
      milestone: {
        canDiluteToday: "Dilution status: Undetermined",
        earliestDilution: "Earliest dilution: milestone trigger"
      }
    };

    const potentialLabels = potentialLabelMap[triggerType] || {
      canDiluteToday: "Dilution status: Undetermined",
      earliestDilution: normalizedDate
        ? `Earliest dilution: ${normalizedDate}`
        : "Earliest dilution: date unknown"
    };

    return withSnapshot({
      dilutionStatus: "potential",
      dilutionTriggerType: triggerType,
      dilutionTriggerDate: normalizedDate
    }, potentialLabels.canDiluteToday, potentialLabels.earliestDilution);
  }

  return withSnapshot({
    dilutionTiming: null,
    dilutionStatus: status,
    dilutionTriggerType: triggerType,
    dilutionTriggerDate: normalizedDate
  }, "Dilution status: Undetermined", normalizedDate ? `Earliest dilution: ${normalizedDate}` : "Earliest dilution: date unknown");
}

function refineDilutionSummary(summary, eventType) {
  if (
    eventType !== "sec_prospectus_supplement" &&
    eventType !== "sec_registration_statement" &&
    eventType !== "sec_registration_amendment" &&
    eventType !== "sec_shelf_registration"
  ) {
    return summary;
  }

  return cleanText(summary || "")
    .replace(/\bdiluted shares outstanding\b/gi, "shares outstanding after the offering")
    .replace(/\bdiluted share count\b/gi, "post-offering share count");
}

function harmonizeDilutionSummary(summary, timingMeta) {
  const text = cleanText(summary || "");
  if (!text) return text;

  const canDiluteToday = cleanText(timingMeta?.canDiluteToday || "");
  const triggerType = cleanText(timingMeta?.dilutionTriggerType || "");
  const earliestDilution = cleanText(timingMeta?.earliestDilution || "");

  if (canDiluteToday === "Dilution status: Undetermined") {
    let replacement = "Timing: Same-day dilution is possible, but the earliest timing is not clearly stated in the filing.";

    if (triggerType === "effectiveness") {
      replacement = "Timing: Same-day dilution is possible only if SEC effectiveness is obtained; the filing does not state when that could happen.";
    } else if (triggerType === "purchase_trigger") {
      replacement = "Timing: Same-day dilution is possible only if the company starts sales under the facility; the filing does not state when that could happen.";
    } else if (triggerType === "closing") {
      replacement = earliestDilution.includes("date unknown")
        ? "Timing: The filing points to a future closing, but the first-dilution date is not stated."
        : "Timing: Dilution is tied to the offering closing, but the filing does not clearly state whether that can occur today.";
    } else if (triggerType === "conversion") {
      replacement = "Timing: Same-day dilution is possible if holders convert, but the filing does not give a firm first-dilution date.";
    } else if (earliestDilution.includes("date unknown")) {
      replacement = "Timing: Same-day dilution is possible, but the filing does not provide a firm first-dilution date.";
    }

    return text.replace(/Timing:\s*[^.]+(?:\.)?/i, replacement);
  }

  if (canDiluteToday === "Dilution status: Delayed") {
    let replacement = "Timing: The filing does not allow dilution today.";

    if (earliestDilution) {
      replacement = `Timing: The filing does not allow dilution today. ${earliestDilution}.`;
    }

    return text.replace(/Timing:\s*[^.]+(?:\.)?/i, replacement);
  }

  return text;
}

function sanitizeDilutionBullets(items) {
  if (!Array.isArray(items)) return [];

  return items.map(item => cleanText(item || ""))
    .filter(Boolean)
    .map(item => item
      .replace(/increase net proceeds to the company/gi, "reduce net proceeds to the company")
      .replace(/increase net proceeds/gi, "reduce net proceeds")
    );
}

function isDilutionRelevantSecOutput({ filingType, eventType, articleText, summaryText, rawTiming }) {
  const normalizedFilingType = normalizeSecFilingType(filingType);
  const combinedText = `${cleanText(articleText || "")} ${cleanText(summaryText || "")} ${cleanText(rawTiming || "")}`.toUpperCase();

  if (
    eventType === "sec_prospectus_supplement" ||
    eventType === "sec_shelf_registration" ||
    eventType === "sec_registration_statement" ||
    eventType === "sec_registration_amendment"
  ) {
    return true;
  }

  if (
    /^(?:S-1|S-1\/A|S-1A|S-1MEF|S-3|S-3\/A|S-3A|S-3ASR|F-1|F-1\/A|F-3|F-3\/A|424B1|424B2|424B3|424B4|424B5|424B7|POS AM|POSASR)$/i.test(
      normalizedFilingType
    )
  ) {
    return true;
  }

  if (/^(?:8-K|6-K)$/i.test(normalizedFilingType)) {
    const keywordHits = [
      /UNDERWRITING AGREEMENT/,
      /SECURITIES PURCHASE AGREEMENT/,
      /REGISTRATION RIGHTS AGREEMENT/,
      /PRIVATE PLACEMENT/,
      /\bPIPE\b/,
      /CONVERTIBLE PROMISSORY NOTE/,
      /CONVERTIBLE NOTE/,
      /PRE-FUNDED WARRANT/,
      /WARRANT/,
      /GROSS PROCEEDS/,
      /NET PROCEEDS/,
      /SHARES OF COMMON STOCK/,
      /PRIMARY OFFERING/,
      /OVER-ALLOTMENT/,
      /OVERALLOTMENT/
    ].filter(pattern => pattern.test(combinedText)).length;

    return keywordHits >= 2;
  }

  return false;
}

module.exports = {
  buildTraderDilutionTiming,
  refineDilutionSummary,
  harmonizeDilutionSummary,
  sanitizeDilutionBullets,
  isDilutionRelevantSecOutput
};
