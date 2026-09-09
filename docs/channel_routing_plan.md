# Channel Routing Plan

## September 9 app delivery repair

Owner-authorized progress: [Newsfilter app recovery](newsfilter-app-recovery-2026-09-09.md).
Only eligible Discord alerts with a completed AI summary are published to the app. An unavailable AI summary must not create a TradersLink article.

### AI-summary routing

Publish a TradersLink article only when OpenAI generated a summary. When no AI summary exists, keep the normal destination route and post the original article title with its direct source URL in Discord so Discord can render the source article tile. Do not create, link, or route a TradersLink article without an AI summary. This runs only in the local Press Release watcher and requires coordinator-sequenced runner activation.

## News Filtered

The current primary v2 Discord channel is called News Filtered. It is for cleaner day-trade opportunity candidates.

For this channel, immediate dilution should be suppressed. A filing or press release that says dilution/sellable supply is live now is useful information, but it is not the kind of "good opportunity" post this channel is meant to surface.

Current suppression signal:

- `canDiluteToday = "Dilution status: Immediate"`
- `dilutionStatus = "live_now"`
- `dilutionTiming = "Dilution status: Immediate"`

These should not post to the current primary/spike opportunity channels.

Reverse-split announcements should also be suppressed from News Filtered. The system should identify these before webhook routing by scanning the raw Discord text, AI headline, AI summary, and fetched article text for deterministic phrases such as:

- reverse split
- reverse stock split
- reverse share split
- share consolidation
- stock consolidation
- 1-for-10 split or similar ratio language

These events should still be stored in SQLite and may still be useful later for broader market-cap channels or review, but they should not post to News Filtered.

## Market-Cap PR Channels

Market-cap press-release channels receive broader PR flow by market-cap bucket. These channels use separate route tags and webhook targets from the primary News Filtered opportunity channel.

Current implemented buckets:

- 30M and under
  - route tag: `market_cap_under_30m`
  - env: `MARKET_CAP_UNDER_30M_WEBHOOK_URL`
  - limit env: `MARKET_CAP_UNDER_30M_LIMIT`
  - default limit: `30000000`
- above 30M through 50M
  - route tag: `market_cap_30m_to_50m`
  - env: `MARKET_CAP_30M_TO_50M_WEBHOOK_URL`
  - min env: `MARKET_CAP_30M_TO_50M_MIN`
  - max env: `MARKET_CAP_30M_TO_50M_LIMIT`
  - default min: `30000000`, exclusive
  - default max: `50000000`, inclusive

Planned future bucket:

- above 50M through 100M

Market-cap channels can receive broader informational PR flow, including items the current opportunity channel suppresses. They should keep their own routing rules instead of weakening the current channel.

When `NEWS_ARTICLE_API_URL` and `NEWS_PUBLISH_TOKEN` are configured, market-cap channel posts follow the new website-first flow:

1. fetch article text
2. run AI processing when article text is available
3. publish the article to `traderslink.pro/news`
4. send a minimal Discord post with ticker metadata, headline, and website article link

If an AI summary is unavailable for a non-SEC source, the bot skips the website article and links Discord directly to the user-facing original source when one exists. NuntioBot helper URLs should not be sent to end users.

## Design Direction

Completed locally: [Newsfilter request spacing](newsfilter-request-spacing-2026-09-09.md) serializes article requests with a random 5–8 second cooldown. Runtime activation remains pending coordinator sequencing.

Keep routing as separate decisions:

- opportunity channel eligibility
- spike channel eligibility
- market-cap channel eligibility
- review queue eligibility

Do not use one generic `shouldPost` flag for every channel. The same event can be bad for the opportunity channel but still useful in a market-cap feed or review queue.
