# PR Offering Size, Price, and Share Count Phase 2 Plan

## Reminder

This is a planned next-layer improvement for the PR offering feature.

We want to add:

- offering size
- offering price
- share count
- a practical first-pass view of how many shares can hit near-term versus later

This is **not** the current top priority over dilution timing, but it is a strong candidate for the next phase once the current timing lane feels stable enough.

## Goal

For financing and offering PRs, add a second layer of trader-useful extraction beyond timing:

1. What is the gross deal size?
2. What price was the deal priced at?
3. How many common shares or common-stock equivalents are tied to the deal?
4. How much supply is near-term versus only potential/future?

The goal is **not** to build a perfect capital-structure model.

The goal is to give the user a practical trader-facing snapshot such as:

- `Offering size: $10.5M`
- `Price: $0.42`
- `Shares near term: 8.2M`
- `Future potential: +12.0M warrants`

## Why This Matters

The timing layer answers:

- can dilution happen now?
- if not, when or after what trigger?

The size/price/share layer would answer:

- how big is the deal?
- how cheap is the paper?
- how much supply may be involved?

That is a natural next step after timing.

## Complexity Assessment

### Easier pieces

- gross offering size
- public offering price
- stated share count

These are often stated explicitly in the PR.

### Harder pieces

- pre-funded warrants versus common shares
- warrant share counts
- underwriter option / overallotment share counts
- milestone-gated or approval-gated warrant supply
- registration-rights / resale-only shares
- estimating what can hit near-term versus only later

So this should be approached as a **practical first pass**, not a complete legal-cap-table parser.

## Proposed Internal Fields

Start small.

### Core extraction fields

- `dealSizeGross`
- `offeringPrice`
- `shareCountCommon`
- `shareCountPrefunded`
- `shareCountWarrants`
- `shareCountUnderwriterOption`
- `securityUnitsPresent`

### Timing-aware supply fields

- `nearTermPrimaryShares`
- `nearTermCommonEquivalents`
- `futurePotentialWarrantShares`
- `futurePotentialApprovalGatedShares`
- `futurePotentialMilestoneGatedShares`

### Confidence / notes fields

- `shareMathConfidence`
- `shareMathNotes`

## First-Pass Interpretation Rules

### Near-term bucket

Count here when the PR supports issuance or funded closing in the near-term:

- common shares sold now
- pre-funded warrants sold in lieu of common
- shares expected at closing

### Future-potential bucket

Count here when the PR clearly treats the supply as later or optional:

- common warrants
- milestone warrants
- approval-gated warrants
- exercise-only future supply
- underwriter option shares if not yet exercised

### Out of scope for first pass

Do not try to fully solve:

- exact float impact
- beneficial ownership cap math
- precise resale timing under every exemption
- cross-instrument dilution waterfall math

Those can come later if needed.

## Suggested User-Facing Output

Keep it short.

Possible future additions to the PR card:

- `Offering size: $10.5M`
- `Price: $0.42`
- `Near-term shares: 8.2M`
- `Future potential: +12.0M`

If share math is weak, it should be okay to suppress the line rather than guess.

## File Ownership

### Main rule file

- `lib/pressReleaseFinancing.js`

This should own:

- extraction helpers
- first-pass share math
- normalization of size / price / share fields

### Timing integration

- `lib/dilutionFilings.js`

This should remain focused on timing.

It may reference the new fields later, but it should not become the main share-math file.

### AI orchestration

- `lib/ai.js`

This should:

- pass through the new structured fields
- decide what reaches the final card

### Test fixtures

- `docs/article_texts/pr_test_index.csv`
- `article_text_fixture_check.js`

These should expand to include expectations like:

- `expected_offering_size`
- `expected_offering_price`
- `expected_near_term_shares`
- `expected_future_potential_shares`

Only after the extraction format is stable.

## Proposed Rollout

### Phase 2A

Add only:

- deal size
- offering price
- common share count
- pre-funded warrant count

No major UI changes yet.

### Phase 2B

Add first-pass supply grouping:

- near-term shares
- future potential shares

Still avoid precise float-impact claims.

### Phase 2C

If the first two phases hold up well, consider limited card output for:

- offering size
- price
- near-term share count

## Main Risks

- overbuilding the extraction model too early
- mixing “could exist eventually” with “can hit now”
- showing overly precise share numbers when the PR structure is messy

So the best principle is:

- extract more internally
- show less externally until confidence is good

## Recommended Priority

Recommended timing for this work:

- after the current dilution timing lane feels stable enough
- after a bit more fixture coverage is added for PR timing
- before any major live UI expansion

## Bottom Line

This is a very worthwhile next feature.

It should be built as a **small structured extraction layer** on top of the existing timing engine, not as a giant new taxonomy.

The maintainable path is:

1. extract size and price first
2. add simple near-term versus future share grouping
3. keep the user-facing output compact
