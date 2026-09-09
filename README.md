# TraderLink Press Release V2

Standalone `v2` workspace for TraderLink's press release and SEC-filing analysis pipeline.

The current live priority is simple and trader-focused:

- detect offerings, private placements, and related financing PRs
- determine whether dilution can happen now
- if not, determine the earliest clear date or trigger
- post the result into the appropriate Discord channels quickly

## Current Focus

`v2` is not trying to be a perfect general news summarizer.

Right now it is optimized around:

- bullish small-cap press releases with market reaction
- PR financing/offering posts
- SEC dilution timing for the cases that matter most
- Discord delivery for eligible press-release and SEC posts

Current live rule:

- `PR DROP` posts are suppressed from Discord and do not fetch article text

## What It Does

- watches the host Discord channel
- extracts ticker, route tag, and article link
- fetches article text when allowed
- routes financing-related PRs into a dedicated AI prompt path
- produces a trader-facing dilution timing snapshot such as:
  - `Dilution status: Immediate`
  - `Dilution status: Delayed`
  - `Dilution status: Undetermined`
- publishes website news articles before Discord when `NEWS_ARTICLE_API_URL` is configured
- posts either the minimal website-link alert or the legacy embed result to the configured Discord webhooks
- restarts the live Discord watcher automatically if the page/session dies

## Lightweight runtime watchdog

`runtime_health_watchdog.js` checks the shared runner, Discord login, and the
press-release, market-cap, and scanner host-channel watchers without launching
another browser. It also detects a visible host message that was not detected,
and message processing that remains stuck beyond the configured limit.

