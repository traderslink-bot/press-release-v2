# PR Dilution Timing Status

## Current Goal

The current PR work is **not** to build a perfect general-purpose press release summarizer.

The active goal is much narrower and trader-focused:

1. Tell the end user whether dilution can happen **now**.
2. If dilution cannot happen now, tell the end user the **earliest clear date** it can happen.
3. If dilution cannot happen until another filing/trigger exists, tell the end user that **another filing or trigger is needed first**.

This is the main product question for PR offering/private-placement posts right now.

## What "Good" Looks Like

For PR financing/offering posts, the output should help a day trader answer:

- If I buy this now, can share supply/dilution hit this trade immediately?
- If not, when is the first known date it can hit?
- If there is no clear date yet, does the deal still need:
  - a closing
  - an effectiveness step
  - another filing
  - another company/investor trigger

The system does **not** need perfect legal characterization first. It needs trader-usable timing.

## Snapshot Model

Current intended snapshot language:

- `Dilution status: Immediate`
- `Dilution status: Delayed`
- `Dilution status: Undetermined`

With:

- `Earliest dilution: <date>`
- `Earliest dilution: <date> closing`
- `Earliest dilution: after SEC effectiveness`
- `Earliest dilution: after company starts sales`
- `Earliest dilution: date unknown`

Interpretation:

- `Immediate`
  - PR clearly supports same-day or already-live dilution/sellable supply.
- `Delayed`
  - PR clearly gives a later date/closing and dilution cannot happen before then.
- `Undetermined`
  - PR does not safely support `Immediate` or `Delayed`.
  - This includes cases where another filing, another trigger, or an unclear step is still needed.

## Current PR Financing Coverage

The PR financing path already supports first-pass handling for:

- priced public offerings
- proposed public offerings
- registered direct offerings
- private placements
- ATM-style financings
- warrant-heavy financing PRs

The current prompt/path is already usable enough to classify many real PRs into those buckets.

## What the System Already Does Well

### 1. Detects financing-style PRs

The PR path is no longer treating offerings/private placements as generic PRs.

It now detects and routes financing-related PRs into a dedicated PR-financing prompt family.

### 2. Distinguishes proposed vs priced deals

This matters for timing:

- `proposed offering`
  - often no final close date yet
  - often should stay `Undetermined` or date-unknown
- `pricing announced`
  - often gives an expected close date
  - often should become `Delayed` with a real earliest date

### 3. Reuses the trader timing lens

The PR path now uses the same trader-facing timing idea already developed on the SEC dilution side:

- not just "this is an offering"
- but "when can the supply actually hit?"

### 4. Handles many normal offering/private-placement cases

Multiple PR batches have already been tested on:

- pricing public offerings
- registered directs
- private placements
- proposed offerings
- ATM/priced-at-market financings

So this is past the earliest prototype stage.

## What Still Needs Work

### 1. "Another filing needed first" is not yet explicit enough

This is the main new nuance to keep tightening.

Right now, some unclear cases land in:

- `Dilution status: Undetermined`
- `Earliest dilution: after SEC effectiveness`

That is directionally right, but the system should keep improving on cases where the real trader meaning is:

- dilution cannot happen until another filing is made
- dilution cannot happen until effectiveness is granted
- dilution cannot happen until a prospectus/final prospectus/other filing step exists

This should become more explicit in the summary/timing logic.

### 2. Warrant/pre-funded/conversion structures still blur timing

Harder PRs still exist where:

- common stock is sold now
- warrants exist too
- some supply is immediate
- some supply is future/potential

These are not fully solved yet.

### 3. Historical replay timing is still imperfect

Old PR replays can read awkwardly because the system is conservative when the close date is already in the past relative to the current clock.

This matters less for real live usage, but it still affects testing readability.

### 4. Article-source reliability is still the operational bottleneck

Prompt logic is ahead of article-fetch reliability right now.

That means the logic is progressing, but testing depth is constrained by article access.

## Current Operational Constraint

The main bottleneck is **not** PR prompt logic anymore.

The main bottleneck is:

- fresh article fetch reliability
- especially around Nuntio cooldown behavior

Important current live/testing rule:

- `PR DROP` posts are currently:
  - not fetched for article text
  - not routed to Discord

Reason:

- preserve fetch capacity for higher-priority PRs
- focus on bullish/move-the-market candidates first

## Current Understanding of How PR Timing Should Work

### Immediate

Use when the PR clearly supports that the deal is live now or can hit the trade right away.

Examples:

- offering already closed
- shares issued immediately
- financing already effective/live

### Delayed

Use when the PR clearly gives a later date/closing and dilution cannot happen before then.

Examples:

- expected to close on or about a future date
- not effective until a stated date/closing step

### Undetermined

Use when the system cannot safely say `Immediate` or `Delayed`.

This includes the important new class:

- another filing/trigger is needed first

Examples:

- waiting on SEC effectiveness
- waiting on another filing step
- waiting on company sale activation
- timing language is incomplete
- date not clearly stated

## Progress Assessment

For the **current PR timing goal only**, progress is roughly:

- beyond early prototype
- into solid first-pass/live-discord territory
- but not fully hardened yet

Roughly:

- core prompt/routing logic: good first pass
- timing interpretation: decent, but still needs edge-case tightening
- operational article ingestion: still the main limiter

## Practical Next Steps

1. Keep focusing on the narrow timing question, not broad PR summarization.
2. Keep testing PR offering/private-placement posts selectively.
3. Tighten wording/logic around:
   - another filing needed first
   - effectiveness-gated dilution
   - mixed immediate + future warrant supply
4. Keep treating article-source reliability as a separate operational track from prompt logic.
5. Do not re-expand into broad SEC work as the main task right now.

## Bottom Line

The PR system is already moving toward the right trader-facing question:

- can dilution happen now?
- if not, when?
- if not yet, what filing/trigger still needs to happen first?

That is the right frame, and it should remain the center of the PR financing work until this behavior feels reliable enough for live use.
