const {
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_TEMPERATURE,
  OPENAI_TIMEOUT_MS,
  OPENAI_URL_FALLBACK_ENABLED,
  OPENAI_URL_FALLBACK_TIMEOUT_MS,
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

function canonicalizeSecFilingType(rawDiscordMessage, aiFilingType) {
  const fromDiscord = extractSecFormTypeFromRawText(rawDiscordMessage);
  if (fromDiscord) {
    return normalizeSecFilingType(fromDiscord);
  }

  const normalizedAI = normalizeSecFilingType(aiFilingType);
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

function deriveSecEventType(filingType, aiEventType) {
  const normalizedType = normalizeSecFilingType(filingType);
  const normalizedAI = cleanText(aiEventType || "").toLowerCase();

  if (normalizedType) {
    if (/^(?:8-K|6-K)$/.test(normalizedType)) return "sec_current_report";
    if (/^(?:10-K|10-Q|20-F|40-F)$/.test(normalizedType)) return "sec_periodic_report";
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
  }

  if (normalizedAI.includes("ownership")) return "sec_beneficial_ownership";
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
      : deriveSecEventType(stabilized.filingType, ai.eventType);
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
      stabilized.positives = sanitizeDilutionBullets(stabilized.positives);
      stabilized.negatives = sanitizeDilutionBullets(stabilized.negatives);
    } else {
      stabilized.dilutionTiming = null;
      stabilized.dilutionStatus = null;
      stabilized.dilutionTriggerType = null;
      stabilized.dilutionTriggerDate = null;
      stabilized.canDiluteToday = null;
      stabilized.earliestDilution = null;
      stabilized.summary = refinedSummary;
    }
  } else {
    stabilized.filingType = null;
    stabilized.eventType = derivePressReleaseEventType(ai.eventType, articleText, data.rawText);
    const cleanedSummary = cleanText(ai.summary || "No summary available.");
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
        sanitizeDilutionBullets(stabilized.positives)
      );
      stabilized.negatives = sanitizeDilutionBullets(stabilized.negatives);
    } else {
      stabilized.dilutionTiming = null;
      stabilized.dilutionStatus = null;
      stabilized.dilutionTriggerType = null;
      stabilized.dilutionTriggerDate = null;
      stabilized.canDiluteToday = null;
      stabilized.earliestDilution = null;
      stabilized.summary = cleanedSummary;
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
- If you could not read the article body, fall back to the raw Discord metadata only and say specifics were unavailable
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
- If articleReadFromUrl is false, the summary must explicitly say that full article specifics were unavailable and it is based on headline/Discord metadata
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
        summary: cleanText(parsed.summary || "No summary available."),
        positives: Array.isArray(parsed.positives) ? parsed.positives.filter(Boolean).map(cleanText) : [],
        negatives: Array.isArray(parsed.negatives) ? parsed.negatives.filter(Boolean).map(cleanText) : [],
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

  let attempt = 0;
  while (attempt < OPENAI_MAX_RETRIES) {
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

      return {
        headline: cleanText(parsed.headline || "Article"),
        summary: cleanText(parsed.summary || "No summary available."),
        positives: Array.isArray(parsed.positives) ? parsed.positives.filter(Boolean).map(cleanText) : [],
        negatives: Array.isArray(parsed.negatives) ? parsed.negatives.filter(Boolean).map(cleanText) : [],
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

  throw new Error(`OpenAI URL fallback failed after ${OPENAI_MAX_RETRIES} retries`);
}

module.exports = {
  generateAIAnalysis,
  generateAIUrlFallbackAnalysis,
  stabilizeAIResult
};
