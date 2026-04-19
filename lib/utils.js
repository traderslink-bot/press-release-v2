function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeEmbedText(value, fallback = "N/A") {
  const text = String(value || "").trim();
  return text ? text : fallback;
}

function normalizeCompactMetric(value, fallback = "N/A") {
  const text = cleanText(value);
  if (!text) return fallback;

  const compactMatch = text.match(/^([\d.,]+)\s*([KMBT])$/i);
  if (compactMatch) {
    return `${compactMatch[1]}${compactMatch[2].toUpperCase()}`;
  }

  return text.replace(/(\d)\s+([KMBT])\b/gi, (_, digit, suffix) => `${digit}${suffix.toUpperCase()}`);
}

function clampFieldValue(value, max = 1024) {
  const text = String(value || "").trim();
  if (!text) return "N/A";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function splitTextIntoChunks(text, size) {
  const src = String(text || "");
  if (!src) return [];
  if (src.length <= size) return [src];

  const chunks = [];
  let remaining = src;

  while (remaining.length > size) {
    let idx = remaining.lastIndexOf("\n", size);
    if (idx < Math.floor(size * 0.6)) idx = remaining.lastIndexOf(" ", size);
    if (idx < Math.floor(size * 0.4)) idx = size;

    const part = remaining.slice(0, idx).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(idx).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function rememberSnowflake(targetSet, snowflake, maxSeenSnowflakes) {
  if (!snowflake) return;
  targetSet.add(snowflake);

  while (targetSet.size > maxSeenSnowflakes) {
    const oldest = targetSet.values().next().value;
    if (!oldest) break;
    targetSet.delete(oldest);
  }
}

function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJsonObject(rawText) {
  const text = String(rawText || "").trim();
  if (!text) throw new Error("OpenAI returned empty content");

  try {
    return JSON.parse(text);
  } catch (_) {
    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch) {
      return JSON.parse(fencedMatch[1]);
    }

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
  }

  throw new Error("Unable to parse JSON response from OpenAI");
}

function getCurrentEasternDateKey() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  return formatter.format(new Date());
}

function dateKeyFromDisplayDate(displayDate) {
  const text = cleanText(displayDate || "");
  if (!text) return null;

  const parts = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!parts) return null;

  const [, monthRaw, dayRaw, year] = parts;
  const monthMap = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12"
  };

  const normalizedMonth = monthMap[monthRaw.slice(0, 3)] || null;
  if (!normalizedMonth) return null;

  return `${year}-${normalizedMonth}-${String(Number(dayRaw)).padStart(2, "0")}`;
}

module.exports = {
  sleep,
  cleanText,
  normalizeEmbedText,
  normalizeCompactMetric,
  clampFieldValue,
  splitTextIntoChunks,
  rememberSnowflake,
  stripHtmlToText,
  extractJsonObject,
  getCurrentEasternDateKey,
  dateKeyFromDisplayDate
};
