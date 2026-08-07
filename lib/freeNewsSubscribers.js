const fs = require("fs");
const path = require("path");
const {
  DISCORD_FREE_NEWS_SUBSCRIBERS_FILE,
  DISCORD_BOT_APPLICATION_ID,
  DISCORD_BOT_PERMISSIONS
} = require("./config");

function normalizeSnowflake(value, label) {
  const normalized = String(value || "").trim();
  if (!/^\d{5,25}$/.test(normalized)) {
    throw new Error(`${label} must be a Discord numeric id.`);
  }
  return normalized;
}

function normalizeLabel(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizeTier(value) {
  const normalized = String(value || "free").trim().toLowerCase();
  return normalized === "paid" ? "paid" : "free";
}

function emptyStore() {
  return {
    version: 1,
    subscribers: []
  };
}

function readSubscriberStore(filePath = DISCORD_FREE_NEWS_SUBSCRIBERS_FILE) {
  if (!fs.existsSync(filePath)) {
    return emptyStore();
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(parsed)) {
    return {
      version: 1,
      subscribers: parsed
    };
  }

  return {
    version: Number(parsed?.version || 1),
    subscribers: Array.isArray(parsed?.subscribers) ? parsed.subscribers : []
  };
}

function writeSubscriberStore(store, filePath = DISCORD_FREE_NEWS_SUBSCRIBERS_FILE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        subscribers: Array.isArray(store?.subscribers) ? store.subscribers : []
      },
      null,
      2
    )}\n`
  );
}

function normalizeSubscriber(raw) {
  const guildId = normalizeSnowflake(raw?.guildId || raw?.guild_id, "guildId");
  const channelId = normalizeSnowflake(raw?.channelId || raw?.channel_id, "channelId");
  const now = new Date().toISOString();

  return {
    guildId,
    channelId,
    label: normalizeLabel(raw?.label),
    tier: normalizeTier(raw?.tier),
    enabled: raw?.enabled !== false,
    createdAt: raw?.createdAt || now,
    updatedAt: raw?.updatedAt || now
  };
}

function getActiveFreeNewsSubscribers(filePath = DISCORD_FREE_NEWS_SUBSCRIBERS_FILE) {
  const store = readSubscriberStore(filePath);
  const subscribers = [];

  for (const raw of store.subscribers) {
    try {
      const subscriber = normalizeSubscriber(raw);
      if (subscriber.enabled && subscriber.tier === "free") {
        subscribers.push(subscriber);
      }
    } catch (_) {
      // Ignore malformed local entries so one bad row does not stop live posting.
    }
  }

  return subscribers;
}

function getFreeNewsSubscribersForGuild(guildId, filePath = DISCORD_FREE_NEWS_SUBSCRIBERS_FILE) {
  const normalizedGuildId = normalizeSnowflake(guildId, "guildId");
  return getActiveFreeNewsSubscribers(filePath).filter(subscriber => subscriber.guildId === normalizedGuildId);
}

function upsertFreeNewsSubscriber(input, filePath = DISCORD_FREE_NEWS_SUBSCRIBERS_FILE) {
  const store = readSubscriberStore(filePath);
  const now = new Date().toISOString();
  const next = normalizeSubscriber({
    ...input,
    updatedAt: now
  });
  const index = store.subscribers.findIndex(
    item =>
      String(item?.guildId || item?.guild_id || "") === next.guildId &&
      String(item?.channelId || item?.channel_id || "") === next.channelId
  );

  if (index >= 0) {
    next.createdAt = store.subscribers[index].createdAt || next.createdAt;
    store.subscribers[index] = next;
  } else {
    next.createdAt = now;
    store.subscribers.push(next);
  }

  writeSubscriberStore(store, filePath);
  return next;
}

function isFreeSubscriberForGuild(item, guildId) {
  return (
    String(item?.guildId || item?.guild_id || "") === guildId &&
    normalizeTier(item?.tier) === "free"
  );
}

function setFreeNewsSubscriberForGuild(input, filePath = DISCORD_FREE_NEWS_SUBSCRIBERS_FILE) {
  const store = readSubscriberStore(filePath);
  const now = new Date().toISOString();
  const next = normalizeSubscriber({
    ...input,
    tier: "free",
    enabled: true,
    createdAt: now,
    updatedAt: now
  });
  const existing = store.subscribers.find(item => isFreeSubscriberForGuild(item, next.guildId));

  if (existing?.createdAt) {
    next.createdAt = existing.createdAt;
  }

  store.subscribers = store.subscribers.filter(item => !isFreeSubscriberForGuild(item, next.guildId));
  store.subscribers.push(next);
  writeSubscriberStore(store, filePath);
  return next;
}

function removeFreeNewsSubscribersForGuild(guildId, filePath = DISCORD_FREE_NEWS_SUBSCRIBERS_FILE) {
  const store = readSubscriberStore(filePath);
  const normalizedGuildId = normalizeSnowflake(guildId, "guildId");
  const before = store.subscribers.length;
  store.subscribers = store.subscribers.filter(item => !isFreeSubscriberForGuild(item, normalizedGuildId));
  writeSubscriberStore(store, filePath);
  return before - store.subscribers.length;
}

function removeFreeNewsSubscriber({ guildId, channelId }, filePath = DISCORD_FREE_NEWS_SUBSCRIBERS_FILE) {
  const store = readSubscriberStore(filePath);
  const normalizedGuildId = guildId ? normalizeSnowflake(guildId, "guildId") : "";
  const normalizedChannelId = channelId ? normalizeSnowflake(channelId, "channelId") : "";

  if (!normalizedGuildId && !normalizedChannelId) {
    throw new Error("Provide at least --guild-id or --channel-id.");
  }

  const before = store.subscribers.length;
  store.subscribers = store.subscribers.filter(item => {
    const itemGuildId = String(item?.guildId || item?.guild_id || "");
    const itemChannelId = String(item?.channelId || item?.channel_id || "");
    if (normalizedGuildId && itemGuildId !== normalizedGuildId) return true;
    if (normalizedChannelId && itemChannelId !== normalizedChannelId) return true;
    return false;
  });

  writeSubscriberStore(store, filePath);
  return before - store.subscribers.length;
}

function buildDiscordBotInviteUrl({
  applicationId = DISCORD_BOT_APPLICATION_ID,
  permissions = DISCORD_BOT_PERMISSIONS
} = {}) {
  const normalizedApplicationId = normalizeSnowflake(applicationId, "applicationId");
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", normalizedApplicationId);
  url.searchParams.set("permissions", String(permissions || "19456"));
  url.searchParams.set("scope", "bot applications.commands");
  return url.toString();
}

module.exports = {
  readSubscriberStore,
  writeSubscriberStore,
  getActiveFreeNewsSubscribers,
  getFreeNewsSubscribersForGuild,
  upsertFreeNewsSubscriber,
  setFreeNewsSubscriberForGuild,
  removeFreeNewsSubscribersForGuild,
  removeFreeNewsSubscriber,
  buildDiscordBotInviteUrl
};
