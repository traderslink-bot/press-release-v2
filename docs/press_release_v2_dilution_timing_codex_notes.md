# Press Release V2 Dilution Timing System Notes for Codex

## Goal

Keep the trader-facing card output very short and fast to read.

The card should stay something like:

- `Dilution: Immediate`
- `Dilution: Delayed`
- `Dilution: Undetermined`

With a short second line such as:

- `Earliest: Apr 17 close`
- `Earliest: After SEC effectiveness`
- `Earliest: Another filing needed`
- `Earliest: Date unknown`

The engine underneath should be more precise than the card.

The system should not rely only on one final label too early.

## Core Principle

Do not make the engine answer only:

- immediate
- delayed
- undetermined

Instead, first extract structured timing facts, then collapse them into the short trader-facing result.

This helps reduce bad calls in both directions:

- saying dilution cannot happen when it actually can
- saying dilution is immediate when it actually is delayed or conditional

## Liability / Confidence Principle

The system should stay real and useful for traders, but it should avoid overconfident hard negatives.

Important internal rule:

- `Undetermined` should mean the press release does not clearly support a stronger timing call
- `Undetermined` should not mean the parser simply failed

That means the system can still be conservative without becoming useless.

## Recommended Internal Extraction Fields

Add or strengthen internal fields like:

- `securityTypes`
- `transactionStage`
- `issuanceTrigger`
- `sellabilityTrigger`
- `triggerControl`
- `earliestKnownDate`
- `hasMixedImmediateAndFutureSupply`
- `needsAnotherFiling`
- `needsEffectiveness`
- `needsClosing`
- `needsShareholderApproval`
- `hasOwnershipBlocker`
- `hasResaleRestriction`
- `hasNoAssuranceLanguage`

These do not all need to be shown to traders.
They are internal facts used to decide the short card output.

## Recommended Internal Categories

### 1. Security Types

The system should detect which securities are involved:

- common stock
- pre-funded warrants
- common warrants
- preferred warrants
- convertible notes
- convertible preferred
- units
- ATM facility
- equity line / SEPA
- registered direct
- PIPE / private placement
- resale shelf / resale registration

### 2. Transaction Stage

The system should detect where the transaction stands:

- proposed only
- commenced
- priced
- signed
- expected to close
- closed
- effective
- resale enabled
- company can begin sales
- investor can begin exercise / conversion

### 3. Issuance Trigger

The system should identify what event creates actual issuance or dilution exposure:

- pricing
- closing
- issuance on signing
- SEC effectiveness
- company sale election
- investor exercise
- investor conversion
- milestone event
- stockholder approval
- exchange approval
- ownership blocker removal

### 4. Sellability Trigger

The system should separately identify what event makes the securities sellable into the market:

- already under effective registration statement
- needs resale registration filing
- needs SEC effectiveness
- needs prospectus supplement / final prospectus
- exempt private placement transfer restrictions still apply
- Rule 144 / holding period issue
- investor resale path unclear from PR

### 5. Trigger Control

The system should identify who controls the next supply step:

- company controlled
- investor controlled
- SEC controlled
- milestone / regulatory controlled
- approval controlled
- mixed control

This matters because "exists now" is not the same as "can hit the market now."

## Recommended Reason Codes

These can be internal only.

### Timing / Status Reason Codes

- `deal_not_priced`
- `proposed_offering_only`
- `priced_not_closed`
- `close_expected_future_date`
- `closing_date_missing`
- `closed_common_issued`
- `effective_registered_offering`
- `needs_registration_filing`
- `needs_sec_effectiveness`
- `needs_prospectus_step`
- `needs_resale_registration`
- `company_sale_activation_needed`
- `investor_exercise_optional`
- `investor_conversion_optional`
- `shareholder_approval_needed`
- `exchange_cap_limits_issuance`
- `beneficial_ownership_blocker`
- `milestone_triggered_future_exercise`
- `mixed_immediate_and_future_supply`
- `immediate_common_future_warrant_overhang`
- `date_unknown`
- `no_assurance_completion_language`

### Helpful Security Structure Tags

- `common_only`
- `common_plus_warrants`
- `common_or_prefunded`
- `private_placement_with_resale_rights`
- `registered_direct_with_concurrent_private_warrants`
- `atm_facility`
- `sepa_equity_line`
- `milestone_warrant_structure`
- `convertible_structure`

## Recommended Card Output Model

Keep the trader card short.

### Main line

- `Dilution: Immediate`
- `Dilution: Delayed`
- `Dilution: Undetermined`

### Second line

- `Earliest: Apr 17 close`
- `Earliest: After SEC effectiveness`
- `Earliest: Another filing needed`
- `Earliest: Date unknown`
- `Earliest: Company sales start`
- `Earliest: Holder exercise`
- `Earliest: FDA milestone`

### Optional small tags if useful

Only if they fit the card cleanly:

- `Mixed structure`
- `Warrants included`
- `Resale step needed`
- `Approval needed`
- `Ownership blocker`
- `Company-controlled sales`

## Important System Rule

Do not let one phrase force the entire conclusion too early.

