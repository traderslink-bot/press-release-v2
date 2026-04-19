# Press Release Levels V2 Notes

## Workspace

The isolated workspace for the current `v2` project is:

- `projects/press_release_levels_v2`

This folder is now the clean place to keep working on `v2` without adding more noise to the root project or the older `levels` directory history.

## Current File Layout

The project is now split into a small module set instead of one large script:

- `press_release_levels_v2.js`
  Thin entrypoint that chooses replay mode vs live Discord mode and owns the processing queue.
- `lib/config.js`
  Env loading and runtime configuration.
- `lib/utils.js`
  Shared text, chunking, and small helper functions.
- `lib/http.js`
  Timeout-protected network fetch helpers.
- `lib/sec.js`
  SEC URL normalization, index parsing, filing extraction, article fetch logic, and SEC fallback helpers.
- `lib/prompts.js`
  Prompt builders and PR vs SEC prompt routing.
- `lib/ai.js`
  OpenAI request logic plus output stabilization.
- `lib/dilutionFilings.js`
  Dilution-specific timing/status logic, relevance checks, and dilution summary/bullet cleanup.
- `lib/levels.js`
  Python levels script execution.
- `lib/discord.js`
  Embed formatting, route fan-out, and webhook posting.
- `lib/pipeline.js`
  End-to-end processing for one message.
- `lib/replay.js`
  Replay file loading and replay execution.
- `lib/liveBot.js`
  Playwright Discord login and live DOM watcher.

## Purpose

`levels/press_release_levels_v2.js` is a Discord monitoring bot for TradersLink news flow.

It:

- logs into Discord with Playwright
- watches the host news channel for new posts
- parses each post for ticker, metadata, route tag, and source link
- fetches the linked press release or SEC filing text
- sends the content to OpenAI for a structured summary when appropriate
- runs `levels_clean_output.py` for the ticker
- posts a Discord embed to the configured webhook channels

This is the `v2` branch of the bot intended for testing without disturbing the working `v1` setup.

## Current Routing Behavior

Every processed post still goes to the main webhook:

- `DISCORD_WEBHOOK_URL`

Additional routing is based on the Discord message header text:

- posts with `Spike` in the header also go to `SPIKE_WEBHOOK_URL`
- posts with `Drop` in the header also go to `DROP_WEBHOOK_URL`

The route signal is read from the message header username area, for example:

- `PR - Spike`
- `PR ↓ DROP`

This was added because the route label is not reliably present in the main message body text.

## Environment Setup

`v2` supports a dedicated env file via:

- `ENV_FILE=.env.press_release_v2`

If `ENV_FILE` is not supplied, it falls back to `.env`.

Recommended testing pattern:

- keep `v1` on `.env`
- keep `v2` on `.env.press_release_v2`

Template file:

- `.env.press_release_v2.example`

Current default env-file preference for the isolated `v2` project is:

1. `projects/press_release_levels_v2/.env.press_release_v2`
2. `projects/press_release_levels_v2/.env.press_release_v2.example`
3. workspace-level `.env.press_release_v2`
4. workspace-level `.env.press_release_v2.example`
5. fallback `.env`

This was added so `v2` stops accidentally using the old root `.env` / `v1` webhook setup when `ENV_FILE` is not explicitly set.

For manual prompt testing without relying on live host-channel posts:

- use a replay JSON file such as `docs/manual_sec_test_cases.example.json`
- each item can be as small as:
  - `ticker`
  - `articleLink`
  - optional `filingTypeHint`
- if `rawText` is omitted for a SEC filing test, replay mode now synthesizes a minimal host-style SEC line from the ticker and filing type hint

For sending those manual tests to a separate Discord channel instead of the normal `v2` channels:

- set `WEBHOOK_OVERRIDE_URL` in your env file
- replay/manual tests will post only to that webhook while the override is set
- if you want that override/test channel to stay dilution-only:
  - set `WEBHOOK_OVERRIDE_DILUTION_ONLY=true`
  - non-dilution outputs will still process normally but will skip posting to the override channel

For optional SEC-output review during replay/manual testing:

- set `REVIEW_ENABLED=true`
- set `REVIEW_OUTPUT_FILE=...`
- replay mode will:
  - fetch the actual filing
  - generate the normal bot output
  - run a second AI review pass against the filing text and the bot output
  - write structured review judgments to the review output file

For SEC filing text size control during testing:

- set `SEC_TEXT_MODE=targeted` to send a reduced, section-aware filing slice to OpenAI
- set `SEC_TEXT_MODE=full` to send the current full extracted filing text

Current manual test files:

- `docs/manual_sec_test_cases.example.json`
- `docs/manual_sec_dilution_host_posts.json`
- `docs/manual_sec_review_pair.json`
- `docs/pr_financing_link_tracker.json`

## What V2 Does Better Than V1

### GitHub Removed

`v2` no longer uploads placeholder or final pages to GitHub Pages.

Removed from flow:

- GitHub repo writes
- placeholder HTML generation
- GitHub Pages links in embeds

Current flow is:

- Discord post detected
- content fetched
- AI summary generated when appropriate
- levels generated
- embed posted directly to Discord webhooks

### Better Request Timeout Handling

`v2` keeps timeouts active through response body reads, not just the initial network connection.

This helps avoid queue hangs on:

- slow article pages
- slow SEC responses
- slow OpenAI responses
- slow Discord webhook responses

Current OpenAI timeout posture is intentionally tighter than earlier iterations:

- main summary call timeout:
  - `OPENAI_TIMEOUT_MS`
- main summary retries:
  - `OPENAI_MAX_RETRIES`
- review call timeout:
  - `REVIEW_TIMEOUT_MS`
- review retries:
  - `REVIEW_MAX_RETRIES`

Reason:

- once SEC filings are reduced with section-aware selection, the bot should usually not need long multi-retry OpenAI runs for a single filing
- the optional review pass should fail fast rather than hold the pipeline open for minutes

### Safer Article Fetch Failure Handling

Non-SEC article fetch failures can still fall back to a Discord-metadata-only AI summary.

SEC filing failures do **not** go to AI if the system already knows it could not fetch substantive filing text.

Instead, the bot generates a direct user-facing fallback note and surfaces the SEC link clearly.

### Better Discord DOM Parsing

`v2` improved parsing for:

- grouped follow-up messages
- message wrapper nodes
- route tags in header username text

### Better Link Detection

The parser no longer accepts any vague link containing the word `news`.

It now checks for more likely article domains and paths.

## SEC Filing Handling Improvements

This is the area with the most important recent work.

### Host Channel Behavior

Host channel SEC posts already include filing type in the message text, for example:

- `SEC Form SCHEDULE 13G - Link`
- `SEC Form 20-F - Link`
- `SEC Form 8-K - Link`

That means the bot can use the host post itself as a filing-type hint before it even fetches the SEC page.

### SEC Index Page Problem

Many SEC links from the host channel go to an EDGAR index page like:

- `...-index.htm`

Those index pages often contain:

- an `/ix?doc=...` XBRL viewer link
- the raw filing `.htm`
- a full submission `.txt`
- exhibits and attachments

The older logic could accidentally grab the XBRL viewer wrapper instead of the filing itself, which caused weak summaries like:

- AI saying it only saw an XBRL Viewer placeholder

### Current SEC Resolver Strategy

`v2` now:

1. normalizes `/ix?doc=...` viewer URLs back to the raw SEC archive document
2. parses the SEC index tables into document rows
3. uses the filing type from the host Discord post as a hint
4. ranks likely filing documents before trying them
5. falls back to the complete submission `.txt` if needed
6. parses `.txt` submission files into `<DOCUMENT>` sections
7. tries to select the `<DOCUMENT>` block whose `TYPE` matches the expected filing type

This helps on filings such as:

- `8-K`
- `20-F`
- `S-1MEF`
- `SCHEDULE 13G`

### SEC Fallback Behavior

If `v2` still cannot extract substantive filing text:

- it does not send the case to AI
- it generates a deterministic unreadable-filing notice
- it includes a more visible SEC filing link in the embed

This avoids low-value end-user output like:

- explanations about XBRL Viewer placeholders

Instead, users should see a direct note telling them AI could not read the filing and to open the SEC filing link.

## Current Status

The project is now at a good stopping point for the current SEC-focused phase.

What is in solid shape:

- Discord route parsing for `Spike` / `Drop`
- dedicated `v2` env support
- replay/manual test mode
- direct webhook posting without GitHub Pages
- SEC index resolution and `/ix?doc=...` normalization
- section-aware SEC text reduction
- dilution snapshot formatting for SEC dilution-style posts
- dilution-specific domain logic extracted into its own module
- OpenAI usage / estimated cost logging in replay outputs

What is intentionally **not** fully finished:

- every obscure SEC dilution edge case
- complete financing `8-K` coverage
- every possible warrant / hybrid / preferred / second-closing structure

This is acceptable because the current recommendation is to stop treating SEC testing as the only active workstream.

## Next Active Focus

The next main workstream should be:

- press release prompt design and refinement

Reason:

- the SEC `424B5` path is far enough along for standard cases
- SEC testing can continue later in maintenance mode
- offerings, registered directs, and private placements are often announced in press releases
- the live/operational system will continue surfacing new SEC and PR cases over time anyway

Recommended next steps for the next session:

1. Shift primary work to press releases.
2. Review and refine the PR prompt separately from the SEC prompt.
3. Teach the PR path to recognize financing / offering / private placement language announced in press releases.
4. Keep SEC work as a secondary lane:
   - test new links the user provides
   - refine only when a real live/manual case exposes a clear problem

PR-financing work has now started.

Current first-pass PR financing routing supports:

- priced public offering PRs
- proposed public offering PRs
- registered direct offering PRs
- private placement PRs
- at-the-market financing PRs
- warrant-financing PRs

Current first-pass PR financing timing behavior:

- reuses the same trader-facing snapshot format as the SEC dilution path
- shows:
  - `Dilution status: Immediate`
  - `Dilution status: Delayed`
  - `Dilution status: Undetermined`
  - `Earliest dilution: ...`
- treats announced future closings as delayed until closing
- treats proposed / not-yet-priced offerings conservatively as undetermined
- keeps registration / shelf mechanics from being treated as the first timing trigger when the PR still says closing must happen later

Current first-pass PR financing examples already used:

- `FCHL`
- `TURB`
- `ABOS`
- `CTMX`

For PR work, the main harvested article pool now lives in:

- `docs/pr_financing_link_tracker.json`

Recommended tracker workflow:

- mark `usedForPromptTesting=true` when a PR article is used to shape or test prompts
- mark `usedForLivePreview=true` when the result is posted to Discord test channels
- update `status` with values like:
  - `unreviewed`
  - `selected`
  - `tested`
  - `skip`
  - `edge_case`
- when available, also store:
  - `discordMessageId`
  - `discordPostedAt`
  - `discordPostedDate`

These fields allow future replay batches to mimic the post date/time instead of the real current date when evaluating offering/closing timing on historical PRs.

## Related Docs

For the SEC-specific handoff, see:

- `docs/sec_dilution_handoff.md`

For the PR-financing-specific handoff, see:

- `docs/pr_financing_handoff.md`

## Testing Already Done

Work done without live market posts:

- syntax validation with `node --check`
- DOM parsing validation against `levels/host-channel-dom-html-example.md`
- SEC resolver smoke tests against real SEC URLs provided during development
- routing verification for `Spike` and `Drop` header labels

## Ways To Test While Market Is Closed

### 1. Run V2 Against Existing Messages In The Channel

The bot only auto-processes messages added after it starts, so simply opening the channel while the market is closed will usually not replay old posts.

This means passive live testing is limited right now.

### 2. Manual Function-Level Testing

Useful right now:

- feed known SEC URLs directly into the SEC resolver logic
- test parsing against saved DOM snippets
- test OpenAI summaries with saved raw message text plus saved article/filling text

This has already been used during development.

### 3. Simulated Replay Mode

`v2` now includes a replay harness that reads saved test cases and runs them through the same processing pipeline.

A replay case can contain:

- raw Discord message text
- route tag
- ticker
- source URL
- optional float / IO / market cap values

This lets us test:

- SEC fetch behavior
- AI summary generation
- routing to test channels
- final Discord embed output

without waiting for live market posts.

### 4. Manual Injection Test

Another option is to manually call the pipeline with a known test payload from a saved post.

That would simulate a live Discord event and is a good way to verify:

- main webhook posting
- spike/drop webhook routing
- embed formatting
- SEC fallback behavior

## Replay Mode

Replay mode is enabled by setting:

- `REPLAY_FILE=docs/press_release_levels_v2_replay_sample.json`

Optional:

- `REPLAY_SKIP_WEBHOOKS=true`

Behavior:

- if `REPLAY_FILE` is set, `v2` does not log into Discord
- it loads saved messages from the JSON file
- it runs each saved message through the normal `processMessage()` pipeline
- it posts to the configured test webhooks unless `REPLAY_SKIP_WEBHOOKS=true`

PowerShell example:

```powershell
$env:ENV_FILE=".env.press_release_v2"
$env:REPLAY_FILE="docs/press_release_levels_v2_replay_sample.json"
node .\levels\press_release_levels_v2.js
```

Dry-run example:

```powershell
$env:ENV_FILE=".env.press_release_v2"
$env:REPLAY_FILE="docs/press_release_levels_v2_replay_sample.json"
$env:REPLAY_SKIP_WEBHOOKS="true"
node .\levels\press_release_levels_v2.js
```

## Current Important Files

- `levels/press_release_levels_v2.js`
- `.env.press_release_v2`
- `.env.press_release_v2.example`
- `levels/host-channel-dom-html-example.md`
- `docs/press_release_levels_v2_replay_sample.json`

## Current Status Summary

`v2` currently has:

- separate env-file support
- isolated project workspace under `projects/press_release_levels_v2`
- Discord route-tag parsing for `Spike` and `Drop`
- GitHub removed from the flow
- better timeouts
- stronger article-link matching
- improved SEC index resolution
- smarter SEC `.txt` fallback parsing
- deterministic unreadable-SEC fallback messaging
- replay mode for off-hours testing
- SEC output stabilization for more consistent `filingType` and `eventType`

## SEC Output Stabilization

Recent work in the isolated project copy added post-processing to reduce model drift for SEC outputs.

Current stabilization behavior:

- prefer the filing type from the host Discord message over freer AI wording
- normalize SEC event types into stable buckets such as:
  - `sec_registration_statement`
  - `sec_current_report`
  - `sec_periodic_report`
  - `sec_beneficial_ownership`
  - `sec_proxy`
  - `sec_filing`
- normalize press-release event types into stable press-release buckets
- apply a more repeatable SEC summary lead so SEC summaries start in a more predictable style

Replay comparison after this change showed a meaningful reduction in SEC drift for:

- `filingType`
- `eventType`
- headline consistency on the SEC sample

Summary wording still varies across runs, but the structured SEC fields are now much more stable than before.

## Dilution Filing Refinement

The current prompt work is focused first on dilution / financing filings because these are especially sensitive for fast trading decisions.

### Current Dilution Prompt Family

The SEC prompt routing now has a specialized dilution-family path for filings such as:

- `S-1`
- `S-1/A`
- `S-1MEF`
- `S-3`
- `S-3/A`
- `S-3ASR`
- `F-1`
- `F-1/A`
- `F-3`
- `F-3/A`
- `424B*`
- `POS AM`
- `POSASR`

The dilution-family prompt is designed to answer trader-first questions like:

- is dilution immediate or delayed?
- if delayed, what must happen first?
- when can shares first hit the market?
- is this a primary issuance, resale registration, or both?
- what supply is immediate versus conditional or gated?

### Dilution Snapshot

Dilution-style SEC outputs can now include a dedicated two-line snapshot above the summary:

- `Dilution status: Immediate`
- `Earliest dilution: Apr 16, 2026 closing`

or, for more conservative cases:

- `Dilution status: Delayed`
- `Earliest dilution: Apr 20, 2026`

