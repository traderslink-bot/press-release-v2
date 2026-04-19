# PR Offering Language Phase 1 Plan

## Purpose

This file is a **build-now plan** derived from:

- [pr_offering_language_review_from_chatgpt_findings.md](</c:/Users/jerac/Documents/TraderLink/playwright/projects/press_release_levels_v2/docs/pr_offering_language_review_from_chatgpt_findings.md:1>)

The goal is to keep implementation manageable.

This plan intentionally does **not** try to implement the full taxonomy from the findings file.

It only keeps the parts that most directly improve the current trader-facing question:

- can dilution hit now
- if not, when is the earliest clear trigger
- if not yet, what still has to happen first

## Keep The Output Simple

Do not expand the public card much.

Keep the current short structure:

- `Dilution: Immediate`
- `Dilution: Delayed`
- `Dilution: Undetermined`

And:

- `Earliest: <date> close`
- `Earliest: After SEC effectiveness`
- `Earliest: Another filing needed`
- `Earliest: Date unknown`
- `Earliest: Company sales start`
- `Earliest: Stockholder approval`

Phase 1 should improve the engine underneath, not make the Discord post verbose.

## Phase 1 Build-Now Priorities

### 1. Proposed vs priced vs closed

This is the highest-value distinction and should be the first internal split.

Detect:

- proposed
- launched
- commenced
- priced
- expected to close
- closed

Core rule:

- proposed / launched / commenced without clear pricing and close timing:
  - usually `Undetermined`
  - `Earliest: Date unknown`
- priced with expected future close:
  - usually `Delayed`
  - `Earliest: <close date> close`
- closed:
  - candidate for `Immediate`

### 2. Another filing / effectiveness / approval needed

This is the second highest-value improvement.

Detect:

- registration statement still needs to be filed
- resale registration still needs to be filed
- SEC effectiveness still needed
- stockholder approval needed
- milestone trigger needed

Core rule:

- if the PR clearly says another filing, effectiveness step, or approval still needs to happen:
  - do not overstate immediacy
  - prefer:
    - `Earliest: Another filing needed`
    - `Earliest: After SEC effectiveness`
    - `Earliest: Stockholder approval`

### 3. Private placement close timing vs public resale timing

This is one of the most important structural splits.

Detect separately:

- when the private placement is expected to close
- whether the securities are unregistered
- whether resale registration / effectiveness is still needed

Core rule:

- a private placement can have a near-term closing date
- but that does not automatically mean public sellability is live

Phase 1 does not need to solve every nuance, but it should stop collapsing:

- `private placement closes soon`

into:

- `public dilution clearly live now`

### 4. Mixed common + warrant structures

This is common enough that it should be part of phase 1.

Detect:

- common stock and/or pre-funded warrants
- concurrent private placement of warrants
- accompanying warrants
- immediately exercisable warrants
- future optional warrant exercise proceeds

Core rule:

- keep one internal flag that the structure is mixed
- do not flatten everything into one single timing assumption

Phase 1 does **not** need to fully model every warrant subtype.
It only needs to know:

- some supply is tied to close
- some supply is only future / optional / conditional

### 5. Company-controlled future sale structures

Detect:

- ATM program
- equity line / SEPA
- from time to time
- may offer and sell
- company is not obligated to sell

Core rule:

- company has capacity to sell later
- that is not the same as same-day live dilution

Prefer:

- `Dilution: Undetermined`
- `Earliest: Company sales start`

### 6. Secondary / selling-holder structures

This should be included in phase 1 because it prevents some of the worst false positives.

Detect:

- selling shareholder
- company not selling shares
- company will not receive proceeds
- secondary offering
- concurrent repurchase

Core rule:

- do not treat these like ordinary primary company dilution events

Phase 1 can keep this simple:

- tag the structure internally
- avoid forcing normal company-dilution logic too early

## Phase 1 Internal Fields

Only add a small field set at first.

Recommended fields:

- `transactionStage`
- `earliestKnownDate`
- `needsClosing`
- `needsAnotherFiling`
- `needsEffectiveness`
- `needsShareholderApproval`
- `hasMixedImmediateAndFutureSupply`
- `isCompanyControlledFutureSales`
- `isSecondaryOffering`
- `isSellingShareholderOnly`
- `hasConcurrentRepurchase`

Optional if easy:

- `isPrivatePlacement`
- `hasResaleRestriction`

Do **not** add a huge field tree in phase 1.

## Phase 1 Reason Codes

Keep the first reason-code set small.

Recommended timing reason codes:

- `proposed_offering_only`
- `launched_not_priced`
- `priced_not_closed`
- `close_expected_future_date`
- `closing_date_missing`
- `closed_common_issued`
- `needs_another_filing`
- `needs_sec_effectiveness`
- `shareholder_approval_needed`
- `company_sale_activation_needed`
- `mixed_immediate_and_future_supply`
- `date_unknown`

Recommended structure reason codes:

- `private_placement_with_resale_rights`
- `secondary_offering_selling_shareholder`
- `concurrent_share_repurchase`

Do **not** implement the whole long list yet.

## What To Delay Until Later

These are useful, but not phase-1 critical:

- detailed rights-offering subtype modeling
- detailed IPO / fund IPO family handling beyond early exclusion
- debt / notes nuance beyond early exclusion
- cross-border approval nuance
- every warrant subtype
- every blocker subtype
- every synthetic secondary subtype

If we build too much of that now, maintenance will sprawl.

## File Ownership

### Main logic file

- [pressReleaseFinancing.js](</c:/Users/jerac/Documents/TraderLink/playwright/projects/press_release_levels_v2/lib/pressReleaseFinancing.js:1>)

Put most new phase-1 extraction and reason-code logic here.

### Collapse internal facts into the short card

- [ai.js](</c:/Users/jerac/Documents/TraderLink/playwright/projects/press_release_levels_v2/lib/ai.js:1>)

Use this layer to translate richer internal facts into:

- `Immediate`
- `Delayed`
- `Undetermined`

and the short `Earliest: ...` line.

### Prompt adjustments only where necessary

- [prompts.js](</c:/Users/jerac/Documents/TraderLink/playwright/projects/press_release_levels_v2/lib/prompts.js:1>)

Only add prompt guidance that helps AI extract the phase-1 fields more reliably.

Do not put heavy business logic here.

### Do not spread timing logic everywhere

Keep:

- [pipeline.js](</c:/Users/jerac/Documents/TraderLink/playwright/projects/press_release_levels_v2/lib/pipeline.js:1>)
- [liveBot.js](</c:/Users/jerac/Documents/TraderLink/playwright/projects/press_release_levels_v2/lib/liveBot.js:1>)

mostly operational.

## Example Desired Outcomes

### Proposed offering

Likely:

- `Dilution: Undetermined`
- `Earliest: Date unknown`

### Priced offering with future close

Likely:

- `Dilution: Delayed`
- `Earliest: Mar 20 close`

### Private placement closing soon, resale filing still needed

Likely:

- `Dilution: Undetermined`
- `Earliest: Another filing needed`

or, if the close date is very clear but public sellability still is not:

- `Dilution: Delayed`
- `Earliest: Mar 20 close`

with internal reason code still recording the resale step.

### ATM / company-controlled sales facility

Likely:

- `Dilution: Undetermined`
- `Earliest: Company sales start`

### Selling-holder secondary with concurrent repurchase

Likely:

- do not force ordinary company-dilution treatment
- preserve the special structure internally first

## Phase 1 Success Test

Phase 1 is successful if the system gets better at:

1. not calling proposal-stage PRs too certain
2. not calling priced-but-not-closed PRs immediate
3. not collapsing private placement close timing into public sellability
4. not flattening mixed common + warrant structures
5. not treating secondary / selling-holder / concurrent repurchase structures like ordinary primary dilution

## Bottom Line

Phase 1 should be:

- richer internally
- still short externally
- clearly bounded
- easy to maintain

That means:

- small field set
- small reason-code set
- strongest timing distinctions first
- no giant taxonomy yet
