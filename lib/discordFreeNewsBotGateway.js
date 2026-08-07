const {
  DISCORD_BOT_APPLICATION_ID,
  DISCORD_BOT_TOKEN,
  DISCORD_BOT_API_BASE_URL,
  DISCORD_FREE_NEWS_BOT_ENABLED,
  DISCORD_FREE_NEWS_BOT_SELF_SERVE_ENABLED,
  DISCORD_FREE_NEWS_BOT_SETUP_TEST_URL,
  DISCORD_TIMEOUT_MS
} = require("./config");
const { fetchTextWithTimeout } = require("./http");
const {
  getFreeNewsSubscribersForGuild,
  setFreeNewsSubscriberForGuild,
  removeFreeNewsSubscribersForGuild
} = require("./freeNewsSubscribers");
const { postPayloadToFreeNewsBotTarget } = require("./discord");

const DISCORD_PERMISSION_ADMINISTRATOR = 0x8n;
const DISCORD_PERMISSION_MANAGE_GUILD = 0x20n;
const INTERACTION_RESPONSE_CHANNEL_MESSAGE = 4;
const INTERACTION_RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;
const EPHEMERAL_MESSAGE_FLAG = 64;
const GATEWAY_RECONNECT_BASE_MS = 3000;
const GATEWAY_RECONNECT_MAX_MS = 30000;

const FREE_NEWS_BOT_COMMANDS = [
  {
    name: "tl-news-setup",
    description: "Send TradersLink free news posts to one channel.",
    type: 1,
    dm_permission: false,
    default_member_permissions: String(DISCORD_PERMISSION_MANAGE_GUILD),
    options: [
      {
        name: "channel",
        description: "Channel that should receive the free TradersLink news feed.",
        type: 7,
        required: true,
        channel_types: [0, 5]
      }
    ]
  },
  {
    name: "tl-news-status",
    description: "Show where this server receives the TradersLink free news feed.",
    type: 1,
    dm_permission: false,
    default_member_permissions: String(DISCORD_PERMISSION_MANAGE_GUILD)
  },
  {
    name: "tl-news-remove",
    description: "Remove this server from the TradersLink free news feed.",
    type: 1,
    dm_permission: false,
    default_member_permissions: String(DISCORD_PERMISSION_MANAGE_GUILD)
  }
];

