const {
  DISCORD_WEBHOOK_URL,
  NEWS_FILTERED_SECOND_WEBHOOK_URL,
  DROP_WEBHOOK_URL,
  MARKET_CAP_UNDER_30M_WEBHOOK_URL,
  NEWS_UNDER_30M_MC_SECOND_WEBHOOK_URL,
  MARKET_CAP_30M_TO_50M_WEBHOOK_URL,
  NEWS_UNDER_50M_MC_SECOND_WEBHOOK_URL,
  MARKET_CAP_50M_TO_100M_WEBHOOK_URL,
  NEWS_UNDER_100M_MC_SECOND_WEBHOOK_URL,
  WEBHOOK_OVERRIDE_URL,
  WEBHOOK_OVERRIDE_DILUTION_ONLY,
  DISCORD_BOT_TOKEN,
  DISCORD_BOT_API_BASE_URL,
  DISCORD_FREE_NEWS_BOT_ENABLED,
  DISCORD_FREE_NEWS_BOT_ROUTE_TAGS,
  DISCORD_TIMEOUT_MS,
  REPLAY_SKIP_WEBHOOKS,
  TICKER_DISPLAY_VARIANT
} = require("./config");
const { fetchTextWithTimeout } = require("./http");
const { getActiveFreeNewsSubscribers } = require("./freeNewsSubscribers");
const {
  sleep,
  normalizeEmbedText,
  normalizeCompactMetric,
  clampFieldValue,
  splitTextIntoChunks
} = require("./utils");
const { normalizeSecDocumentUrl } = require("./sec");

const MAX_FIELDS_PER_EMBED = 25;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_DESC_PER_EMBED = 4000;
const WEBHOOK_MAX_ATTEMPTS = 4;
const WEBHOOK_RETRY_BASE_MS = 2500;
const EXTERNAL_BOT_FORBIDDEN_PAYLOAD_PATTERNS = [
  /discord(?:app)?\.com\/channels\//i,
  /discord(?:app)?\.com\/api\/webhooks\//i,
  /news\.nuntiobot\.com/i,
  /sec\.gov/i
];

function uniqueWebhookTargets(targets) {
  return Array.from(new Set(targets.filter(Boolean)));
}

function uniqueBotTargets(targets) {
  const seen = new Set();
  const uniqueTargets = [];

  for (const target of Array.isArray(targets) ? targets : []) {
    const channelId = String(target?.channelId || "").trim();
    if (!channelId || seen.has(channelId)) continue;
    seen.add(channelId);
    uniqueTargets.push(target);
  }

  return uniqueTargets;
}

function normalizeRouteTag(value) {
  return String(value || "default").trim().toLowerCase();
}

function shouldUseFreeNewsBotTargets(routeTag, postingDecision = null, options = {}) {
  const enabled = options.enabled ?? DISCORD_FREE_NEWS_BOT_ENABLED;
  const botToken = options.botToken ?? DISCORD_BOT_TOKEN;
  const routeTags = options.routeTags ?? DISCORD_FREE_NEWS_BOT_ROUTE_TAGS;
  const webhookOverrideUrl = options.webhookOverrideUrl ?? WEBHOOK_OVERRIDE_URL;

  if (!enabled || !botToken || webhookOverrideUrl) {
    return false;
  }

  const primaryEligible = postingDecision ? postingDecision.allowPrimary === true : true;
  if (!primaryEligible) {
    return false;
  }

  const allowedRouteTags = new Set(
    (Array.isArray(routeTags) && routeTags.length ? routeTags : ["default"])
      .map(normalizeRouteTag)
      .filter(Boolean)
  );

  return allowedRouteTags.has(normalizeRouteTag(routeTag));
}

function normalizeDiscordRetryAfterMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;

  // Discord's JSON body reports seconds; some retry-after headers arrive as ms.
  return numeric > 1000 ? numeric : numeric * 1000;
}

function parseDiscordRetryBody(body) {
  try {
    return JSON.parse(String(body || "").trim());
  } catch (_) {
    return null;
  }
}