- `Dilution status: Undetermined`
- `Earliest dilution: after SEC effectiveness`

- `Dilution status: Undetermined`
- `Earliest dilution: date unknown`

Important:

- this snapshot line is only intended for dilution-style SEC outputs
- it should not appear on the original PR post format or unrelated SEC post types
- the snapshot now tries to answer the trader-first question directly:
  - is same-day dilution clearly immediate?
  - is it clearly delayed past today?
  - or is the earliest timing still not safe to pin down?
- the snapshot wording is based on filing-supported trigger logic rather than trying to rewrite old replay examples based on the current date
- conservative behavior matters here:
  - `Delayed` should only be used when the filing clearly rules out today
  - otherwise the system should prefer `Undetermined`

### More Precise Dilution Event Types

Dilution-family SEC outputs now stabilize into more specific event labels:

- `sec_prospectus_supplement`
- `sec_shelf_registration`
- `sec_registration_statement`
- `sec_registration_amendment`

This helps both the review harness and the Discord output stay more consistent.

### Recent Refinements

Recent work in this area added:

- compact normalization of `dilutionTiming`
- stronger timing instructions in the prompt
- better separation of immediate dilution versus conditional future supply
- clearer handling of locked-up, unvested, reserved, or merely authorized shares
- a wording preference for `shares outstanding after the offering` instead of the looser phrase `diluted shares outstanding`

### Recent Dilution Test Set

Recent focused replay/review testing used:

- `BEAT` `424B5`
- `WGRX` `S-3`
- `JEM` `F-1/A`
- `XHG` `424B5`

Result:

- all four passed the structured review harness after the latest refinement pass
- the live examples were also sent to the override Discord test channel for visual review

## SEC Text Reduction Benchmark

The project now has a first section-aware text selector for dilution-family SEC filings.

Current profiles:

- dilution-style `8-K` / `6-K` current reports
- `424B*` prospectus supplements
- `S-3` / `F-3` shelf registrations
- `S-1` / `F-1` registration statements
- exhibits-only amendments

The selector keeps:

- the filing cover section
- a profile-specific set of high-value keyword windows such as:
  - entry into a material definitive agreement
  - unregistered sales of equity securities
  - underwriting agreement
  - securities purchase agreement
  - registration rights agreement
  - private placement / PIPE markers
  - convertible notes / warrants
  - prospectus summary
  - the offering
  - use of proceeds
  - dilution
  - underwriting / plan of distribution
  - selling stockholders
  - registration rights
  - recent unregistered sales

If the selected text is too thin, the system falls back to the broader filing text instead of forcing a weak reduced slice.

### Benchmark Run

Replay file used:

- `docs/manual_sec_dilution_refine_next.json`

Filings tested:

- `BEAT` `424B5`
- `WGRX` `S-3`
- `JEM` `F-1/A`
- `XHG` `424B5`

Dry-run timing with review enabled:

- `SEC_TEXT_MODE=full`
  - about `180.9s`
- `SEC_TEXT_MODE=targeted`
  - about `162.6s`

Observed text reduction in targeted mode:

- `BEAT`
  - `160000 -> 24081` chars
- `WGRX`
  - `118847 -> 27997` chars
- `JEM`
  - `17204 -> 16442` chars
- `XHG`
  - `160000 -> 23462` chars

Quality result:

- targeted mode held up across the 4-filing set
- targeted mode improved the review verdict on `WGRX`
  - `full` run: `mixed`
  - `targeted` run: `pass`

Current takeaway:

- section-aware SEC reduction looks worth keeping for dilution-family filings
- it reduces prompt size materially on larger filings
- it gave a modest speed improvement in replay testing
- it did not hurt quality on this benchmark set

### ATM Timing Guard

ATM / sales-agreement `424B5` filings are now normalized more conservatively for the trader snapshot.

If the filing only establishes or expands an ATM facility and does not clearly say a sale has already been priced or is closing on a stated date, the bot now treats the timing as:

- `Dilution status: Undetermined`
- `Earliest dilution: after company starts sales`

This avoids treating generic ATM language like:

- `from time to time`
- `sales agreement`
- `sales agent`
- `settlement generally the next trading day`