Register the two-minute Windows task with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\register_runtime_health_watchdog.ps1
```

The task runs every two minutes only on weekdays from 3:55 a.m. through
8:00 p.m. Eastern, matching the Discord app schedule. It uses a hidden launcher
so no terminal window appears during each check, and it does not run on
Saturday or Sunday.

Alerts are deduplicated and fire on the first failed check by default. A missed
visible host message also requests one graceful shared-runner restart so the
two-hour startup backfill can recover it. The incident remains open until the
same Discord message ID reaches the processed state. Recovery is reported once. SQLite
message IDs keep already-processed posts from being duplicated. If Discord cannot receive the alert, the incident is retained in
`levels/shared_levels_health_incidents.jsonl` and notification is retried. Set
`APP_HEALTH_WEBHOOK_URL` to a dedicated private status-channel webhook. The
monitor does not use any existing news or scanner webhook by default. For a
free non-Discord backup, set `APP_HEALTH_TELEGRAM_BOT_TOKEN` and
`APP_HEALTH_TELEGRAM_CHAT_ID`; alerts and recoveries will then be sent to both
the dedicated Discord status channel and the Telegram chat.

## Project Layout

- [press_release_levels_v2.js](./press_release_levels_v2.js)
  Entry point.
- [lib](./lib)
  Runtime logic.
- [docs](./docs)
  Handoffs, notes, replay inputs, and testing artifacts.

Most important logic files:

- [lib/pressReleaseFinancing.js](./lib/pressReleaseFinancing.js)
  PR financing detection and normalization rules.
- [lib/prompts.js](./lib/prompts.js)
  Prompt-family selection and prompt text.
- [lib/ai.js](./lib/ai.js)
  AI orchestration and output stabilization.
- [lib/pipeline.js](./lib/pipeline.js)
  Main runtime flow per post.
- [lib/liveBot.js](./lib/liveBot.js)
  Host Discord intake logic.
- [lib/sec.js](./lib/sec.js)
  Shared article fetching and SEC text handling.

## Setup

1. Copy [`.env.press_release_v2.example`](./.env.press_release_v2.example) to `.env.press_release_v2`.
2. Fill in your real local values in `.env.press_release_v2`.
3. Run from this folder or from the workspace root.

Example:

```powershell
cd C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2
node .\press_release_levels_v2.js
```

Quick smoke test:

```powershell
node .\smoke_test_v2.js
```

Shared live runner:

```powershell
cd C:\Users\jerac\Documents\TraderLink\playwright\levels
.\run-scaner-pr-bots-with-levels.bat
```

Market-cap feed setup:

- `NEWS_FILTERED_SECOND_WEBHOOK_URL` optionally mirrors News Filtered posts to a second Discord server.
- `DISCORD_FREE_NEWS_BOT_ENABLED=true` enables the installable free News Filtered bot for external Discord servers. This bot is a processed-payload delivery adapter; it does not read or mirror host Discord channels.
- `DISCORD_FREE_NEWS_BOT_SELF_SERVE_ENABLED=true` lets server admins connect their own free dump channel with `/tl-news-setup`; run `node .\free_news_discord_bot.js sync-commands` after creating the Discord application commands.
- `DISCORD_BOT_APPLICATION_ID` and `DISCORD_BOT_TOKEN` configure the Discord application that other admins install.
- `DISCORD_FREE_NEWS_BOT_ROUTE_TAGS` defaults to the current PR/news routes so free installs receive one dump channel; keep scanner and paid-only route tags out of this list. External bot posts require a `traderslink.pro/news/free/` article URL and will not fall back to host/source links.
- `DISCORD_FREE_NEWS_SUBSCRIBERS_FILE` optionally overrides the local subscriber registry path. See [docs/discord_free_news_bot.md](./docs/discord_free_news_bot.md).
- `node .\free_news_discord_bot.js test-post --channel-id <id> --article-url <free-url>` sends a one-time permission test through the installed bot.
- `MARKET_CAP_HOST_CHANNEL_URL` is the second host Discord channel.
- `MARKET_CAP_UNDER_30M_WEBHOOK_URL` is the destination webhook for the new `$30M and under` channel.
- `NEWS_UNDER_30M_MC_SECOND_WEBHOOK_URL` optionally mirrors `$30M and under` posts to a second Discord server.
- `MARKET_CAP_UNDER_30M_LIMIT` defaults to `30000000`.
- `MARKET_CAP_30M_TO_50M_WEBHOOK_URL` is the destination webhook for the `above $30M through $50M` channel.
- `NEWS_UNDER_50M_MC_SECOND_WEBHOOK_URL` optionally mirrors `above $30M through $50M` posts to a second Discord server.
- `MARKET_CAP_30M_TO_50M_MIN` defaults to `30000000`; matching is exclusive, so exactly `$30M` stays in the under-30M channel.
- `MARKET_CAP_30M_TO_50M_LIMIT` defaults to `50000000`; matching is inclusive, so exactly `$50M` goes to this channel.
- `MARKET_CAP_50M_TO_100M_WEBHOOK_URL` is the destination webhook for the `above $50M through $100M` channel.
- `NEWS_UNDER_100M_MC_SECOND_WEBHOOK_URL` optionally mirrors `above $50M through $100M` posts to a second Discord server.
- `MARKET_CAP_50M_TO_100M_MIN` defaults to `50000000`; matching is exclusive, so exactly `$50M` stays in the 30M-to-50M channel.
- `MARKET_CAP_50M_TO_100M_LIMIT` defaults to `100000000`; matching is inclusive, so exactly `$100M` goes to this channel.
- This feed is intentionally unfiltered by the News Filtered opportunity gate; its first routing gate is market cap only.
- The watcher stays disabled until at least one market-cap destination webhook is filled in.
- Website-link Discord posts require `NEWS_ARTICLE_API_URL` and `NEWS_PUBLISH_TOKEN`; without them the bot falls back to the legacy Discord embed path.
- `DELAYED_NEWS_DUMP_WEBHOOK_URL` optionally sends every successful non-scanner news post, including market-cap channels and news-filtered posts, to one extra Discord dump channel after `DELAYED_NEWS_DUMP_DELAY_MS` (default `90000`). The older `DELAYED_MARKET_CAP_DUMP_*` env names still work as aliases.
- `DELAYED_SCANNER_SECOND_WEBHOOK_URL` optionally sends scanner posts to one extra second-server channel after `DELAYED_SCANNER_SECOND_DELAY_MS` (default `300000`).

Website publish setup:

- `NEWS_ARTICLE_API_URL` should point to `https://app.traderslink.pro/api/news/articles` for production.
- `NEWS_PUBLISH_TOKEN` must match Railway's production `NEWS_PUBLISH_TOKEN`.
- `NEWS_PUBLISH_TOKEN` is a publish-endpoint shared secret, not a Vercel account token.
- Keep the token out of source control and do not print it in logs.
- Successful website publishes are tracked locally from the deployment of this feature onward; there is no historical backfill.

Buffer/X autopost setup:

```powershell
node .\buffer_channels.js
```