function getDiscordRetryAfterMs(response, body) {
  const parsedBody = parseDiscordRetryBody(body);
  const bodyDelayMs = normalizeDiscordRetryAfterMs(parsedBody?.retry_after);
  if (bodyDelayMs > 0) return bodyDelayMs + 250;

  const headerDelayMs = normalizeDiscordRetryAfterMs(response?.headers?.get?.("retry-after"));
  return headerDelayMs > 0 ? headerDelayMs + 250 : 0;
}

function appendTruncationNotice(text, limit, notice) {
  const normalizedText = String(text || "").trim();
  const normalizedNotice = String(notice || "").trim();

  if (!normalizedNotice) {
    return normalizedText;
  }

  const combined = normalizedText
    ? `${normalizedText}\n\n${normalizedNotice}`
    : normalizedNotice;

  if (combined.length <= limit) {
    return combined;
  }

  const availableTextLength = Math.max(0, limit - normalizedNotice.length - 5);
  const truncatedText = availableTextLength
    ? `${normalizedText.slice(0, availableTextLength).trim()}...`
    : "...";

  return `${truncatedText}\n\n${normalizedNotice}`;
}

function buildSnapshotBlock(ai, metadata) {
  const emphasizeLabel = text =>
    String(text || "").replace(/^([^:]+):\s*/, (_match, label) => `**${label}:** `);

  const routeTag = String(metadata?.routeTag || "").trim().toLowerCase();
  if (
    metadata?.feedType === "market_cap" ||
    routeTag === "market_cap_under_30m" ||
    routeTag === "market_cap_30m_to_50m" ||
    routeTag === "market_cap_50m_to_100m"
  ) {
    const detailParts = [];
    const marketCap = normalizeCompactMetric(metadata.marketCap);
    const flag = normalizeEmbedText(metadata.flag, "");

    if (marketCap && marketCap !== "N/A") {
      detailParts.push(`**Market Cap:** ${marketCap}`);
    }

    if (flag) {
      detailParts.push(`**Flag:** ${flag}`);
    }

    if (ai.filingType) {
      detailParts.push(`**Filing Type:** ${ai.filingType}`);
    }

    const lines = [];
    if (flag && hasHighRiskCountryFlag(flag)) {
      lines.push("Country indicates very high risk");
    }
    if (detailParts.length) {
      lines.push(detailParts.join(" | "));
    }

    if (shouldShowDilutionSnapshot(ai)) {
      if (lines.length) lines.push("");
      if (ai.canDiluteToday) {
        lines.push(emphasizeLabel(ai.canDiluteToday));
      }

      if (ai.earliestDilution) {
        lines.push(emphasizeLabel(ai.earliestDilution));
      }
    }

    return lines.join("\n");
  }

  const detailParts = [
    `**Float:** ${normalizeCompactMetric(metadata.float)}`,
    `**IO:** ${normalizeEmbedText(metadata.io, "N/A")}`,
    `**MC:** ${normalizeCompactMetric(metadata.marketCap)}`
  ];

  if (ai.filingType) {
    detailParts.push(`**Filing Type:** ${ai.filingType}`);
  }

  const lines = [detailParts.join(" | ")];

  if (shouldShowDilutionSnapshot(ai)) {
    lines.push("");
    if (ai.canDiluteToday) {
      lines.push(emphasizeLabel(ai.canDiluteToday));
    }

    if (ai.earliestDilution) {
      lines.push(emphasizeLabel(ai.earliestDilution));
    }
  }

  return lines.join("\n");
}

function hasHighRiskCountryFlag(flag) {
  const normalizedFlag = normalizeEmbedText(flag, "").toLowerCase();
  if (!normalizedFlag) return false;

  return (
    /\b(?:china|chinese|cn|singapore|sg|hong\s*kong|hongkong|hk)\b/i.test(normalizedFlag) ||
    normalizedFlag.includes("\uD83C\uDDE8\uD83C\uDDF3") ||
    normalizedFlag.includes("\uD83C\uDDF8\uD83C\uDDEC") ||
    normalizedFlag.includes("\uD83C\uDDED\uD83C\uDDF0")
  );
}

