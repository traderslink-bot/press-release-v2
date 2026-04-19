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

function formatTickerDisplay(ticker) {
  const safeTicker = String(ticker || "N/A").trim().toUpperCase();

  switch (TICKER_DISPLAY_VARIANT) {
    case "standalone_dollar":
      return `**$${safeTicker}**`;
    case "label_bold":
      return `**Ticker:** **${safeTicker}**`;
    case "standalone_bold":
      return `**${safeTicker}**`;
    case "standalone_code":
      return `\`${safeTicker}\``;
    case "label_code":
    default:
      return `**Ticker:** \`${safeTicker}\``;
  }
}

function buildSnapshotBlock(ai, metadata) {
  const tickerLine = formatTickerDisplay(metadata.ticker);
  const detailParts = [
    `Float: ${normalizeCompactMetric(metadata.float)}`,
    `MC: ${normalizeCompactMetric(metadata.marketCap)}`
  ];

  if (ai.filingType) {
    detailParts.push(`Filing: ${ai.filingType}`);
  }

  const lines = [`${tickerLine}`, detailParts.join(" | ")];

  if (shouldShowDilutionSnapshot(ai)) {
    if (ai.canDiluteToday) {
      lines.push(ai.canDiluteToday);
    }

    if (ai.earliestDilution) {
      lines.push(ai.earliestDilution);
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

function buildLevelsFields(levelsText) {
  const cleaned = String(levelsText || "").trim();
  if (!cleaned) {
    return [
      {
        name: "Levels",
        value: "Levels unavailable.",
        inline: false
      }
    ];
  }

  const MAX_LEVEL_FIELDS = 20;
  const chunks = splitTextIntoChunks(cleaned, 1024);
  const limitedChunks = chunks.slice(0, MAX_LEVEL_FIELDS);

  const fields = limitedChunks.map((chunk, index) => ({
    name: index === 0 ? "Levels" : `Levels ${index + 1}`,
    value: chunk,
    inline: false
  }));

  if (chunks.length > MAX_LEVEL_FIELDS) {
    fields.push({
      name: "Levels Note",
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
  const sourceFieldName = isSecLink ? "SEC Filing Link" : "Source Article";
  const sourceFieldValue = isSecLink
    ? `[Open SEC Filing](${articleLink})`
    : articleLink;
  const snapshotLine = buildSnapshotBlock(ai, metadata);
  const summaryHeading = "**Summary:**";
  const firstChunkPrefix = `\n${snapshotLine}\n\n${summaryHeading}\n`;
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
        {
          name: "Signal Details",
          value: clampFieldValue(
            `IO: ${metadata.io || "N/A"}\n` +
              `Route: ${metadata.routeTag || "default"}\n` +
              `Event Type: ${ai.eventType || "N/A"}\n` +
              `Confidence: ${Number.isFinite(ai.confidence) ? ai.confidence : 0}`,
            1024
          ),
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
        {
          name: sourceFieldName,
          value: clampFieldValue(sourceFieldValue, 1024),
          inline: false
        }
      );
    }

    return {
      title: ai.headline,
      url: articleLink,
      color: 0x4da3ff,
      description: index === 0 ? `${firstChunkPrefix}${chunkText}` : chunkText,
      fields,
      footer: {
        text: `TradersLink AI News | Part ${index + 1} of ${summaryChunks.length}`
      }
    };
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
    return;
  }

  const payload = { embeds };

  const { response, body: errorText } = await fetchTextWithTimeout(
    webhookUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    },
    DISCORD_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Discord webhook failed ${response.status}: ${errorText}`);
  }
}

module.exports = {
  buildDiscordEmbeds,
  getWebhookTargets,
  postEmbedsToWebhook,
  isDilutionRelevantOutput
};
