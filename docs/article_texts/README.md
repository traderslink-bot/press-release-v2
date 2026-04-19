# Article Text Intake

This folder is for pasted article text so we can:

- review PR language without hitting Nuntio
- build timing logic from real article wording
- test the PR dilution engine against local article text

## Goal

The goal is not to build a perfect archive.

The goal is to give the project a clean local source of article wording for:

- proposed offerings
- priced offerings
- private placements
- registered directs
- mixed stock + warrant structures
- secondaries
- ATM / company-controlled sale structures
- rights offerings

## Best Format

One file per article is best.

Suggested filename:

- `TICKER-short-description.md`

Examples:

- `CBUS-proposed-public-offering.md`
- `CBUS-pricing-public-offering.md`
- `ICCM-rd-plus-concurrent-private-placement.md`
- `VOR-private-placement.md`

## File Structure

Use this shape:

```md
# TICKER

Link: https://...
Headline: ...
Source: Nuntio / PR Newswire / Business Wire / etc.
Structure hint: proposed offering / pricing / private placement / registered direct / secondary / ATM / rights offering

## Article

<paste full article text here>
```

## What Matters Most

The most important thing is the actual article wording.

Especially preserve lines about:

- proposed vs priced vs closed
- expected closing date
- customary closing conditions
- registration / resale / effectiveness
- stockholder approval
- warrants / pre-funded warrants
- holder option / exercise / conversion
- selling shareholder / company not receiving proceeds
- share repurchase
- rights offering terms

## Current Workflow

1. Paste articles into this folder.
2. Add or update the article row in `pr_test_index.csv`.
3. We review wording locally.
4. We use the wording to tighten the PR timing engine.
5. Later, when ready, we can build a small local test harness around these files.

## Index And Usage Tracking

Use:

- `pr_test_index.csv`

as both:

- the article catalog
- the usage tracker

Important columns:

- `local_file`
- `offering_family`
- `timing_pattern`
- `expected_card_status`
- `expected_earliest_line`
- `special_flags`

Codex usage tracking columns:

- `used_for_language_review`
- `used_for_phase1_logic`
- `used_for_replay_test`
- `last_used_at`
- `usage_notes`

This avoids having a separate drifting tracker for article usage.

## Important Note

This folder is intentionally separate from live fetch logic.

It exists so testing and rule-building do not depend on Nuntio availability.