function shouldShowDilutionSnapshot(ai) {
  return Boolean(ai?.canDiluteToday || ai?.earliestDilution);
}

function isDilutionRelevantOutput(ai) {
  return shouldShowDilutionSnapshot(ai);
}

function isNuntioBotUrl(url) {
  try {
    return new URL(String(url || "").trim()).hostname.toLowerCase() === "news.nuntiobot.com";
  } catch (_) {
    return false;
  }
}

function buildSourceField(articleLink, isSecLink, ai = null) {
  const normalized = String(articleLink || "").trim();
  if (!normalized || /^null$/i.test(normalized)) {
    return null;
  }

  if (isNuntioBotUrl(normalized)) {
    return null;
  }

  if (!isSecLink) {
    if (!ai?.isFallback && !ai?.isBusinessWireHeadlineOnly) {
      return null;
    }

    return {
      name: ai?.isBusinessWireHeadlineOnly ? "BusinessWire Link" : "Original Article",
      value: ai?.isBusinessWireHeadlineOnly
        ? `**[Open BusinessWire Release](${normalized})**`
        : `**[Open Original Article](${normalized})**`,
      inline: false
    };
  }

  return {
    name: "SEC Filing Link",
    value: `[Open SEC Filing](${normalized})`,
    inline: false
  };
}

function buildFormattedLevelsText(levelsText) {
  return buildFormattedLevelsParts(levelsText).text;
}

function formatEasternGeneratedAt(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).format(date);
}

function formatLevelsGeneratedFooter(line) {
  const plainLine = String(line || "").trim();
  if (!plainLine) return "";

  const match = plainLine.match(
    /^Data generated during\s+(.+?)\s+session(?:\s+at\s+(\$?[0-9.,]+))?(?:\s+on\s+(.+))?$/i
  );

  if (!match) return plainLine;

  const session = String(match[1] || "").trim().toUpperCase();
  const price = String(match[2] || "").trim();
  const generatedAt = String(match[3] || "").trim() || formatEasternGeneratedAt();
  const parts = [];

  parts.push(`Generated ${generatedAt}`);

  if (session) {
    parts.push(`${session} session`);
  }

  if (price) {
    parts.push(`Price ${price.startsWith("$") ? price : `$${price}`}`);
  }

  return parts.join(" | ");
}

function buildFormattedLevelsParts(levelsText) {
  const cleaned = String(levelsText || "")
    .replace(/\r/g, "")
    .trim();

  if (!cleaned) {
    return { text: "", footerText: "" };
  }

  const lines = cleaned
    .split("\n")
    .map(line => line.trim())
    .map(line =>
      line
        .replace(/^\*\*([^*]+)\*\*(.*)$/i, "$1$2")
        .replace(/^_(.+)_$/i, "$1")
    )
    .filter(Boolean)
    .filter(line => !/^levels?$/i.test(line))
    .filter(line => !/^\$[A-Z.]+$/i.test(line))
    .filter(line => !/^Levels are not intended to predict target price$/i.test(line))
    .filter(line => !/^Data is from daily and 4 hour charts\./i.test(line))
    .filter(line => !/^Levels shown are not exhaustive\./i.test(line));

  const dataGenerated = lines.find(line => /^Data generated during /i.test(line)) || null;
  const contentLines = lines.filter(line => !/^Data generated during /i.test(line));
  const findValue = label => {
    const inlineLine = contentLines.find(line => new RegExp(`^${label}:\\s+`, "i").test(line));
    if (inlineLine) {
      return inlineLine.replace(new RegExp(`^${label}:\\s+`, "i"), "").replace(/\s+/g, " ").trim();
    }

    const index = contentLines.findIndex(line => new RegExp(`^${label}$`, "i").test(line));
    if (index === -1) return null;
    const next = contentLines[index + 1];
    return next ? next.replace(/\s+/g, " ").trim() : null;
  };

  const resistance = findValue("Resistance");
  const support = findValue("Support");
  const rendered = [];

  if (resistance) rendered.push(`**Resistance:** ${resistance}`);
  if (support) rendered.push(`**Support:** ${support}`);

  return {
    text: rendered.length ? rendered.join("\n\n") : contentLines.join("\n"),
    footerText: formatLevelsGeneratedFooter(dataGenerated)
  };
}

