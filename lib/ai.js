const {
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_TEMPERATURE,
  OPENAI_TIMEOUT_MS,
  OPENAI_URL_FALLBACK_ENABLED,
  OPENAI_URL_FALLBACK_TIMEOUT_MS,
  OPENAI_URL_FALLBACK_MAX_RETRIES,
  OPENAI_MAX_RETRIES
} = require("./config");
const { fetchTextWithTimeout } = require("./http");
const { sleep, cleanText, extractJsonObject } = require("./utils");
const { buildOpenAIUsageMetrics } = require("./openaiUsage");
const {
  normalizeSecFilingType,
  buildSecFilingTypeAliases,
  extractSecFormTypeFromRawText,
  isSecSource
} = require("./sec");
const {
  buildTraderDilutionTiming,
  refineDilutionSummary,
  harmonizeDilutionSummary,
  sanitizeDilutionBullets,
  isDilutionRelevantSecOutput
} = require("./dilutionFilings");
const {
  derivePressReleaseEventType,
  extractPressReleasePhase1Signals,
  normalizePressReleaseTimingInputs,
  harmonizePressReleaseFinancingSummary,
  sanitizePressReleaseFinancingPositives,
  isPressReleaseFinancingOutput
} = require("./pressReleaseFinancing");
const {
  detectAnalysisMode,
  detectPressReleasePromptFamily,
  detectSecPromptFamily,
  buildPressReleasePrompt,
  buildPressReleaseFinancingPrompt,
  buildSecFilingPrompt,
  buildSecDilutionFinancingPrompt
} = require("./prompts");

const MAX_TRADER_BULLETS_PER_SIDE = 3;
const AI_SUMMARY_UNAVAILABLE_MESSAGE = "AI summary could not be provided for this article.";

function clampTraderBullets(items) {
  if (!Array.isArray(items)) return [];

  return items
    .filter(Boolean)
    .map(value => sanitizeSourceAttributionText(value, { sentenceCase: false }))
    .filter(Boolean)
    .slice(0, MAX_TRADER_BULLETS_PER_SIDE);
}

function sentenceCaseFirstLetter(text) {
  return String(text || "").replace(/^([a-z])/, value => value.toUpperCase());
}

function sanitizeSourceAttributionText(text, options = {}) {
  const { sentenceCase = true } = options;
  let sanitized = cleanText(text || "");
  if (!sanitized) return "";

  sanitized = sanitized
    .replace(
      /^(?:Business\s*Wire|BusinessWire|PR\s*Newswire|GlobeNewswire|Accesswire|Newswire)(?:\s+(?:press release|release|article))?(?:\s*\([^)]+\))?\s+(?:reporting|announcing|saying|stating|about)\s+/i,
      ""
    )
    .replace(
      /^(?:The\s+)?(?:Business\s*Wire|BusinessWire|PR\s*Newswire|GlobeNewswire|Accesswire|Newswire)\s+(?:press release|release|article)(?:\s*\([^)]+\))?\s*/i,
      ""
    )
    .replace(
      /\s*(?:The\s+)?summary is grounded in (?:the\s+)?(?:Business\s*Wire|BusinessWire|PR\s*Newswire|GlobeNewswire|Accesswire|Newswire|press release|release|article)[^.]*\.\s*$/i,
      ""
    )
    .replace(
      /\s*(?:Information|Details|Facts)\s+(?:above\s+)?(?:is|are)\s+(?:taken|sourced|derived)\s+(?:directly\s+)?from (?:the\s+)?(?:Business\s*Wire|BusinessWire|PR\s*Newswire|GlobeNewswire|Accesswire|Newswire|press release|release|article)[^.]*\.\s*$/i,
      ""
    )
    .trim();

  return sentenceCase ? sentenceCaseFirstLetter(sanitized) : sanitized;
}

