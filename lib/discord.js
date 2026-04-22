const {
  DISCORD_WEBHOOK_URL,
  SPIKE_WEBHOOK_URL,
  DROP_WEBHOOK_URL,
  WEBHOOK_OVERRIDE_URL,
  WEBHOOK_OVERRIDE_DILUTION_ONLY,
  DISCORD_TIMEOUT_MS,
  REPLAY_SKIP_WEBHOOKS,
  TICKER_DISPLAY_VARIANT
} = require("./config");
const { fetchTextWithTimeout } = require("./http");
const {
  normalizeEmbedText,
  normalizeCompactMetric,
  clampFieldValue,
  splitTextIntoChunks
} = require("./utils");
const { normalizeSecDocumentUrl } = require("./sec");

function buildSnapshotBlock(ai, metadata) {
  const emphasizeLabel = text =>
    String(text || "").replace(/^([^:]+):\s*/, (_match, label) => `**${label}:** `);

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

function shouldShowDilutionSnapshot(ai) {
  return Boolean(ai?.canDiluteToday || ai?.earliestDilution);
}

function isDilutionRelevantOutput(ai) {
  return shouldShowDilutionSnapshot(ai);
}

function buildSourceField(articleLink, isSecLink) {
  const normalized = String(articleLink || "").trim();
  if (!normalized || /^null$/i.test(normalized)) {
    return null;
  }

  if (!isSecLink) {
    return null;
  }

  return {
    name: "SEC Filing Link",
    value: `[Open SEC Filing](${normalized})`,
    inline: false
  };
}

function buildFormattedLevelsText(levelsText) {
  const cleaned = String(levelsText || "")
    .replace(/\r/g, "")
    .trim();

  if (!cleaned) return "";

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

  const findValue = label => {
    const inlineLine = lines.find(line => new RegExp(`^${label}:\\s+`, "i").test(line));
    if (inlineLine) {
      return inlineLine.replace(new RegExp(`^${label}:\\s+`, "i"), "").replace(/\s+/g, " ").trim();
    }

    const index = lines.findIndex(line => new RegExp(`^${label}$`, "i").test(line));
    if (index === -1) return null;
    const next = lines[index + 1];
    return next ? next.replace(/\s+/g, " ").trim() : null;
  };

  const resistance = findValue("Resistance");
  const support = findValue("Support");
  const dataGenerated = lines.find(line => /^Data generated during /i.test(line)) || null;
  const rendered = [];

  if (resistance) rendered.push(`**Resistance:** ${resistance}`);
  if (support) rendered.push(`**Support:** ${support}`);
  if (dataGenerated) {
    if (rendered.length) rendered.push("");
    rendered.push(dataGenerated);
  }

  return rendered.length ? rendered.join("\n\n") : lines.join("\n");
}

function buildLevelsFields(levelsText) {
  const cleaned = buildFormattedLevelsText(levelsText);
  if (!cleaned) {
    return [];
  }

  const MAX_LEVEL_FIELDS = 20;
  const chunks = splitTextIntoChunks(cleaned, 1024);
  const limitedChunks = chunks.slice(0, MAX_LEVEL_FIELDS);

  const fields = limitedChunks.map((chunk, index) => ({
    name: "\u200B",
    value: chunk,
    inline: false
  }));

  if (chunks.length > MAX_LEVEL_FIELDS) {
    fields.push({
      name: "\u200B",
      value: `Additional levels output was truncated (${chunks.length - MAX_LEVEL_FIELDS} more chunk(s)).`,
      inline: false
    });
  }

  return fields;
}

function buildDiscordEmbeds(ai, metadata, articleLink, levelsText) {
  const MAX_DESC = 4000;
  const MAX_EMBEDS = 10;
  const isSecLink = normalizeSecDocumentUrl(articleLink).includes("sec.gov");
  const sourceField = buildSourceField(articleLink, isSecLink);
  const snapshotLine = buildSnapshotBlock(ai, metadata);
  const firstChunkPrefix = `\u200B\n**${ai.headline}**\n\n${snapshotLine}\n\n`;
  const firstChunkLimit = Math.max(500, MAX_DESC - firstChunkPrefix.length);

  const summaryChunks = splitTextIntoChunks(
    normalizeEmbedText(ai.summary, "No summary available."),
    firstChunkLimit
  ).slice(0, MAX_EMBEDS);

  const positives = Array.isArray(ai.positives) && ai.positives.length
    ? ai.positives.map(p => `- ${p}`).join("\n")
    : "None";

  const negatives = Array.isArray(ai.negatives) && ai.negatives.length
    ? ai.negatives.map(n => `- ${n}`).join("\n")
    : "None";

  const levelFields = buildLevelsFields(levelsText);

  return summaryChunks.map((chunkText, index) => {
    const fields = [];

    if (index === 0) {
      fields.push(
        {
          name: "Positives",
          value: clampFieldValue(positives, 1024),
          inline: false
        },
        {
          name: "Negatives",
          value: clampFieldValue(negatives, 1024),
          inline: false
        },
        ...(ai.isFallback && isSecLink
          ? [
              {
                name: "Read Filing",
                value: clampFieldValue(`[Open SEC Filing](${articleLink})`, 1024),
                inline: false
              }
            ]
          : []),
        ...levelFields,
        ...(sourceField
          ? [
              {
                name: sourceField.name,
                value: clampFieldValue(sourceField.value, 1024),
                inline: false
              }
            ]
          : []),
        {
          name: "\u200B",
          value: "\u200B",
          inline: false
        }
      );
    }

    const embed = {
      title: `$${String(metadata.ticker || "").trim().toUpperCase()}`,
      color: 0x4da3ff,
      description: index === 0 ? `${firstChunkPrefix}${chunkText}\n\u200B` : chunkText,
      fields
    };

    return embed;
  });
}

function getWebhookTargets(routeTag, ai = null) {
  if (WEBHOOK_OVERRIDE_URL) {
    if (WEBHOOK_OVERRIDE_DILUTION_ONLY && !isDilutionRelevantOutput(ai)) {
      return [];
    }

    return [WEBHOOK_OVERRIDE_URL];
  }

  if (routeTag === "drop") {
    return [];
  }

  const targets = [DISCORD_WEBHOOK_URL];

  if (routeTag === "spike" && SPIKE_WEBHOOK_URL) {
    targets.push(SPIKE_WEBHOOK_URL);
  }

  return Array.from(new Set(targets.filter(Boolean)));
}

async function postEmbedsToWebhook(webhookUrl, embeds) {
  if (REPLAY_SKIP_WEBHOOKS) {
    console.log(`[REPLAY] Skipping webhook post to ${webhookUrl}`);
    return null;
  }

  const payload = { embeds };
  const url = webhookUrl.includes("?")
    ? `${webhookUrl}&wait=true`
    : `${webhookUrl}?wait=true`;

  const { response, body } = await fetchTextWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    },
    DISCORD_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Discord webhook failed ${response.status}: ${body}`);
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

module.exports = {
  buildDiscordEmbeds,
  getWebhookTargets,
  postEmbedsToWebhook,
  isDilutionRelevantOutput
};