Example:
A press release may include all of these at once:

- common stock sold now
- pre-funded warrants instead of common for some buyers
- additional warrants
- warrants immediately exercisable upon issuance
- private placement language
- resale registration commitment
- expected closing date
- no assurance warrants will be exercised

That is not one simple timing answer.

The engine should first break it apart into:

- what is issued at closing
- what only becomes relevant after exercise or conversion
- what is sellable under current registration language
- what still needs another filing, effectiveness, or approval step

Then reduce that to the short trader card.

## High Value Phrase Buckets to Detect

### A. Usually supports Delayed until close

- "expected to close on"
- "expected to close on or about"
- "closing is expected to occur on or about"
- "subject to customary closing conditions"
- "subject to the satisfaction of customary closing conditions"
- "at the closing"
- "upon closing"
- "following the closing"

### B. Usually supports Undetermined / incomplete

- "has commenced"
- "subject to market and other conditions"
- "no assurance as to whether or when the offering may be completed"
- "final terms will be disclosed"
- "the company intends to offer"
- "proposed public offering"

### C. Usually signals another filing / effectiveness step

- "have not been registered"
- "may not be offered or sold except pursuant to an effective registration statement or an applicable exemption"
- "agreed to file a registration statement"
- "agreed to file a resale registration statement"
- "registration rights agreement"
- "resale registration statement"
- "declared effective"
- "upon effectiveness"
- "after SEC effectiveness"
- "prospectus supplement"
- "final prospectus"

### D. Usually signals mixed immediate plus future supply

- "common stock or pre-funded warrants"
- "concurrent private placement"
- "accompanying warrants"
- "Series A warrants"
- "Series B warrants"
- "immediately exercisable upon issuance"
- "shares underlying the warrants"
- "potential additional gross proceeds if exercised"
- "no assurance the warrants will be exercised"

### E. Usually signals company-controlled future selling

- "at the market offering program"
- "from time to time"
- "may offer and sell"
- "sales, if any"
- "the company is not obligated to sell"
- "equity purchase agreement"
- "committed equity facility"
- "SEPA"
- "purchase notice"
- "draw down"

### F. Usually signals investor optionality or blockers

- "holder may exercise"
- "holder may convert"
- "at the option of the holder"
- "cashless exercise"
- "beneficial ownership limitation"
- "4.99%"
- "9.99%"
- "exchange cap"
- "shareholder approval"
- "stockholder approval"
- "authorized shares"

### G. Usually signals milestone-gated future supply

- "upon FDA approval"
- "following FDA approval"
- "public announcement of FDA approval"
- "milestone"
- "contingent on approval"
- "if stockholder approval is required"

## Key Design Recommendation

Keep the final trader-facing wording simple, but increase the precision of the internal extraction layer.

Good pattern:

1. AI reads the PR
2. AI extracts structured facts
3. Rule logic checks the facts
4. Final output is compressed into:
   - Immediate
   - Delayed
   - Undetermined
5. Short second line explains earliest known trigger or why timing is not yet clear

This is better than asking AI to jump directly from raw PR text to one final timing label.

## Examples of Desired Internal Handling

### Example 1: Priced public offering with future close date

Internal read:
- priced
- common stock
- expected to close Apr 17
- subject to customary closing conditions

Card:
- `Dilution: Delayed`
- `Earliest: Apr 17 close`

### Example 2: Proposed offering with no firm close date

Internal read:
- proposed only
- no final terms
- no firm close date
- no assurance completion language

Card:
- `Dilution: Undetermined`
- `Earliest: Date unknown`

### Example 3: Private placement with resale filing still needed

Internal read:
- issuance may occur at closing
- securities not registered
- resale registration statement will be filed
- effectiveness still matters for public resale

Card:
- `Dilution: Undetermined` or `Delayed` depending on structure
- `Earliest: Another filing needed`

### Example 4: Registered direct plus private placement warrants

Internal read:
- common or pre-funded at closing
- warrants also issued
- warrants immediately exercisable
- resale / registration still matters for some supply
- mixed immediate and future supply

Card:
- `Dilution: Delayed`
- `Earliest: Apr 16 close`
- optional tag: `Mixed structure`

### Example 5: ATM / company-controlled facility

Internal read:
- facility exists
- company may sell from time to time
- no proof same-day sales already began

Card:
- `Dilution: Undetermined`
- `Earliest: Company sales start`

## Practical Implementation Direction

Main repo files already appear to support this direction:

- `pressReleaseFinancing.js` should be the main structured extraction and timing-rules layer
- `prompts.js` should keep the AI prompt conservative and timing-focused
- `ai.js` should normalize output into final trader-facing behavior
- `pipeline.js` should carry the richer timing fields through operational flow
- `liveBot.js` should remain an operational handling layer, not the main timing logic layer

## Final Recommendation

Do not make the card more verbose.

Do make the internal timing logic more specific.

Best end state:

- traders still get a fast, short card
- the system is more real and more accurate underneath
- the system is less likely to make overconfident dilution timing calls
- `Undetermined` stays as the safety valve, but for the right reasons