as if it were already the same thing as a priced offering or known closing.

### Current-Report Dilution Coverage

The selector and prompt router now also recognize dilution-style current reports such as financing `8-K` or `6-K` filings when the filing text contains multiple financing markers, for example:

- underwriting agreement
- securities purchase agreement
- registration rights agreement
- private placement / PIPE
- convertible notes
- warrants
- gross proceeds / net proceeds
- shares of common stock

This lets financing-style current reports use the same dilution-focused SEC prompt family while leaving non-dilution current reports on the general SEC path.

Focused dry-run/review check:

- replay file:
  - `docs/manual_sec_current_report_dilution_pair.json`
- cases:
  - `TRVI` `8-K` financing current report
  - `FRMM` `8-K` share-repurchase / strategic-review current report

Observed result:

- `TRVI`
  - targeted selector reduced text from `17078 -> 9858` chars
  - routed through the dilution-aware path
  - review verdict: `pass`
- `FRMM`
  - stayed on the normal current-report path
  - no dilution snapshot added
  - review verdict: `pass`

### OpenAI Usage Tracking

Replay runs now record lightweight OpenAI usage and cost estimates.

Per-call tracking:

- prompt tokens
- completion tokens
- total tokens
- cached input tokens when the API returns them
- estimated USD cost

Replay outputs now include:

- per-filing `openaiUsage` for the summary call
- per-review `openaiUsage` when review is enabled
- batch totals under `openaiUsage.summary`, `openaiUsage.review`, and `openaiUsage.total`

Pricing behavior:

- if `OPENAI_PRICE_INPUT_PER_1M` and `OPENAI_PRICE_OUTPUT_PER_1M` are set, those env values are used
- otherwise the bot uses a small built-in estimate table for supported GPT-5.4 family models and the `gpt-5-mini` alias
- if the active model is unknown to the built-in table and no env override is set, token counts still log but estimated cost may remain `null`

### Nuntio Fetch Guards

PR testing exposed `news.nuntiobot.com` returning:

- `403`
- `{"detail":"Access Denied: Cool-off due to excessive requests."}`

To reduce the chance of repeated cooldowns and avoid hammering the site, `lib/sec.js` now adds a small Nuntio-specific protection layer for non-SEC article fetches:

- local disk cache for fetched article text
- per-domain pacing before Nuntio requests
- cooldown-aware retry/backoff when Nuntio returns the cool-off `403`

Config knobs:

- `ARTICLE_CACHE_DIR`
- `NUNTIO_MIN_INTERVAL_MS`
- `NUNTIO_COOLDOWN_MS`
- `NUNTIO_MAX_RETRIES`

Current intent:

- keep live posting behavior realistic
- make replay/testing much less bursty against Nuntio
- reduce the chance of teaching Nuntio to dislike the current IP

Live-mode priority is still speed first for day traders.

If Nuntio limiting becomes a real production issue, the likely fallback policy is:

- keep trying to fetch bullish/market-moving PR candidates first
- keep trying to fetch PR posts that are not classified as either spike or drop
- skip article fetch for PR drops first, rather than slowing the whole live pipeline

This is a live-ops tradeoff, not a permanent product rule. For now, PR drops are lower priority than PR spikes and uncategorized PRs when fetch pressure becomes a bottleneck.

Current temporary implementation:

- non-SEC `PR DROP` posts do not fetch the article body
- they go straight to the metadata-only fallback path
- this preserves article-fetch capacity for `PR SPIKE` and uncategorized PRs while live Nuntio behavior is still being evaluated
- `PR DROP` posts are also not routed to Discord at all for now

Latest pattern-probe result:

- a gentle manual probe of one Nuntio URL at ~3 second spacing returned `200` repeatedly
- but a later replay batch with a fresh uncached Nuntio URL hit cool-off immediately on the first bot fetch

Current working interpretation:

- Nuntio limiting is probably driven much more by fresh/uncached article fetches than by cached replays
- cooldown can persist across runs, so a later batch may still start in a cooled-off state
- this makes URL caching and direct-source resolution materially more valuable than simply retrying harder
