# SEC Dilution Handoff

## Purpose

This note is the focused handoff for the SEC dilution side of `press_release_levels_v2`.

It is meant to let a future session quickly answer:

- what SEC work has already been done
- what is working now
- what still needs refinement
- what should be worked on next, if SEC becomes the active focus again

## Current Recommendation

SEC work should move into **maintenance mode** for now.

Primary active focus should shift to:

- press release prompt design
- PR-based financing / offering / private placement detection

SEC work should still continue later, but only as:

- targeted testing on new real filings
- fixes for specific failures
- light expansion into additional filing families when justified by real cases

## What Is Working

### SEC Fetch / Parsing

- SEC index pages (`...-index.htm`) are resolved into real filing documents
- `/ix?doc=...` viewer links are normalized back to raw SEC archive documents
- complete submission `.txt` files are parsed into `<DOCUMENT>` sections when needed
- direct SEC links and index links are both handled

### Filing-Type Hints

- host-message SEC form hints are used when present
- examples already validated:
  - `8-K`
  - `20-F`
  - `S-1MEF`
  - `SCHEDULE 13G`

### SEC Text Reduction

The bot now uses section-aware reduction for SEC filings instead of always sending the whole filing.

Implemented selection profiles:

- `prospectus_supplement_atm`
- `current_report_dilution`
- `prospectus_supplement`
- `shelf_registration`
- `registration_statement`
- `exhibits_only_amendment`

This work is in:

- `lib/sec.js`

### SEC Prompting

Prompt routing is now split by source and SEC family.

Current important SEC family:

- `sec_dilution_financing`

This is used for dilution-oriented forms such as:

- `424B*`
- `S-1` / `F-1`
- `S-3` / `F-3`
- related amendment / financing patterns

Prompt work is in:

- `lib/prompts.js`
- `lib/ai.js`
- `lib/dilutionFilings.js`

### Dilution Snapshot

The dilution snapshot is now trader-facing and conservative.

Current display style:

- `Dilution status: Immediate`
- `Dilution status: Delayed`
- `Dilution status: Undetermined`
- `Earliest dilution: ...`

The dilution-specific normalization and timing code now lives in:

- `lib/dilutionFilings.js`

This file is the correct place for future work on:

- dilution timing/state classification
- dilution-specific summary cleanup
- dilution relevance checks
- future filing-family-specific dilution helpers

Important rule:

- do not overstate `Delayed`
- use `Undetermined` whenever the filing does not safely rule out or pin down first dilution timing

### SEC User Agent

The SEC request header now uses a declared contact-style user agent:

- `TraderLinkBot/1.0 thisguytraderslink@gmail.com`

Config:

- `SEC_USER_AGENT`

Files:

- `lib/config.js`
- `lib/sec.js`
- `.env.press_release_v2.example`

### Replay / Review / Cost Tracking

Replay mode now supports:

- manual SEC link testing
- optional review pass against the filing text
- OpenAI token / estimated-cost logging

Key files:

- `lib/replay.js`
- `lib/review.js`
- `lib/openaiUsage.js`

## What Is Strongest Right Now

Standard `424B5` dilution cases are in the best shape.

That includes:

- clean ATM cases
- fixed-share offerings
- pre-funded warrant offerings
- best-efforts primary offerings

Examples that reviewed well:

- `LAC`
- `RAYA`
- `UMAC`
- `CTMX`
- `CYN`
- `CYN`
- earlier strong cases:
  - `BEAT`
  - `WGRX`
  - `JEM`
  - `XHG`
  - `IPW`
  - `GLND`
  - `TRVI`

## What Is Still Weak / Incomplete

### Warrant-Heavy Edge Cases

Examples:

- `RVPH`
- `WNW`

Observed issue:

- timing and supply logic gets harder when the filing mixes:
  - common shares
  - pre-funded warrants
  - immediately exercisable warrants
  - unusual cashless / zero-exercise-price mechanics

Current status:

- `WNW` looked good enough to send live
- `RVPH` stayed a review-only case because it was still mixed

### Financing `8-K`

The system now recognizes dilution-style current reports better, but this family is not fully explored yet.

Known tested pair:

- `TRVI` financing `8-K`
- `FRMM` non-dilution `8-K`

This path works, but it should not be treated as fully finished.

### Lower-Priority SEC Families

These should be tested later and lightly, not as the main active focus:

- `S-3`
- `S-3ASR`
- `S-1`
- `F-1`

Reason:

- they are often setup / shelf / registration-stage filings
- they are usually less directly useful to the core trader question than:
  - `424B5`
  - financing `8-K`
  - PR-announced offerings / placements

## Low-Value SEC Text Ideas

This has not yet been implemented as an explicit blacklist, but it is a good next SEC refinement if needed:

Potential low-value sections to exclude conservatively:

- `forward-looking statements`
- generic `risk factors`
- `where you can find more information`
- `incorporation by reference`
- long generic indemnification boilerplate
- generic `description of debt securities` when the live offering is clearly equity
- signature / exhibit boilerplate that does not affect timing or supply

Important caution:

Do **not** aggressively exclude these without review:

- `underwriting`
- `plan of distribution`
- `selling stockholders`
- `sales agreement`

These often contain the exact timing/supply clues traders care about.

## Best Next SEC Steps If SEC Becomes Active Again

Do these in order:

1. Continue only with real new live/manual filings.
2. Prioritize:
   - `424B5`
   - financing `8-K`
   - private placement / PIPE style filings
3. Keep sorting cases into:
   - skip
   - standard dilution
   - edge case
4. Add a conservative low-value-section blacklist only if it clearly reduces noise without losing timing clues.
5. Revisit warrant-heavy and hybrid cases later.

## What Not To Do Next

- Do not spend a long time trying to perfect every SEC form family before returning to PR work.
- Do not prioritize `S-3` / `S-1` testing over `424B5` and PR-announced financings.
- Do not assume the filing text will always use words like `immediate` or `at closing`; keep using inference carefully and conservatively.
