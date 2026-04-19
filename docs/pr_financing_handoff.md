# PR Financing Handoff

## Purpose

This note is the focused handoff for the press-release financing side of `press_release_levels_v2`.

It is meant to answer:

- what PR-financing work has already been done
- what is working now
- what still needs refinement
- what should be worked on next

## Current Recommendation

PR financing is now the main active workstream.

Primary focus should be:

- offerings announced by press release
- registered directs
- private placements
- at-the-market financing PRs
- warrant-heavy financing PRs

SEC should stay in maintenance mode unless a real new filing exposes a concrete problem.

## Current Implementation

Files:

- `lib/prompts.js`
- `lib/ai.js`
- `lib/pressReleaseFinancing.js`

Current PR-financing behavior:

- PR routing now detects a financing-style PR path instead of using only the generic PR prompt
- the financing path is based on actual article language, not Discord post formatting
- financing PR outputs can now populate the top snapshot with:
  - `Dilution status: Immediate`
  - `Dilution status: Delayed`
  - `Dilution status: Undetermined`
  - `Earliest dilution: ...`

Current supported PR financing families:

- `press_release_offering_pricing`
- `press_release_offering_proposed`
- `press_release_registered_direct`
- `press_release_private_placement`
- `press_release_at_the_market_financing`
- `press_release_warrant_financing`

## What Is Working

The first useful pass is now in place for:

- priced public offering PRs
- proposed offering PRs
- registered direct PRs
- private placement PRs

The current logic now does these important things better:

- if the press release says the deal is expected to close on or about a future date, the timing is treated as delayed until closing
- if the PR is only a proposed / launched offering with no firm pricing or close date, timing stays conservative and undetermined
- the system no longer treats SEC effectiveness or shelf mechanics as the first dilution trigger when the PR still says closing must happen later
- obvious low-signal positives like placement-agent identity and effective-registration mechanics are filtered more aggressively on the PR-financing path

## First Test Batch Already Used

These links have already been used for prompt testing and live preview:

- `FCHL`
  - pricing public offering
- `TURB`
  - registered direct
- `ABOS`
  - private placement
- `CTMX`
  - proposed public offering

Replay files:

- `docs/manual_pr_financing_examples.json`
- `docs/replay_results/pr-financing-examples-dryrun-v4.json`
- `docs/replay_results/pr-financing-examples-live-v1.json`

Tracker:

- `docs/pr_financing_link_tracker.json`

Useful supporting export for recent visible Discord posts:

- `docs/pr_visible_discord_posts.json`

## What Still Needs Refinement

### Historical Replay Dates

Because replay runs use the current date when building the top dilution snapshot, old PRs with already-past expected close dates can land on:

- `Dilution status: Undetermined`

instead of a cleaner historical interpretation.

This is acceptable for now because:

- the live/operational use case is the real priority
- future live PRs will be processed near their actual announcement time

Do not spend a lot of time trying to make old replay posts look historically perfect.

### Positives / Negatives

Still watch for PR-financing outputs that over-credit:

- investor names by themselves
- resale registration promises
- generic financing mechanics

The path is better now, but not fully dialed in yet.

### Warrant / Pre-Funded Warrant Nuance

This is likely the next area that will need tightening.

Watch for PRs involving:

- pre-funded warrants
- common warrants
- short-dated warrants
- warrant inducements
- exercise-driven share supply

These can blur:

- immediate dilution
- delayed dilution
- near-term potential supply

## Best Next Steps

1. Keep using `docs/pr_financing_link_tracker.json` as the source pool.
2. Pull more PR examples from the Discord PR channel.
3. When harvesting new PRs from Discord, store:
   - `discordMessageId`
   - `discordPostedAt`
   - `discordPostedDate`
4. Prefer new posts for timing-sensitive replay work instead of trying to perfectly retrofit older harvested links.
5. Prioritize examples in this order:
   - pricing public offering
   - proposed offering
   - registered direct
   - private placement
   - warrant-heavy financing
   - at-the-market financing
6. Keep marking tracker entries:
   - `usedForPromptTesting`
   - `usedForLivePreview`
   - `status`
7. Pressure-test the same core trader question:
   - can dilution happen today?
   - if not, what is the earliest supported timing?

### Nuntio Guardrail Note

Large replay batches hit `news.nuntiobot.com` cool-off responses:

- `403`
- `Access Denied: Cool-off due to excessive requests.`

The fetch path now includes:

- local article-text caching
- Nuntio-specific pacing between requests
- cooldown-aware retry/backoff

That guardrail is mainly for replay/testing. Live posting should already be much less bursty, but the same protection lowers the risk of the site disliking the current IP.

Important later finding:

- a gentle manual probe of the same Nuntio URL at low pace returned `200`
- but a later replay run hit Nuntio cool-off on the first fresh uncached article

So the likely pressure point is:

- fresh uncached Nuntio article fetches
- not just any repeated request in general

This makes three things especially important:

- cache reuse
- direct-source URL resolution when possible
- skipping lower-priority PR fetches first if live limiting shows up

If live Nuntio limiting still shows up, the first operational fallback should be:

- keep fetching PR spikes
- keep fetching uncategorized PRs
- skip article fetch for PR drops first

Reason:

- current priority is fast delivery of bullish / market-moving PRs for day traders
- PR drops are lower priority right now than posts with upside potential or uncategorized posts that might matter
- this preserves live speed better than slowing every PR fetch path equally

Current temporary code posture:

- non-SEC `PR DROP` posts already skip article fetch and use metadata-only fallback text instead
- `PR DROP` posts are also suppressed from Discord routing for now
- this is intentionally reversible later, but it is the current live/testing rule while Nuntio limits are still being characterized

## What Not To Do Next

- Do not go back to broad SEC form-family work as the main focus.
- Do not rely on Discord post formatting for PR-financing detection.
- Do not overfit the PR prompt to one article.
- Do not spend time making old replay dates behave like a perfect historical simulator.