function buildLevelsFieldsFromText(cleaned, maxFields = 20) {
  const allowedFieldCount = Math.max(0, Number(maxFields) || 0);

  if (!cleaned || allowedFieldCount <= 0) {
    return [];
  }

  const chunks = splitTextIntoChunks(cleaned, 1024);
  const hasOverflow = chunks.length > allowedFieldCount;
  const chunkFieldLimit = hasOverflow ? Math.max(0, allowedFieldCount - 1) : allowedFieldCount;
  const limitedChunks = chunks.slice(0, chunkFieldLimit);

  const fields = limitedChunks.map(chunk => ({
    name: "\u200B",
    value: chunk,
    inline: false
  }));

  if (hasOverflow) {
    fields.push({
      name: "\u200B",
      value: `Additional levels output was truncated (${chunks.length - chunkFieldLimit} more chunk(s)).`,
      inline: false
    });
  }

  return fields;
}

function buildLevelsFields(levelsText, maxFields = 20) {
  return buildLevelsFieldsFromText(buildFormattedLevelsText(levelsText), maxFields);
}

function buildLevelsEmbed(tickerLabel, levelsText) {
  const formattedLevels = buildFormattedLevelsParts(levelsText);
  const levelsFields = buildLevelsFieldsFromText(formattedLevels.text, MAX_FIELDS_PER_EMBED);
  const embed = {
    title: `$${tickerLabel} Levels`,
    color: 0x4da3ff,
    fields: levelsFields.length
      ? levelsFields
      : [
          {
            name: "\u200B",
            value: "Levels unavailable.",
            inline: false
          }
        ]
  };

  if (formattedLevels.footerText) {
    embed.footer = { text: formattedLevels.footerText };
  }

  return embed;
}

function addChunkedTextFields(fields, label, text, maxFields) {
  const allowedFieldCount = Math.max(0, Number(maxFields) || 0);
  if (allowedFieldCount <= 0) {
    return 0;
  }

  const chunks = splitTextIntoChunks(normalizeEmbedText(text, "None"), 1024);
  const hasOverflow = chunks.length > allowedFieldCount;
  const chunkFieldLimit = hasOverflow ? Math.max(0, allowedFieldCount - 1) : allowedFieldCount;
  const limitedChunks = chunks.slice(0, chunkFieldLimit);

  for (const [index, chunk] of limitedChunks.entries()) {
    fields.push({
      name: index === 0 ? label : `${label} (cont.)`,
      value: chunk,
      inline: false
    });
  }

  if (hasOverflow) {
    fields.push({
      name: `${label} (truncated)`,
      value: `${chunks.length - chunkFieldLimit} more chunk(s) were truncated.`,
      inline: false
    });
  }

  return fields.length;
}