function buildDiscordApiUrl(path) {
  const apiBase = String(DISCORD_BOT_API_BASE_URL || "https://discord.com/api/v10").replace(/\/+$/, "");
  return `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

async function discordBotApiRequest(method, path, body = null) {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN is required for Discord bot API requests.");
  }

  const result = await fetchTextWithTimeout(
    buildDiscordApiUrl(path),
    {
      method,
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: body === null ? undefined : JSON.stringify(body)
    },
    DISCORD_TIMEOUT_MS
  );

  if (!result.response.ok) {
    throw new Error(`Discord API ${method} ${path} failed ${result.response.status}: ${result.body}`);
  }

  return result.body ? JSON.parse(result.body) : null;
}

async function registerFreeNewsBotCommands() {
  if (!DISCORD_BOT_APPLICATION_ID) {
    throw new Error("DISCORD_BOT_APPLICATION_ID is required to register free news bot commands.");
  }

  return discordBotApiRequest(
    "PUT",
    `/applications/${encodeURIComponent(DISCORD_BOT_APPLICATION_ID)}/commands`,
    FREE_NEWS_BOT_COMMANDS
  );
}

function parsePermissionBits(value) {
  try {
    return BigInt(String(value || "0"));
  } catch (_) {
    return 0n;
  }
}

function canManageFreeNewsBot(interaction) {
  const permissions = parsePermissionBits(interaction?.member?.permissions);
  return (
    (permissions & DISCORD_PERMISSION_ADMINISTRATOR) === DISCORD_PERMISSION_ADMINISTRATOR ||
    (permissions & DISCORD_PERMISSION_MANAGE_GUILD) === DISCORD_PERMISSION_MANAGE_GUILD
  );
}

function findInteractionOption(interaction, name) {
  return (interaction?.data?.options || []).find(option => option?.name === name) || null;
}

function buildEphemeralMessage(content) {
  return {
    content,
    flags: EPHEMERAL_MESSAGE_FLAG,
    allowed_mentions: { parse: [] }
  };
}

function getSetupFailureMessage(error) {
  const message = String(error?.message || error || "");

  if (/missing access|unknown channel|missing permissions|cannot send messages/i.test(message)) {
    return "Setup failed because the bot cannot post in that channel. Please make sure it can view the channel and send messages, then run `/tl-news-setup` again.";
  }

  if (/DISCORD_BOT_TOKEN|Discord API|Discord bot post failed|fetch failed|aborted|network/i.test(message)) {
    return "Setup failed because the bot could not reach Discord. Please try again in a minute.";
  }

  return "Setup failed. Please try again in a minute.";
}

async function respondToInteraction(interaction, content) {
  await discordBotApiRequest(
    "POST",
    `/interactions/${encodeURIComponent(interaction.id)}/${encodeURIComponent(interaction.token)}/callback`,
    {
      type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: buildEphemeralMessage(content)
    }
  );
}

async function deferInteraction(interaction) {
  await discordBotApiRequest(
    "POST",
    `/interactions/${encodeURIComponent(interaction.id)}/${encodeURIComponent(interaction.token)}/callback`,
    {
      type: INTERACTION_RESPONSE_DEFERRED_CHANNEL_MESSAGE,
      data: { flags: EPHEMERAL_MESSAGE_FLAG }
    }
  );
}

async function editDeferredInteraction(interaction, content) {
  const applicationId = interaction.application_id || DISCORD_BOT_APPLICATION_ID;
  await discordBotApiRequest(
    "PATCH",
    `/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interaction.token)}/messages/@original`,
    buildEphemeralMessage(content)
  );
}

function buildSetupTestPayload() {
  return {
    content: [
      "**TradersLink free news feed connected**",
      "This channel will receive free news posts from TradersLink.",
      `<${DISCORD_FREE_NEWS_BOT_SETUP_TEST_URL}>`
    ].join("\n"),
    allowed_mentions: { parse: [] }
  };
}

async function handleSetupCommand(interaction) {
  await deferInteraction(interaction);
  const channelId = String(findInteractionOption(interaction, "channel")?.value || "").trim();
  if (!channelId) {
    await editDeferredInteraction(interaction, "Choose a channel for the free TradersLink news feed.");
    return;
  }

  await postPayloadToFreeNewsBotTarget(
    {
      guildId: interaction.guild_id,
      channelId
    },
    buildSetupTestPayload()
  );

  const subscriber = setFreeNewsSubscriberForGuild({
    guildId: interaction.guild_id,
    channelId,
    label: interaction.guild_id
  });

  await editDeferredInteraction(
    interaction,
    `Connected. Free TradersLink news posts will go to <#${subscriber.channelId}>. Running setup again will move this server's free feed to the new channel.`
  );
}

async function handleStatusCommand(interaction) {
  const subscribers = getFreeNewsSubscribersForGuild(interaction.guild_id);
  if (!subscribers.length) {
    await respondToInteraction(
      interaction,
      "This server is not connected yet. Run `/tl-news-setup` and choose one channel."
    );
    return;
  }

  const channels = subscribers.map(subscriber => `<#${subscriber.channelId}>`).join(", ");
  await respondToInteraction(interaction, `This server's free TradersLink news feed is connected to ${channels}.`);
}

async function handleRemoveCommand(interaction) {
  const removed = removeFreeNewsSubscribersForGuild(interaction.guild_id);
  await respondToInteraction(
    interaction,
    removed > 0
      ? "Removed this server from the free TradersLink news feed."
      : "This server was not connected to the free TradersLink news feed."
  );
}

async function handleFreeNewsBotInteraction(interaction) {
  if (interaction?.type !== 2 || !interaction?.data?.name) return false;

  const commandName = interaction.data.name;
  if (!FREE_NEWS_BOT_COMMANDS.some(command => command.name === commandName)) {
    return false;
  }

  try {
    if (!interaction.guild_id) {
      await respondToInteraction(interaction, "This command only works inside a Discord server.");
      return true;
    }

    if (!canManageFreeNewsBot(interaction)) {
      await respondToInteraction(interaction, "Only server admins or members with Manage Server can set up this feed.");
      return true;
    }

    if (commandName === "tl-news-setup") {
      await handleSetupCommand(interaction);
      return true;
    }

    if (commandName === "tl-news-status") {
      await handleStatusCommand(interaction);
      return true;
    }

    if (commandName === "tl-news-remove") {
      await handleRemoveCommand(interaction);
      return true;
    }
  } catch (err) {
    console.error(`[FREEBOT] ${commandName} failed: ${err.message}`);
    const safeMessage = getSetupFailureMessage(err);
    try {
      await respondToInteraction(interaction, safeMessage);
    } catch (_) {
      try {
        await editDeferredInteraction(interaction, safeMessage);
      } catch (editErr) {
        console.error(`[FREEBOT] Failed to report command error: ${editErr.message}`);
      }
    }
    return true;
  }

  return false;
}

