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
    /expected to close on or about ([A-Za-z.]+\s+\d{1,2},\s+\d{4})/i,
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
  if (/warrant inducement|exercise of warrants|warrant exercise/.test(combinedText)) {
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
  const closingDate = normalizeTimingDate(rawTriggerDate) || inferClosingDate(combinedText);

  if (/has closed the offering|closed the offering|consummated the private placement|closing has occurred/i.test(combinedText)) {
    return {
      rawStatus: "live_now",
      rawTriggerType: "closing",
      rawTriggerDate: closingDate
    };
  }

  if (closingDate && /(expected to close on or about|expected to occur on or about|subject to satisfaction of customary closing conditions|subject to customary closing conditions)/i.test(combinedText)) {
    return {
      rawStatus: "delayed",
      rawTriggerType: "closing",
      rawTriggerDate: closingDate
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
      rawTriggerDate: null
    };
  }

  if (
    eventType === "press_release_offering_proposed" &&
    /(subject to market and other conditions|no assurance as to whether or when|no assurance.*actual size or terms)/i.test(combinedText)
  ) {
    return {
      rawStatus: "conditional",
      rawTriggerType: null,
      rawTriggerDate: null
    };
  }

  return {
    rawStatus,
    rawTriggerType,
    rawTriggerDate
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
  normalizePressReleaseTimingInputs,
  harmonizePressReleaseFinancingSummary,
  sanitizePressReleaseFinancingPositives,
  isPressReleaseFinancingOutput
};