function buildDiscordEmbeds(ai, metadata, articleLink, levelsText, options = {}) {
  const isSecLink = normalizeSecDocumentUrl(articleLink).includes("sec.gov");
  const includeLevels = options.includeLevels !== false;
  const businessWireHeadlineOnly = Boolean(ai?.isBusinessWireHeadlineOnly);
  const showSentimentFields = !(ai?.isFallback && ai?.urlFallbackReadSucceeded !== true && !isSecLink);
  const sourceField = buildSourceField(articleLink, isSecLink, ai);
  const tickerLabel = String(metadata.ticker || "").trim().toUpperCase();
  const snapshotLine = buildSnapshotBlock(ai, metadata);

  if (businessWireHeadlineOnly) {
    const fields = [];
    if (sourceField) {
      fields.push({
        name: sourceField.name,
        value: clampFieldValue(sourceField.value, 1024),
        inline: false
      });
    }

    const embeds = [
      {
        title: `$${tickerLabel}`,
        color: 0x4da3ff,
        description: `\u200B\n**${ai.headline}**\n\n${snapshotLine}\n\u200B`,
        fields
      }
    ];

    if (includeLevels) {
      embeds.push(buildLevelsEmbed(tickerLabel, levelsText));
    }

    return embeds.slice(0, MAX_EMBEDS_PER_MESSAGE);
  }

  const firstChunkPrefix = `\u200B\n**${ai.headline}**\n\n${snapshotLine}\n\n`;
  const firstChunkLimit = Math.max(500, MAX_DESC_PER_EMBED - firstChunkPrefix.length);
  const reservedSectionEmbeds = 1;
  const maxSummaryEmbeds = Math.max(1, MAX_EMBEDS_PER_MESSAGE - reservedSectionEmbeds);

  const rawSummaryChunks = splitTextIntoChunks(
    normalizeEmbedText(ai.summary, "AI summary could not be provided for this article."),
    firstChunkLimit
  );
  const summaryOverflowNotice = "[Summary truncated to fit Discord embed limit.]";
  const summaryChunks = rawSummaryChunks.slice(0, maxSummaryEmbeds).map((chunk, index, chunks) => {
    const isLastRetainedChunk = index === chunks.length - 1;
    const hasOverflow = rawSummaryChunks.length > maxSummaryEmbeds && isLastRetainedChunk;
    const limit = index === 0 ? firstChunkLimit : MAX_DESC_PER_EMBED;
    return hasOverflow
      ? appendTruncationNotice(chunk, limit, summaryOverflowNotice)
      : chunk;
  });

  const positives = Array.isArray(ai.positives) && ai.positives.length
    ? ai.positives.map(p => `- ${p}`).join("\n")
    : "None";

  const negatives = Array.isArray(ai.negatives) && ai.negatives.length
    ? ai.negatives.map(n => `- ${n}`).join("\n")
    : "None";

  const summaryEmbeds = summaryChunks.map((chunkText, index) => {
    const fields = index === 0
      ? [
          ...(ai.isFallback && isSecLink
            ? [
                {
                  name: "Read Filing",
                  value: clampFieldValue(`[Open SEC Filing](${articleLink})`, 1024),
                  inline: false
                }
              ]
            : []),
          ...(sourceField
            ? [
                {
                  name: sourceField.name,
                  value: clampFieldValue(sourceField.value, 1024),
                  inline: false
                }
              ]
            : [])
        ]
      : [];

    return {
      title: `$${String(metadata.ticker || "").trim().toUpperCase()}`,
      color: 0x4da3ff,
      description: index === 0 ? `${firstChunkPrefix}${chunkText}\n\u200B` : chunkText,
      fields
    };
  });

  const positivesNegativesFields = [];
  if (showSentimentFields) {
    let remainingSentimentFieldBudget = MAX_FIELDS_PER_EMBED;
    const startingSentimentFieldCount = positivesNegativesFields.length;
    addChunkedTextFields(positivesNegativesFields, "Positives", positives, remainingSentimentFieldBudget);
    remainingSentimentFieldBudget = Math.max(0, MAX_FIELDS_PER_EMBED - positivesNegativesFields.length);
    addChunkedTextFields(positivesNegativesFields, "Negatives", negatives, remainingSentimentFieldBudget);

    if (positivesNegativesFields.length === startingSentimentFieldCount) {
      positivesNegativesFields.push({
        name: "\u200B",
        value: "No positives or negatives available.",
        inline: false
      });
    }
  }

  const lastSummaryEmbedIndex = Math.max(0, summaryChunks.length - 1);

  const sectionEmbeds = [];
  if (includeLevels) {
    sectionEmbeds.push(buildLevelsEmbed(tickerLabel, levelsText));
  }

  const mergedSummaryEmbeds = summaryEmbeds.map((embed, index) => {
    const existingFields = Array.isArray(embed.fields) ? embed.fields.slice() : [];
    if (index === lastSummaryEmbedIndex) {
      existingFields.push(...positivesNegativesFields);
    }

    return {
      ...embed,
      title: index === 0 ? `$${tickerLabel}` : undefined,
      fields: existingFields
    };
  });

  return [...mergedSummaryEmbeds, ...sectionEmbeds].slice(0, MAX_EMBEDS_PER_MESSAGE);
}