async function getGatewayBotUrl() {
  const gateway = await discordBotApiRequest("GET", "/gateway/bot");
  if (!gateway?.url) {
    throw new Error("Discord did not return a Gateway URL.");
  }
  return gateway.url;
}

function sendGatewayJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function startFreeNewsBotGateway(options = {}) {
  const enabled = options.enabled ?? (DISCORD_FREE_NEWS_BOT_ENABLED && DISCORD_FREE_NEWS_BOT_SELF_SERVE_ENABLED);
  if (!enabled) {
    console.log("[FREEBOT] Self-serve setup listener disabled.");
    return { stop() {} };
  }

  if (!DISCORD_BOT_TOKEN || !DISCORD_BOT_APPLICATION_ID) {
    console.warn("[FREEBOT] Self-serve setup listener disabled; set DISCORD_BOT_TOKEN and DISCORD_BOT_APPLICATION_ID.");
    return { stop() {} };
  }

  let stopped = false;
  let ws = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let lastSequence = null;
  let reconnectAttempt = 0;

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const scheduleReconnect = reason => {
    if (stopped) return;
    reconnectAttempt += 1;
    const delayMs = Math.min(GATEWAY_RECONNECT_MAX_MS, GATEWAY_RECONNECT_BASE_MS * reconnectAttempt);
    console.warn(`[FREEBOT] Gateway ${reason}; reconnecting in ${Math.round(delayMs / 1000)}s.`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(err => {
        console.error(`[FREEBOT] Gateway reconnect failed: ${err.message}`);
        scheduleReconnect("reconnect failed");
      });
    }, delayMs);
  };

  const connect = async () => {
    if (stopped) return;
    const gatewayUrl = await getGatewayBotUrl();
    ws = new WebSocket(`${gatewayUrl}?v=10&encoding=json`);

    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      console.log("[FREEBOT] Connected to Discord Gateway for self-serve setup commands.");
    });

    ws.addEventListener("message", event => {
      let packet = null;
      try {
        packet = JSON.parse(String(event.data || ""));
      } catch (_) {
        return;
      }

      if (packet.s !== null && packet.s !== undefined) {
        lastSequence = packet.s;
      }

      if (packet.op === 10) {
        clearHeartbeat();
        const intervalMs = Number(packet.d?.heartbeat_interval || 45000);
        heartbeatTimer = setInterval(() => {
          sendGatewayJson(ws, { op: 1, d: lastSequence });
        }, intervalMs);
        sendGatewayJson(ws, {
          op: 2,
          d: {
            token: DISCORD_BOT_TOKEN,
            intents: 1,
            properties: {
              os: process.platform,
              browser: "traderslink-free-news-bot",
              device: "traderslink-free-news-bot"
            }
          }
        });
        return;
      }

      if (packet.op === 1) {
        sendGatewayJson(ws, { op: 1, d: lastSequence });
        return;
      }

      if (packet.op === 7) {
        ws.close(4000, "Discord requested reconnect");
        return;
      }

      if (packet.op === 0 && packet.t === "READY") {
        console.log(`[FREEBOT] Ready as ${packet.d?.user?.username || "Discord bot"}.`);
        return;
      }

      if (packet.op === 0 && packet.t === "INTERACTION_CREATE") {
        void handleFreeNewsBotInteraction(packet.d);
      }
    });

    ws.addEventListener("close", () => {
      clearHeartbeat();
      scheduleReconnect("disconnected");
    });

    ws.addEventListener("error", event => {
      console.error(`[FREEBOT] Gateway error: ${event?.message || "unknown error"}`);
    });
  };

  connect().catch(err => {
    console.error(`[FREEBOT] Gateway start failed: ${err.message}`);
    scheduleReconnect("start failed");
  });

  return {
    stop() {
      stopped = true;
      clearHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "stopped");
      }
    }
  };
}

module.exports = {
  FREE_NEWS_BOT_COMMANDS,
  registerFreeNewsBotCommands,
  handleFreeNewsBotInteraction,
  getSetupFailureMessage,
  startFreeNewsBotGateway
};