function canonicalizeSecFilingType(rawDiscordMessage, aiFilingType) {
  const fromDiscord = extractSecFormTypeFromRawText(rawDiscordMessage);
  const normalizedFromDiscord = normalizeSecFilingType(fromDiscord);
  const normalizedAI = normalizeSecFilingType(aiFilingType);

  if (
    normalizedFromDiscord === "EFFECT" &&
    /^(?:S-1|S-1\/A|S-1A|S-1MEF|S-3|S-3\/A|S-3A|S-3ASR|F-1|F-1\/A|F-3|F-3\/A|424B1|424B2|424B3|424B4|424B5|424B7|POS AM|POSASR)$/i.test(
      normalizedAI || ""
    )
  ) {
    return normalizedAI;
  }

  if (fromDiscord) {
    return normalizedFromDiscord;
  }

  if (!normalizedAI) return null;

  const aliases = buildSecFilingTypeAliases(normalizedAI);
  const preferredAlias = aliases.find(alias => /^SCHEDULE\s+/i.test(alias)) ||
    aliases.find(alias => /^SC\s+/i.test(alias)) ||
    aliases[0];

  return preferredAlias || normalizedAI;
}

function extractIssuerNameFromSecText(articleText) {
  const text = String(articleText || "");
  const cleaned = cleanText(text);
  if (!cleaned) return null;

  const patterns = [
    /COMPANY CONFORMED NAME:\s*([^\r\n<]+)/i,
    /FORM\s+[A-Z0-9\-\/]+\s+REGISTRATION STATEMENT(?:\s+UNDER THE SECURITIES ACT OF 1933)?\s+([A-Z][A-Za-z0-9&.,'()\- ]{2,120}?)\s+\(Exact name of registrant as specified in its charter\)/i,
    /([A-Z][A-Za-z0-9&.,'()\- ]{2,120}?)\s+\(Exact name of registrant as specified in its charter\)/i,
    /([A-Z][A-Za-z0-9&.,'()\- ]{2,120}?)\s+\(Name of Issuer\)/i
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      return cleanText(match[1]);
    }
  }

  return null;
}

function deriveSecEventType(filingType, aiEventType, articleText = "") {
  const normalizedType = normalizeSecFilingType(filingType);
  const normalizedAI = cleanText(aiEventType || "").toLowerCase();
  const normalizedArticleText = cleanText(articleText || "").toLowerCase();

  if (normalizedType) {
    if (/^(?:8-K|6-K)$/.test(normalizedType)) return "sec_current_report";
    if (/^(?:10-K|10-Q|20-F|40-F)$/.test(normalizedType)) return "sec_periodic_report";
    if (/^(?:FWP)$/i.test(normalizedType)) {
      if (
        /free writing prospectus|proposed public offering|public offering|common stock|warrant|registration statement|form s-1|form f-1|form s-3|form f-3/.test(
          normalizedArticleText
        )
      ) {
        return "sec_free_writing_prospectus";
      }
    }
    if (/^(?:424B1|424B2|424B3|424B4|424B5|424B7)$/i.test(normalizedType)) {
      return "sec_prospectus_supplement";
    }
    if (/^(?:S-3|S-3ASR|F-3)$/i.test(normalizedType)) {
      return "sec_shelf_registration";
    }
    if (/^(?:S-1\/A|S-1A|S-3\/A|S-3A|F-1\/A|F-3\/A|POS AM|POSASR)$/i.test(normalizedType)) {
      return "sec_registration_amendment";
    }
    if (/^(?:S-1|S-1MEF|F-1)$/i.test(normalizedType)) {
      return "sec_registration_statement";
    }
    if (/^(?:SCHEDULE 13G|SC 13G|13G|SCHEDULE 13D|SC 13D|13D)$/i.test(normalizedType)) {
      return "sec_beneficial_ownership";
    }
    if (/^(?:DEF 14A|PRE 14A)$/.test(normalizedType)) return "sec_proxy";
    if (/^EFFECT$/i.test(normalizedType)) {
      if (normalizedAI.includes("prospectus")) return "sec_prospectus_supplement";
      if (normalizedAI.includes("shelf")) return "sec_shelf_registration";
      if (normalizedAI.includes("amendment")) return "sec_registration_amendment";
      if (normalizedAI.includes("registration")) return "sec_registration_statement";
    }
  }

  if (normalizedAI.includes("ownership")) return "sec_beneficial_ownership";
  if (normalizedAI.includes("free writing prospectus")) return "sec_free_writing_prospectus";
  if (normalizedAI.includes("prospectus")) return "sec_prospectus_supplement";
  if (normalizedAI.includes("shelf")) return "sec_shelf_registration";
  if (normalizedAI.includes("amendment")) return "sec_registration_amendment";
  if (normalizedAI.includes("registration")) return "sec_registration_statement";
  if (normalizedAI.includes("proxy")) return "sec_proxy";
  if (normalizedAI.includes("report")) return "sec_current_report";
  return "sec_filing";
}

function maybeDropRedundantSecLead(summary, filingType, issuerName, ticker) {
  const text = cleanText(summary).replace(/^Front-load:\s*/i, "");
  if (!text) return "";

  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 1) return text;

  const firstSentence = sentences[0].toLowerCase();
  const filingNeedle = normalizeSecFilingType(filingType || "").toLowerCase();
  const issuerNeedle = cleanText(issuerName || ticker || "").toLowerCase();

  const looksRedundant =
    firstSentence.includes("sec filing") ||
    firstSentence.includes("filing type") ||
    (filingNeedle && firstSentence.includes(filingNeedle)) ||
    (issuerNeedle && firstSentence.includes(issuerNeedle));

  return looksRedundant ? sentences.slice(1).join(" ").trim() : text;
}

function stripSecCoverBoilerplate(summary) {
  let text = cleanText(summary || "");
  if (!text) return text;

  text = text
    .replace(/^COMMISSIO\s*N?\s+Washington,\s*D\.C\.\s*20549\s+FORM\s+[A-Z0-9\-\/]+\s+REGISTRATION STATEMENT\s+Under the Securities Act of 1933\s+/i, "")
    .replace(/^UNITED STATES SECURITIES AND EXCHANGE COMMISSION\s+Washington,\s*D\.C\.\s*20549\s+/i, "")
    .trim();

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const filtered = sentences.filter(sentence => {
    const normalized = sentence.toLowerCase();
    return !(
      normalized.includes("washington, d.c. 20549") ||
      normalized.includes("registration statement under the securities act") ||
      normalized.includes("as filed with the securities and exchange commission") ||
      normalized.includes("as filed with the u.s. securities and exchange commission") ||
      normalized.startsWith("commissio n washington") ||
      normalized.startsWith("united states securities and exchange commission washington")
    );
  });

  return filtered.length ? filtered.join(" ").trim() : text;
}

function sanitizeTraderBullets(items, kind = "generic") {
  if (!Array.isArray(items)) return [];

  const normalized = items
    .map(item => sanitizeSourceAttributionText(item || "", { sentenceCase: false }))
    .filter(Boolean);

  const seen = new Set();
  const unique = normalized.filter(item => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const commonNoise = [
    /placement agent|bookrunner|co-manager/i,
    /trading under the symbol|listed on nasdaq|listed on nyse|exchange listing/i,
    /registration statement.*effective|effective form [a-z0-9-]+|automatically became effective|effective upon filing/i
  ];

  const positiveNoise = [
    /presence at .*conference|visibility to potential customers|attendance at .*conference|participation in .*conference|fireside chat|booth presence/i,
    /company statements? .*not independently validated/i,
    /launch of .*program signals/i
  ];

  const negativeNoise = [
    /claims are company statements in a press release and not independently validated/i,
    /statements? .*not independently validated within the article/i,
    /the article does not independently validate/i
  ];

  const patterns = [
    ...commonNoise,
    ...(kind === "positive" ? positiveNoise : []),
    ...(kind === "negative" ? negativeNoise : [])
  ];

  return unique.filter(item => !patterns.some(pattern => pattern.test(item)));
}

function stabilizeSecSummary(ai, data, articleText) {
  if (ai.isFallback) return ai.summary;

  const filingType = canonicalizeSecFilingType(data.rawText, ai.filingType);
  const issuerName = extractIssuerNameFromSecText(articleText) || data.ticker;
  const stableLead = filingType
    ? `${issuerName} filed SEC Form ${filingType}.`
    : `${issuerName} filed an SEC filing.`;
  const remainder = maybeDropRedundantSecLead(ai.summary, filingType, issuerName, data.ticker);
  const cleanedRemainder = stripSecCoverBoilerplate(remainder);

  if (!cleanedRemainder) {
    return `${stableLead} Review the filing link for additional details.`;
  }

  return `${stableLead} ${cleanedRemainder}`.trim();
}

function stabilizeAIResult(ai, data, articleText) {
  const secSource = isSecSource(data.articleLink);
  const stabilized = {
    ...ai,
    tickers: Array.isArray(ai.tickers) && ai.tickers.length ? ai.tickers : [data.ticker]
  };

  if (secSource) {
    stabilized.filingType = canonicalizeSecFilingType(data.rawText, ai.filingType);
    stabilized.eventType = ai.isFallback
      ? "sec_unreadable"
      : deriveSecEventType(stabilized.filingType, ai.eventType, articleText);
    const refinedSummary = refineDilutionSummary(
      stabilizeSecSummary(stabilized, data, articleText),
      stabilized.eventType
    );
    const isDilutionRelevant = isDilutionRelevantSecOutput({
      filingType: stabilized.filingType,
      eventType: stabilized.eventType,
      articleText,
      summaryText: refinedSummary,
      rawTiming: ai.dilutionTiming
    });

    if (isDilutionRelevant) {
      const timingMeta = buildTraderDilutionTiming({
        rawTiming: ai.dilutionTiming,
        rawStatus: ai.dilutionStatus,
        rawTriggerType: ai.dilutionTriggerType,
        rawTriggerDate: ai.dilutionTriggerDate,
        summaryText: refinedSummary
      });

      Object.assign(stabilized, timingMeta);
      stabilized.summary = harmonizeDilutionSummary(refinedSummary, timingMeta);
      stabilized.positives = sanitizeTraderBullets(
        sanitizeDilutionBullets(stabilized.positives),
        "positive"
      );
      stabilized.negatives = sanitizeTraderBullets(
        sanitizeDilutionBullets(stabilized.negatives),
        "negative"
      );
    } else {
      stabilized.dilutionTiming = null;
      stabilized.dilutionStatus = null;
      stabilized.dilutionTriggerType = null;
      stabilized.dilutionTriggerDate = null;
      stabilized.canDiluteToday = null;
      stabilized.earliestDilution = null;
      stabilized.summary = refinedSummary;
      stabilized.positives = sanitizeTraderBullets(stabilized.positives, "positive");
      stabilized.negatives = sanitizeTraderBullets(stabilized.negatives, "negative");
    }
  } else {
    stabilized.filingType = null;
    stabilized.eventType = derivePressReleaseEventType(ai.eventType, articleText, data.rawText);
    const cleanedSummary = cleanText(ai.summary || AI_SUMMARY_UNAVAILABLE_MESSAGE);
    const isFinancingRelevant = isPressReleaseFinancingOutput({
      eventType: stabilized.eventType,
      articleText,
      summaryText: cleanedSummary,
      rawTiming: ai.dilutionTiming
    });

    if (isFinancingRelevant) {
      const normalizedTimingInputs = normalizePressReleaseTimingInputs({
        rawStatus: ai.dilutionStatus,
        rawTriggerType: ai.dilutionTriggerType,
        rawTriggerDate: ai.dilutionTriggerDate,
        articleText,
        summaryText: cleanedSummary,
        eventType: stabilized.eventType
      });
      const phase1Signals = normalizedTimingInputs.phase1Signals || extractPressReleasePhase1Signals({
        articleText,
        summaryText: cleanedSummary,
        eventType: stabilized.eventType
      });

      stabilized.pressReleaseTimingSignals = phase1Signals;

      const timingMeta = buildTraderDilutionTiming({
        rawTiming: ai.dilutionTiming,
        rawStatus: normalizedTimingInputs.rawStatus,
        rawTriggerType: normalizedTimingInputs.rawTriggerType,
        rawTriggerDate: normalizedTimingInputs.rawTriggerDate,
        summaryText: cleanedSummary
      });

      Object.assign(stabilized, timingMeta);
      stabilized.summary = harmonizePressReleaseFinancingSummary(cleanedSummary, timingMeta);
      stabilized.positives = sanitizePressReleaseFinancingPositives(
        sanitizeTraderBullets(
          sanitizeDilutionBullets(stabilized.positives),
          "positive"
        )
      );
      stabilized.negatives = sanitizeTraderBullets(
        sanitizeDilutionBullets(stabilized.negatives),
        "negative"
      );
    } else {
      stabilized.dilutionTiming = null;
      stabilized.dilutionStatus = null;
      stabilized.dilutionTriggerType = null;
      stabilized.dilutionTriggerDate = null;
      stabilized.canDiluteToday = null;
      stabilized.earliestDilution = null;
      stabilized.summary = cleanedSummary;
      stabilized.positives = sanitizeTraderBullets(stabilized.positives, "positive");
      stabilized.negatives = sanitizeTraderBullets(stabilized.negatives, "negative");
    }
  }

  stabilized.confidence = Number.isFinite(stabilized.confidence)
    ? Number(stabilized.confidence.toFixed(2))
    : 0;

  return stabilized;
}

function extractResponsesOutputText(data) {
  if (cleanText(data?.output_text)) {
    return cleanText(data.output_text);
  }

  const parts = [];
  const outputs = Array.isArray(data?.output) ? data.output : [];
  for (const item of outputs) {
    if (item?.type !== "message") continue;
    const contents = Array.isArray(item?.content) ? item.content : [];
    for (const content of contents) {
      if (content?.type === "output_text" && cleanText(content?.text)) {
        parts.push(cleanText(content.text));
      }
    }
  }

  return cleanText(parts.join("\n"));
}

function buildOpenAIUrlFallbackPrompt(rawDiscordMessage, articleLink, isFinancing) {
  const financingRules = isFinancing
    ? `
- Treat this as a financing/offering/private-placement analysis
- Keep the summary conservative and trader-focused
- Summary should usually be 2 to 4 sentences
- Include one explicit "Timing:" sentence when the article supports it
- Distinguish clearly between immediate dilution, delayed dilution at closing, and undetermined/conditional timing
- If an offering is expected to close on a future date, treat dilution as delayed until closing
- Do not treat underwriter identity, placement agent identity, exchange listing, or generic registration mechanics as positives
- Positives should usually be empty unless there is a concrete favorable counterweight such as meaningful proceeds/runway, delayed dilution timing, or specific investor participation
- Use one of these eventType labels when applicable:
  press_release_private_placement
  press_release_registered_direct
  press_release_at_the_market_financing
  press_release_warrant_financing
  press_release_offering_proposed
  press_release_offering_pricing
`
    : `
- Treat this as a general press release/news article analysis
- filingType must be null
- dilutionTiming, dilutionStatus, dilutionTriggerType, and dilutionTriggerDate should be null unless financing timing is clearly central to the article
`;

  const system = `
You are a financial press release analyst.

You are being used as a URL fallback because the application could not fetch the article body directly.

Use web search or any available webpage-grounding ability to inspect the exact article URL if possible.
Prefer the exact URL first. If the exact URL is not readable, use the headline/ticker context conservatively.

Your job:
- Try to determine whether you were able to read the real article body from the URL
- Summarize the article conservatively if you could read it
- If you could not read the article body, fall back to the raw Discord metadata only
- Extract the true article headline when possible
- ${isFinancing
    ? "Focus on offering/private-placement timing and whether dilution can happen now, later, or only after another trigger"
    : "Focus on the actual catalyst and avoid speculation"}
${financingRules}

Return STRICT JSON ONLY in this format:

{
  "headline": string,
  "summary": string,
  "positives": string[],
  "negatives": string[],
  "tickers": string[],
  "filingType": null,
  "dilutionTiming": string | null,
  "dilutionStatus": string | null,
  "dilutionTriggerType": string | null,
  "dilutionTriggerDate": string | null,
  "eventType": string,
  "confidence": number,
  "articleReadFromUrl": boolean,
  "urlReadNotes": string | null
}

Rules:
- No markdown
- No prose outside JSON
- Use empty arrays instead of null for positives and negatives
- Confidence must be a number from 0 to 1
- articleReadFromUrl must be true only if you were actually able to ground on the article body from the URL or web results strongly reflecting that article page
- If articleReadFromUrl is false, do not use investor-relations pages, SEC filings, PDFs, prior articles, search snippets, or other outside materials to add facts
- If articleReadFromUrl is false, the summary must be based only on RAW DISCORD MESSAGE and should not include revenue, EBITDA, guidance, dates, products, deal terms, or other specifics unless they appear in RAW DISCORD MESSAGE
- If articleReadFromUrl is true, do not mention Business Wire, PR Newswire, GlobeNewswire, Accesswire, the publisher, source website, article URL, or that the content is a press release in the summary or bullets; summarize the actual company event directly
- If this is a financing/offering article, be conservative on timing
- Do not speculate or give trading advice
`.trim();

  const user = `
RAW DISCORD MESSAGE:
${rawDiscordMessage}

ARTICLE URL:
${articleLink}
`.trim();

  return { system, user };
}

function deriveHeadlineFromRawDiscord(rawDiscordMessage) {
  const text = cleanText(rawDiscordMessage || "");
  if (!text) return "Article";

  const prMatch = text.match(/\bPR\s+(.+?)(?:\s+-\s+Link\b|\s+Link\b|,\s*$|$)/i);
  if (prMatch && cleanText(prMatch[1])) {
    return cleanText(prMatch[1]);
  }

  const secMatch = text.match(/\bSEC\s+-?\s*(.+?)(?:\s+-\s+Link\b|\s+Link\b|,\s*$|$)/i);
  if (secMatch && cleanText(secMatch[1])) {
    return cleanText(secMatch[1]);
  }

  return text
    .replace(/^\d{1,2}:\d{2}\s*[↑↓]?\s*/i, "")
    .replace(/\b(?:Float|IO|MC):.*$/i, "")
    .replace(/\s+-\s+Link\b.*$/i, "")
    .replace(/\s+Link\b.*$/i, "")
    .replace(/^\d+(?:\.\d+)?\s*[KMBT]?\s+[A-Z0-9.-]{1,15}\s*:\s*/i, "")
    .replace(/^[A-Z0-9.-]{1,15}\s*(?:<\s*\$?[\d.]+)?\s*-\s*/i, "")
    .trim() || "Article";
}

function buildUrlFallbackMetadataOnlyResult({ parsed, rawDiscordMessage, openaiUsage }) {
  const headline = cleanText(parsed?.headline || deriveHeadlineFromRawDiscord(rawDiscordMessage) || "Article");
  const tickerMatch = cleanText(rawDiscordMessage || "").match(/\b([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b/);
  const tickers = Array.isArray(parsed?.tickers) && parsed.tickers.length
    ? parsed.tickers.filter(Boolean).map(value => cleanText(value).toUpperCase()).filter(Boolean)
    : tickerMatch
      ? [tickerMatch[1].toUpperCase()]
      : [];

  return {
    headline,
    summary: AI_SUMMARY_UNAVAILABLE_MESSAGE,
    positives: [],
    negatives: [],
    tickers,
    filingType: null,
    dilutionTiming: null,
    dilutionStatus: null,
    dilutionTriggerType: null,
    dilutionTriggerDate: null,
    eventType: cleanText(parsed?.eventType || "press_release_unreadable"),
    confidence: Math.min(Number(parsed?.confidence || 0.35) || 0.35, 0.35),
    isFallback: true,
    urlFallbackReadSucceeded: false,
    urlFallbackNotes: parsed?.urlReadNotes ? cleanText(parsed.urlReadNotes) : "Article URL was not readable; live output was limited to host Discord metadata.",
    openaiUsage
  };
}

async function generateAIAnalysis(rawDiscordMessage, articleText, articleLink) {
  const analysisMode = detectAnalysisMode(rawDiscordMessage, articleLink);
  let promptBundle;

  if (analysisMode === "sec_filing") {
    const secPromptFamily = detectSecPromptFamily(rawDiscordMessage, articleText);
    promptBundle = secPromptFamily === "sec_dilution_financing"
      ? buildSecDilutionFinancingPrompt(rawDiscordMessage, articleText, articleLink)
      : buildSecFilingPrompt(rawDiscordMessage, articleText, articleLink);
  } else {
    const pressReleasePromptFamily = detectPressReleasePromptFamily(rawDiscordMessage, articleText);
    promptBundle = pressReleasePromptFamily === "press_release_financing"
      ? buildPressReleaseFinancingPrompt(rawDiscordMessage, articleText, articleLink)
      : buildPressReleasePrompt(rawDiscordMessage, articleText, articleLink);
  }

  let attempt = 0;
  let allowTemperature = OPENAI_TEMPERATURE !== null;
  while (attempt < OPENAI_MAX_RETRIES) {
    try {
      const requestBody = {
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: promptBundle.system },
          { role: "user", content: promptBundle.user }
        ]
      };

      if (allowTemperature && OPENAI_TEMPERATURE !== null) {
        requestBody.temperature = OPENAI_TEMPERATURE;
      }

      const { response, body: rawApiBody } = await fetchTextWithTimeout(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify(requestBody)
        },
        OPENAI_TIMEOUT_MS
      );

      if (!response.ok) {
        if (
          allowTemperature &&
          /temperature/i.test(rawApiBody) &&
          /unsupported/i.test(rawApiBody)
        ) {
          console.warn("[WARN] OpenAI temperature unsupported for this model, retrying without temperature.");
          allowTemperature = false;
          continue;
        }

        throw new Error(`OpenAI ${response.status}: ${rawApiBody}`);
      }

      const data = JSON.parse(rawApiBody);
      const raw = String(data?.choices?.[0]?.message?.content || "").trim();
      const parsed = extractJsonObject(raw);
      const openaiUsage = buildOpenAIUsageMetrics({
        model: OPENAI_MODEL,
        data,
        operation: "summary",
        attempts: attempt + 1
      });

      return {
        headline: cleanText(parsed.headline || "Article"),
        summary: sanitizeSourceAttributionText(parsed.summary || AI_SUMMARY_UNAVAILABLE_MESSAGE),
        positives: clampTraderBullets(parsed.positives),
        negatives: clampTraderBullets(parsed.negatives),
        tickers: Array.isArray(parsed.tickers)
          ? parsed.tickers.filter(Boolean).map(value => cleanText(value).toUpperCase())
          : [],
        filingType: parsed.filingType ? cleanText(parsed.filingType) : null,
        dilutionTiming: parsed.dilutionTiming ? cleanText(parsed.dilutionTiming) : null,
        dilutionStatus: parsed.dilutionStatus ? cleanText(parsed.dilutionStatus) : null,
        dilutionTriggerType: parsed.dilutionTriggerType ? cleanText(parsed.dilutionTriggerType) : null,
        dilutionTriggerDate: parsed.dilutionTriggerDate ? cleanText(parsed.dilutionTriggerDate) : null,
        eventType: cleanText(parsed.eventType || "unknown"),
        confidence: Number(parsed.confidence || 0),
        isFallback: false,
        openaiUsage
      };
    } catch (err) {
      attempt++;
      console.warn(`[WARN] OpenAI retry ${attempt}: ${err.message}`);
      await sleep(1500 * attempt);
    }
  }

  throw new Error(`OpenAI failed after ${OPENAI_MAX_RETRIES} retries`);
}

async function generateAIUrlFallbackAnalysis(rawDiscordMessage, articleLink) {
  if (!OPENAI_URL_FALLBACK_ENABLED) {
    throw new Error("OpenAI URL fallback disabled");
  }

  const isFinancing = detectPressReleasePromptFamily(rawDiscordMessage, "") === "press_release_financing";
  const promptBundle = buildOpenAIUrlFallbackPrompt(rawDiscordMessage, articleLink, isFinancing);
  const maxAttempts = Math.max(1, Number(OPENAI_URL_FALLBACK_MAX_RETRIES || 1));

  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      const requestBody = {
        model: OPENAI_MODEL,
        instructions: promptBundle.system,
        input: promptBundle.user,
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        include: ["web_search_call.action.sources"]
      };

      const { response, body: rawApiBody } = await fetchTextWithTimeout(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify(requestBody)
        },
        OPENAI_URL_FALLBACK_TIMEOUT_MS
      );

      if (!response.ok) {
        throw new Error(`OpenAI URL fallback ${response.status}: ${rawApiBody}`);
      }

      const data = JSON.parse(rawApiBody);
      const raw = extractResponsesOutputText(data);
      const parsed = extractJsonObject(raw);
      const openaiUsage = buildOpenAIUsageMetrics({
        model: OPENAI_MODEL,
        data,
        operation: "url_fallback",
        attempts: attempt + 1
      });
      const articleReadFromUrl = Boolean(parsed.articleReadFromUrl);

      if (!articleReadFromUrl) {
        return buildUrlFallbackMetadataOnlyResult({
          parsed,
          rawDiscordMessage,
          openaiUsage
        });
      }

      return {
        headline: cleanText(parsed.headline || "Article"),
        summary: sanitizeSourceAttributionText(parsed.summary || AI_SUMMARY_UNAVAILABLE_MESSAGE),
        positives: clampTraderBullets(parsed.positives),
        negatives: clampTraderBullets(parsed.negatives),
        tickers: Array.isArray(parsed.tickers)
          ? parsed.tickers.filter(Boolean).map(value => cleanText(value).toUpperCase())
          : [],
        filingType: null,
        dilutionTiming: parsed.dilutionTiming ? cleanText(parsed.dilutionTiming) : null,
        dilutionStatus: parsed.dilutionStatus ? cleanText(parsed.dilutionStatus) : null,
        dilutionTriggerType: parsed.dilutionTriggerType ? cleanText(parsed.dilutionTriggerType) : null,
        dilutionTriggerDate: parsed.dilutionTriggerDate ? cleanText(parsed.dilutionTriggerDate) : null,
        eventType: cleanText(parsed.eventType || "unknown"),
        confidence: Number(parsed.confidence || 0),
        isFallback: !articleReadFromUrl,
        urlFallbackReadSucceeded: articleReadFromUrl,
        urlFallbackNotes: parsed.urlReadNotes ? cleanText(parsed.urlReadNotes) : null,
        openaiUsage
      };
    } catch (err) {
      attempt++;
      console.warn(`[WARN] OpenAI URL fallback retry ${attempt}: ${err.message}`);
      await sleep(1500 * attempt);
    }
  }

  throw new Error(`OpenAI URL fallback failed after ${maxAttempts} retries`);
}

module.exports = {
  deriveHeadlineFromRawDiscord,
  generateAIAnalysis,
  generateAIUrlFallbackAnalysis,
  stabilizeAIResult,
  sanitizeTraderBullets,
  sanitizeSourceAttributionText,
  buildUrlFallbackMetadataOnlyResult
};