function getWebhookTargets(routeTag, ai = null, postingDecision = null) {
  if (WEBHOOK_OVERRIDE_URL) {
    if (WEBHOOK_OVERRIDE_DILUTION_ONLY && !isDilutionRelevantOutput(ai)) {
      return [];
    }

    return [WEBHOOK_OVERRIDE_URL];
  }

  if (routeTag === "market_cap_under_30m") {
    return uniqueWebhookTargets([
      MARKET_CAP_UNDER_30M_WEBHOOK_URL,
      NEWS_UNDER_30M_MC_SECOND_WEBHOOK_URL
    ]);
  }

  if (routeTag === "market_cap_30m_to_50m") {
    return uniqueWebhookTargets([
      MARKET_CAP_30M_TO_50M_WEBHOOK_URL,
      NEWS_UNDER_50M_MC_SECOND_WEBHOOK_URL
    ]);
  }

  if (routeTag === "market_cap_50m_to_100m") {
    return uniqueWebhookTargets([
      MARKET_CAP_50M_TO_100M_WEBHOOK_URL,
      NEWS_UNDER_100M_MC_SECOND_WEBHOOK_URL
    ]);
  }

  if (routeTag === "drop") {
    return [];
  }

  const primaryEligible = postingDecision ? postingDecision.allowPrimary === true : true;
  const targets = [];

  if (DISCORD_WEBHOOK_URL && primaryEligible) {
    targets.push(DISCORD_WEBHOOK_URL);
  }

  if (NEWS_FILTERED_SECOND_WEBHOOK_URL && primaryEligible) {
    targets.push(NEWS_FILTERED_SECOND_WEBHOOK_URL);
  }

  return uniqueWebhookTargets(targets);
}

function getFreeNewsBotTargets(routeTag, postingDecision = null) {
  if (!shouldUseFreeNewsBotTargets(routeTag, postingDecision)) {
    return [];
  }

  return uniqueBotTargets(getActiveFreeNewsSubscribers());
}

function buildDiscordBotChannelUrl(channelId) {
  const apiBase = String(DISCORD_BOT_API_BASE_URL || "https://discord.com/api/v10").replace(/\/+$/, "");
  return `${apiBase}/channels/${encodeURIComponent(channelId)}/messages`;
}

function isTradersLinkFreeNewsUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return (
      ["traderslink.pro", "app.traderslink.pro"].includes(
        parsed.hostname.toLowerCase()
      ) &&
      parsed.pathname.startsWith("/news/free/")
    );
  } catch (_) {
    return false;
  }
}

function extractPayloadUrls(payload) {
  return Array.from(JSON.stringify(payload || {}).matchAll(/https?:\/\/[^\s<>"\\)]+/gi)).map(match =>
    String(match[0] || "").replace(/[.,;:!?]+$/, "")
  );
}

function assertExternalFreeNewsBotPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("External free news bot payload must be an object.");
  }

  if (Array.isArray(payload.embeds) && payload.embeds.length > 0) {
    throw new Error("External free news bot payloads may not include embeds; publish a processed TradersLink article link instead.");
  }

  const serialized = JSON.stringify(payload);
  const forbidden = EXTERNAL_BOT_FORBIDDEN_PAYLOAD_PATTERNS.find(pattern => pattern.test(serialized));
  if (forbidden) {
    throw new Error("External free news bot payload contains a forbidden upstream/source Discord or source-document reference.");
  }

  if (!extractPayloadUrls(payload).some(isTradersLinkFreeNewsUrl)) {
    throw new Error("External free news bot payload must include a TradersLink /news/free/ article URL.");
  }

  return payload;
}

