const {
  DISCORD_BOT_APPLICATION_ID,
  DISCORD_BOT_TOKEN,
  DISCORD_FREE_NEWS_BOT_ENABLED,
  DISCORD_FREE_NEWS_BOT_SELF_SERVE_ENABLED,
  DISCORD_FREE_NEWS_SUBSCRIBERS_FILE
} = require("./lib/config");
const {
  readSubscriberStore,
  getActiveFreeNewsSubscribers,
  upsertFreeNewsSubscriber,
  removeFreeNewsSubscriber,
  buildDiscordBotInviteUrl
} = require("./lib/freeNewsSubscribers");
const { postPayloadToFreeNewsBotTarget } = require("./lib/discord");
const {
  registerFreeNewsBotCommands,
  startFreeNewsBotGateway
} = require("./lib/discordFreeNewsBotGateway");

function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }

  return args;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node free_news_discord_bot.js invite",
      "  node free_news_discord_bot.js sync-commands",
      "  node free_news_discord_bot.js serve",
      "  node free_news_discord_bot.js register --guild-id <id> --channel-id <id> [--label <name>]",
      "  node free_news_discord_bot.js test-post --channel-id <id> [--guild-id <id>] [--article-url <free-url>]",
      "  node free_news_discord_bot.js remove [--guild-id <id>] [--channel-id <id>]",
      "  node free_news_discord_bot.js list",
      "  node free_news_discord_bot.js status"
    ].join("\n")
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "status";

  if (command === "invite") {
    console.log(buildDiscordBotInviteUrl({ applicationId: args.clientId || DISCORD_BOT_APPLICATION_ID }));
    return;
  }

  if (command === "sync-commands") {
    registerFreeNewsBotCommands()
      .then(commands => {
        console.log(JSON.stringify({ ok: true, commands }, null, 2));
      })
      .catch(err => {
        console.error(err.message);
        process.exitCode = 1;
      });
    return;
  }

  if (command === "serve") {
    startFreeNewsBotGateway({ enabled: true });
    return;
  }

  if (command === "register") {
    const subscriber = upsertFreeNewsSubscriber({
      guildId: args.guildId,
      channelId: args.channelId,
      label: args.label
    });
    console.log(JSON.stringify({ ok: true, subscriber }, null, 2));
    return;
  }

  if (command === "test-post") {
    const articleUrl =
      args.articleUrl ||
      "https://app.traderslink.pro/news/free/TEST/free-news-bot-permission-test";
    const payload = {
      content: [
        "**$TEST**",
        "**TradersLink free news bot permission test**",
        `<${articleUrl}>`
      ].join("\n"),
      allowed_mentions: { parse: [] }
    };

    postPayloadToFreeNewsBotTarget(
      {
        guildId: args.guildId,
        channelId: args.channelId
      },
      payload
    )
      .then(result => {
        console.log(JSON.stringify({ ok: true, result }, null, 2));
      })
      .catch(err => {
        console.error(err.message);
        process.exitCode = 1;
      });
    return;
  }

  if (command === "remove") {
    const removed = removeFreeNewsSubscriber({
      guildId: args.guildId,
      channelId: args.channelId
    });
    console.log(JSON.stringify({ ok: true, removed }, null, 2));
    return;
  }

  if (command === "list") {
    console.log(JSON.stringify(readSubscriberStore(), null, 2));
    return;
  }

  if (command === "status") {
    console.log(
      JSON.stringify(
        {
          enabled: DISCORD_FREE_NEWS_BOT_ENABLED,
          selfServeEnabled: DISCORD_FREE_NEWS_BOT_SELF_SERVE_ENABLED,
          tokenConfigured: Boolean(DISCORD_BOT_TOKEN),
          applicationIdConfigured: Boolean(DISCORD_BOT_APPLICATION_ID),
          subscribersFile: DISCORD_FREE_NEWS_SUBSCRIBERS_FILE,
          activeSubscribers: getActiveFreeNewsSubscribers().length
        },
        null,
        2
      )
    );
    return;
  }

  printUsage();
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