- `BUFFER_AUTOPOST_ENABLED=true` enables Buffer posting only for the default News Filtered route after Discord posting succeeds.
- `BUFFER_API_KEY` is the Buffer API key from Buffer Settings > API.
- `BUFFER_X_CHANNEL_ID` is the connected X/Twitter channel ID returned by `buffer_channels.js`.
- `BUFFER_SHARE_MODE=shareNow` publishes immediately through Buffer.
- `BUFFER_POST_FOOTER` defaults to `Delayed here. Full AI summary + instant support/resistance in Discord.`
- Webhook override mode disables Buffer autopost so replay/test Discord posts do not leak to X.

Recent website article lookup for local watchlist apps:

```powershell
node .\website_article_lookup.js --ticker AAPL --json
```

- The lookup returns TradersLink website article links and titles for the requested ticker.
- Use `articles[].url` as the only link field; source/host URLs such as `news.nuntiobot.com` or `sec.gov` are intentionally not returned.
- The default window is the last 5 business days, skipping Saturday and Sunday.
- Optional flags: `--business-days 5`, `--limit 10`.

Review queue tools:

```powershell
node .\review_queue_viewer.js
node .\review_queue_summary.js
```

Daily ingest audit:

```powershell
node .\daily_ingest_audit.js --since 2026-05-07
```

Weak-post rerun helper:

```powershell
node .\ingest_weak_rerun.js --reason headline_only --since 2026-05-07
node .\ingest_weak_rerun.js --reason weak_sec_wrapper --since 2026-05-07 --apply --update-db
```

## Environment Files

Tracked template:

- [`.env.press_release_v2.example`](./.env.press_release_v2.example)

Ignored local runtime file:

- `.env.press_release_v2`

The config prefers `.env.press_release_v2` before the example file, so local secrets stay out of git.

## Notes

- Replay artifacts are ignored under `docs/replay_results/`.
- Local cache output is ignored under `cache/`.
- Live ingest data is stored in SQLite under `data/press_release_ingest.sqlite` by default.
- Processed events now retain SEC document-selection diagnostics and low-signal PR diagnostics for later review.
- Processed events also retain latency metrics like queue delay, fetch time, AI time, levels time, post time, and total runtime.
- Positives and negatives are sanitized more aggressively to trim weak boilerplate like conference-visibility bullets, placement-agent bullets, and generic source-skepticism bullets.
- Nuntio throttling and live fetch prioritization are part of the current operational design.
- The current storage plan is: save PR/SEC events immediately now, then enrich later with market-reaction data such as IBKR bars/outcomes.
- Non-SEC bottom links are suppressed in the live Discord post. Only SEC filing links are shown.
- The live `v2` formatter now suppresses the old `Signal Details` block.
- When article fetch falls back to headline-only or OpenAI URL fallback for non-SEC posts, the live Discord output now suppresses disclosure phrases like:
  - `Article text unavailable; summary based on raw Discord metadata.`
  - `Full article text unavailable ...`
- Non-SEC unreadable fallback posts include an article link field so users can open the original source.
- OpenAI URL fallback uses its own retry cap (`OPENAI_URL_FALLBACK_MAX_RETRIES`) so BusinessWire misses do not burn the full normal-analysis retry budget.
- `v2` now has a deferred retry path for retryable OpenAI failures and a supervisor loop for the live Discord bot.
- The live Discord watcher now sends a heartbeat, rescans visible host-channel messages periodically, and warns when no host messages have been detected for unusually long periods.

## Key Docs

- [docs/pr_dilution_timing_status.md](./docs/pr_dilution_timing_status.md)
  Current PR dilution timing goal and status.
- [docs/pr_financing_handoff.md](./docs/pr_financing_handoff.md)
  PR financing handoff notes and limitations.
- [docs/sec_dilution_handoff.md](./docs/sec_dilution_handoff.md)
  SEC dilution work handoff.
- [docs/press_release_levels_v2_notes.md](./docs/press_release_levels_v2_notes.md)
  Ongoing project notes.
- [docs/event_storage_and_market_enrichment_plan.md](./docs/event_storage_and_market_enrichment_plan.md)
  Save event documents now and add market-data enrichment later.
- [docs/v1_to_v2_standalone_migration_plan.md](./docs/v1_to_v2_standalone_migration_plan.md)
  Plan for removing the v1 shared-cache dependency and making v2 standalone.
- [docs/channel_routing_plan.md](./docs/channel_routing_plan.md)
  Current opportunity-channel rules and future market-cap channel notes.
- [docs/handoff_2026-04-21.md](./docs/handoff_2026-04-21.md)
  Current handoff note for the latest live-state, formatting, and resilience work.
