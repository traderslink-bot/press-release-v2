const {
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_TEMPERATURE,
  REVIEW_TIMEOUT_MS,
  REVIEW_MAX_RETRIES
} = require("./config");
const { fetchTextWithTimeout } = require("./http");
const { sleep, cleanText, extractJsonObject } = require("./utils");
const { extractSecFormTypeFromRawText, isSecSource } = require("./sec");
const { buildOpenAIUsageMetrics } = require("./openaiUsage");

function buildReviewPrompt(result) {
  const filingTypeHint = extractSecFormTypeFromRawText(result.rawText || "");

  const instructions = `
You are reviewing the quality of an AI-generated SEC filing summary for a trader-facing Discord bot.

Your job:
- Read the SEC filing text
- Read the bot's structured output
- Judge whether the bot classified and summarized the filing correctly
- Focus on whether the output is supported by the filing text, not whether it is written elegantly

Review rules:
- Be conservative
- Mark a field incorrect if it is materially unsupported, misleading, or wrongly framed
- Treat neutral metadata presented as a positive or negative as a classification issue
- For dilution / financing filings, pay special attention to whether the output correctly distinguishes:
  immediate dilution,
  delayed or potential dilution,
  resale overhang,
  effectiveness status,
  and who is selling
- If the filing type from the host metadata appears inconsistent with the filing text, say so
- Keep explanations brief and concrete

Return STRICT JSON ONLY in this format:
{
  "verdict": "pass" | "mixed" | "fail",
  "filingTypeCorrect": boolean | null,
  "eventTypeCorrect": boolean | null,
  "summarySupported": boolean,
  "positivesSupported": boolean,
  "negativesSupported": boolean,
  "keyIssues": string[],
  "notes": string[],
  "suggestedCorrections": {
    "filingType": string | null,
    "eventType": string | null,
    "summaryFocus": string | null,
    "positivesToRemove": string[],
    "negativesToRemove": string[]
  }
}
`.trim();

  const input = `
HOST METADATA:
${result.rawText || "N/A"}

HOST FILING TYPE HINT:
${filingTypeHint || "N/A"}

SEC URL:
${result.articleLink || "N/A"}

AI OUTPUT JSON:
${JSON.stringify({
    headline: result.headline,
    summary: result.summary,
    positives: result.positives,
    negatives: result.negatives,
    filingType: result.filingType,
    dilutionTiming: result.dilutionTiming,
    dilutionStatus: result.dilutionStatus,
    dilutionTriggerType: result.dilutionTriggerType,
    dilutionTriggerDate: result.dilutionTriggerDate,
    canDiluteToday: result.canDiluteToday,
    earliestDilution: result.earliestDilution,
    eventType: result.eventType,
    confidence: result.confidence
  }, null, 2)}

FULL FILING TEXT:
${result.articleText || "N/A"}
`.trim();

  return {
    system: instructions,
    user: input
  };
}

async function reviewSecResult(result) {
  if (!isSecSource(result.articleLink)) {
    return null;
  }

  const promptBundle = buildReviewPrompt(result);
  let attempt = 0;
  let allowTemperature = OPENAI_TEMPERATURE !== null;

  while (attempt < REVIEW_MAX_RETRIES) {
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
        REVIEW_TIMEOUT_MS
      );

      if (!response.ok) {
        if (
          allowTemperature &&
          /temperature/i.test(rawApiBody) &&
          /unsupported/i.test(rawApiBody)
        ) {
          console.warn("[WARN] Review temperature unsupported for this model, retrying without temperature.");
          allowTemperature = false;
          continue;
        }

        throw new Error(`OpenAI review ${response.status}: ${rawApiBody}`);
      }

      const data = JSON.parse(rawApiBody);
      const raw = String(data?.choices?.[0]?.message?.content || "").trim();
      const parsed = extractJsonObject(raw);
      const openaiUsage = buildOpenAIUsageMetrics({
        model: OPENAI_MODEL,
        data,
        operation: "review",
        attempts: attempt + 1
      });

      return {
        verdict: cleanText(parsed.verdict || "mixed").toLowerCase(),
        filingTypeCorrect: typeof parsed.filingTypeCorrect === "boolean" ? parsed.filingTypeCorrect : null,
        eventTypeCorrect: typeof parsed.eventTypeCorrect === "boolean" ? parsed.eventTypeCorrect : null,
        summarySupported: Boolean(parsed.summarySupported),
        positivesSupported: Boolean(parsed.positivesSupported),
        negativesSupported: Boolean(parsed.negativesSupported),
        keyIssues: Array.isArray(parsed.keyIssues) ? parsed.keyIssues.map(cleanText).filter(Boolean) : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes.map(cleanText).filter(Boolean) : [],
        suggestedCorrections: {
          filingType: parsed?.suggestedCorrections?.filingType
            ? cleanText(parsed.suggestedCorrections.filingType)
            : null,
          eventType: parsed?.suggestedCorrections?.eventType
            ? cleanText(parsed.suggestedCorrections.eventType)
            : null,
          summaryFocus: parsed?.suggestedCorrections?.summaryFocus
            ? cleanText(parsed.suggestedCorrections.summaryFocus)
            : null,
          positivesToRemove: Array.isArray(parsed?.suggestedCorrections?.positivesToRemove)
            ? parsed.suggestedCorrections.positivesToRemove.map(cleanText).filter(Boolean)
            : [],
          negativesToRemove: Array.isArray(parsed?.suggestedCorrections?.negativesToRemove)
            ? parsed.suggestedCorrections.negativesToRemove.map(cleanText).filter(Boolean)
            : []
        },
        openaiUsage
      };
    } catch (err) {
      attempt++;
      console.warn(`[WARN] Review retry ${attempt}: ${err.message}`);
      await sleep(1500 * attempt);
    }
  }

  throw new Error(`SEC review failed after ${REVIEW_MAX_RETRIES} retries`);
}

module.exports = {
  reviewSecResult
};
