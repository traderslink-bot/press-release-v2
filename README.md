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
- Discord delivery for spike and uncategorized posts

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
- posts the result to the configured Discord webhooks
- restarts the live Discord watcher automatically if the page/session dies

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

Review queue tools:

```powershell
node .\review_queue_viewer.js
node .\review_queue_summary.js
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
- [docs/handoff_2026-04-21.md](./docs/handoff_2026-04-21.md)
  Current handoff note for the latest live-state, formatting, and resilience work.
