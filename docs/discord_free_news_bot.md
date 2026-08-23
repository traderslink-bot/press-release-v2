# Discord Free News Bot

This is the installable free-tier Discord delivery path for external server admins.

The bot is intentionally limited to the free news dump stream. By default it receives the current press-release/news route tags in one channel, and it is disabled unless `DISCORD_FREE_NEWS_BOT_ENABLED=true` and `DISCORD_BOT_TOKEN` are configured.

The external bot is a delivery adapter, not a Discord mirror. It never reads from the host Discord channels and should never receive host channel URLs, webhook URLs, `news.nuntiobot.com` links, SEC/source URLs, or legacy embeds. It only receives a processed minimal payload that links to a `https://app.traderslink.pro/news/free/...` article page.

It does not post scanner second-server posts, `drop` posts, webhook-override/test posts, or fallback source-link posts. Paid installs can still use filtered destination channels and full article pages.

## Self-Serve Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Put the application id and bot token into `.env.press_release_v2`:

```powershell
DISCORD_FREE_NEWS_BOT_ENABLED="true"
DISCORD_FREE_NEWS_BOT_SELF_SERVE_ENABLED="true"
DISCORD_BOT_APPLICATION_ID="your-application-id"
DISCORD_BOT_TOKEN="your-bot-token"
DISCORD_FREE_NEWS_BOT_ROUTE_TAGS="default,market_cap_under_30m,market_cap_30m_to_50m,market_cap_50m_to_100m"
```

3. Register the slash commands:

```powershell
node .\free_news_discord_bot.js sync-commands
```

4. Generate the invite URL:

```powershell
node .\free_news_discord_bot.js invite
```

The invite includes `bot` and `applications.commands` scopes. The default permission value is `19456`, which requests View Channel, Send Messages, and Embed Links.

5. Send that invite URL to the server admin.
6. After the bot is installed, the server admin runs this inside their Discord server:

```text
/tl-news-setup channel:#news
```

Only admins or members with Manage Server can run the setup commands. The setup command sends a small permission-test message to the selected channel, then stores that server/channel in `data/free_news_discord_subscribers.json`.

If the admin runs `/tl-news-setup` again, the free feed moves to the newly selected channel. Each external server gets one free dump channel.

Admins can check or remove the connection:

```text
/tl-news-status
/tl-news-remove
```

The main runner starts the self-serve listener automatically when `DISCORD_FREE_NEWS_BOT_ENABLED=true`, `DISCORD_FREE_NEWS_BOT_SELF_SERVE_ENABLED=true`, `DISCORD_BOT_APPLICATION_ID`, and `DISCORD_BOT_TOKEN` are configured.

You can also run only the setup listener for testing:

```powershell
node .\free_news_discord_bot.js serve
```

## Manual Operations

Manual registration is still available as an operator fallback:

```powershell
node .\free_news_discord_bot.js register --guild-id 123456789012345678 --channel-id 234567890123456789 --label "Example Server"
```

Send a one-time permission test to that channel:

```powershell
node .\free_news_discord_bot.js test-post --guild-id 123456789012345678 --channel-id 234567890123456789 --article-url "https://app.traderslink.pro/news/free/NNOX/example-article"
```

The registry is stored locally at `data/free_news_discord_subscribers.json` unless `DISCORD_FREE_NEWS_SUBSCRIBERS_FILE` points somewhere else.

## Operations

List registered free subscribers:

```powershell
node .\free_news_discord_bot.js list
```

Check whether the bot path is enabled and configured:

```powershell
node .\free_news_discord_bot.js status
```

Send a permission test:

```powershell
node .\free_news_discord_bot.js test-post --channel-id 234567890123456789 --article-url "https://app.traderslink.pro/news/free/NNOX/example-article"
```

Remove a subscriber:

```powershell
node .\free_news_discord_bot.js remove --guild-id 123456789012345678 --channel-id 234567890123456789
```

## Paid Upgrade Boundary

Keep the free bot pointed at one dump channel. Paid server-owner installs can use the filtered route channels and full article pages.

Do not add scanner routes or paid-only channel routes to the free bot route list.

## Privacy Boundary

External server admins can see the bot identity, bot permissions, the target channel, and the posted message content. They should not be able to infer your host Discord server, host channels, private webhooks, or source-fetching workflow from the bot.

The runtime enforces this by rejecting external free-bot payloads that contain:

- Discord channel URLs
- Discord webhook URLs
- `news.nuntiobot.com` source links
- SEC/source-document links
- Discord embeds
- Any payload without a `traderslink.pro/news/free/` article URL

If website article publishing is unavailable, the external free bot skips delivery instead of posting source links or legacy embeds.
