# Event Storage And Market Enrichment Plan

## Goal

Save every relevant press release and SEC filing as soon as `v2` sees it, with a reliable timestamp, so we can analyze later which events led to strong stock moves.

This supports a later scoring system for:

- press releases
- SEC filings
- specific catalyst families
- market-reaction patterns after the event

## Immediate Plan

Use `v2` as the event-ingest system first.

That means:

- store the event immediately when the host message reaches the queue
- preserve the first-seen timestamp
- preserve the raw Discord message
- preserve the article or filing URL
- preserve the fetched article / filing text
- preserve the AI output and structured event fields after processing

This is enough to build a reliable historical event library now, even before market-data enrichment is added.

## Why This Is Good Enough For Now

We do not need IBKR market data to start collecting useful event records.

If we save the document and timestamp now, we can later:

- query historical market data around the event timestamp
- calculate post-event price and volume reactions
- attach those outcomes back to the saved event

So the right order is:

1. save the event now
2. enrich with market data later
3. build scoring after enough labeled history exists

## Current Storage Direction

Primary event storage lives in SQLite.

Default live path:

- `data/press_release_ingest.sqlite`

Current design:

- one row is created as soon as the event is observed
- the same row is updated after processing completes

Important fields to preserve:

- `observed_at`
- `message_timestamp`
- `ticker`
- `route_tag`
- `article_url`
- `source_hostname`
- `raw_discord_message`
- `event_type`
- `filing_type`
- `headline`
- `summary`
- `article_text`
- `article_source_mode`
- `dilution_status`
- `earliest_dilution`
- `processed_at`
- `processing_error`

## Future IBKR Enrichment Plan

Later, use the separate IBKR system to enrich saved events with market-reaction data.

Best model:

- `v2` remains the event collector
- the IBKR side reads saved events
- the IBKR side writes back market outcomes keyed by `event_id`

This keeps ingestion and market-data collection separate and maintainable.

## Market Data To Add Later

Price data alone is not enough.

Minimum useful market fields:

- `price_at_observed`
- `open_1m`
- `high_1m`
- `low_1m`
- `close_1m`
- `volume_1m`
- `high_5m`
- `high_15m`
- `high_30m`
- `high_60m`
- `close_same_day`
- `next_day_open`
- `next_day_high`
- `next_day_close`

Useful derived fields:

- `pct_change_1m`
- `pct_change_5m`
- `pct_change_15m`
- `pct_change_60m`
- `max_run_same_day_pct`
- `max_drawdown_same_day_pct`
- `time_to_first_10pct_move`
- `relative_volume_vs_recent_avg`

Useful context fields:

- `session`
- `float`
- `market_cap`
- `shares_outstanding`
- `avg_volume_10d`
- `premarket_gap_percent`

## Why Timestamp Quality Matters

The whole plan depends on a good first-seen timestamp.

If `observed_at` is recorded immediately and consistently, then later IBKR enrichment can still produce useful historical reaction analysis even if the market data is added after the fact.

## Recommendation

Start collecting event documents now.

Do not wait for the IBKR side before saving PRs and SEC filings.

Once enough events are stored:

- add IBKR-based market outcomes
- analyze which event families correlate with strong moves
- use that history to build a scoring layer