async function postPayloadToWebhook(webhookUrl, payload) {
  if (REPLAY_SKIP_WEBHOOKS) {
    console.log(`[REPLAY] Skipping webhook post to ${webhookUrl}`);
    return null;
  }

  const url = webhookUrl.includes("?")
    ? `${webhookUrl}&wait=true`
    : `${webhookUrl}?wait=true`;

  let body = "";
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fetchTextWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        },
        DISCORD_TIMEOUT_MS
      );

      body = result.body;
      if (result.response.ok) {
        break;
      }

      if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
        throw new Error(`Discord webhook failed ${result.response.status}: ${body}`);
      }

      const retryAfterMs = getDiscordRetryAfterMs(result.response, body);
      const delay = retryAfterMs > 0 ? retryAfterMs : WEBHOOK_RETRY_BASE_MS * attempt;
      console.warn(
        `[WEBHOOK] Discord post failed ${result.response.status}; retrying in ${Math.round(delay / 1000)}s (${attempt}/${WEBHOOK_MAX_ATTEMPTS})`
      );
      await sleep(delay);
    } catch (err) {
      if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
        throw err;
      }

      const delay = WEBHOOK_RETRY_BASE_MS * attempt;
      console.warn(
        `[WEBHOOK] Discord post error: ${err.message}; retrying in ${Math.round(delay / 1000)}s (${attempt}/${WEBHOOK_MAX_ATTEMPTS})`
      );
      await sleep(delay);
    }
  }

  try {
    const message = body ? JSON.parse(body) : null;
    return {
      webhookUrl,
      messageId: message?.id || null,
      channelId: message?.channel_id || null,
      guildId: message?.guild_id || null,
      type: message?.type ?? null
    };
  } catch (_) {
    return {
      webhookUrl,
      messageId: null,
      channelId: null,
      guildId: null,
      type: null
    };
  }
}

async function postEmbedsToWebhook(webhookUrl, embeds) {
  return postPayloadToWebhook(webhookUrl, { embeds });
}

async function postPayloadToFreeNewsBotTarget(target, payload) {
  if (REPLAY_SKIP_WEBHOOKS) {
    console.log(`[REPLAY] Skipping Discord bot post to channel ${target?.channelId || "unknown"}`);
    return null;
  }

  if (!DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN is required for free news bot delivery.");
  }

  const channelId = String(target?.channelId || "").trim();
  if (!channelId) {
    throw new Error("Free news bot target is missing channelId.");
  }

  const url = buildDiscordBotChannelUrl(channelId);
  assertExternalFreeNewsBotPayload(payload);
  const safePayload = {
    allowed_mentions: { parse: [] },
    ...payload
  };
  let body = "";

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fetchTextWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(safePayload)
        },
        DISCORD_TIMEOUT_MS
      );

      body = result.body;
      if (result.response.ok) {
        break;
      }

      if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
        throw new Error(`Discord bot post failed ${result.response.status}: ${body}`);
      }

      const retryAfterMs = getDiscordRetryAfterMs(result.response, body);
      const delay = retryAfterMs > 0 ? retryAfterMs : WEBHOOK_RETRY_BASE_MS * attempt;
      console.warn(
        `[BOT] Discord post failed ${result.response.status}; retrying in ${Math.round(delay / 1000)}s (${attempt}/${WEBHOOK_MAX_ATTEMPTS})`
      );
      await sleep(delay);
    } catch (err) {
      if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
        throw err;
      }

      const delay = WEBHOOK_RETRY_BASE_MS * attempt;
      console.warn(
        `[BOT] Discord post error: ${err.message}; retrying in ${Math.round(delay / 1000)}s (${attempt}/${WEBHOOK_MAX_ATTEMPTS})`
      );
      await sleep(delay);
    }
  }

  try {
    const message = body ? JSON.parse(body) : null;
    return {
      delivery: "discord_bot",
      freeNewsBot: true,
      guildId: target.guildId || message?.guild_id || null,
      channelId: message?.channel_id || channelId,
      messageId: message?.id || null,
      type: message?.type ?? null
    };
  } catch (_) {
    return {
      delivery: "discord_bot",
      freeNewsBot: true,
      guildId: target.guildId || null,
      channelId,
      messageId: null,
      type: null
    };
  }
}

module.exports = {
  buildDiscordEmbeds,
  getWebhookTargets,
  getFreeNewsBotTargets,
  shouldUseFreeNewsBotTargets,
  postEmbedsToWebhook,
  postPayloadToWebhook,
  postPayloadToFreeNewsBotTarget,
  assertExternalFreeNewsBotPayload,
  isDilutionRelevantOutput
};
