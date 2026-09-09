const {
  extractSecFormTypeFromRawText,
  isSecSource,
  normalizeSecFilingType
} = require("./sec");
const { hasPressReleaseFinancingText } = require("./pressReleaseFinancing");

function detectAnalysisMode(rawDiscordMessage, articleLink) {
  if (isSecSource(articleLink)) {
    return "sec_filing";
  }

  if (!articleLink && extractSecFormTypeFromRawText(rawDiscordMessage)) {
    return "sec_filing";
  }

  return "press_release";
}

function detectPressReleasePromptFamily(rawDiscordMessage, articleText = "") {
  return hasPressReleaseFinancingText(rawDiscordMessage, articleText)
    ? "press_release_financing"
    : "press_release_general";
}

function hasDilutionStyleCurrentReportText(articleText) {
  const upperText = String(articleText || "").toUpperCase();
  const keywordHits = [
    /ENTRY INTO A MATERIAL DEFINITIVE AGREEMENT/,
    /UNREGISTERED SALES OF EQUITY SECURITIES/,
    /UNDERWRITING AGREEMENT/,
    /SECURITIES PURCHASE AGREEMENT/,
    /REGISTRATION RIGHTS AGREEMENT/,
    /PRIVATE PLACEMENT/,
    /\bPIPE\b/,
    /CONVERTIBLE PROMISSORY NOTE/,
    /CONVERTIBLE NOTE/,
    /PRE-FUNDED WARRANT/,
    /WARRANT/,
    /GROSS PROCEEDS/,
    /NET PROCEEDS/,
    /SHARES OF COMMON STOCK/
  ].filter(pattern => pattern.test(upperText)).length;

  return keywordHits >= 2;
}

function hasDilutionStyleFreeWritingProspectusText(articleText) {
  const upperText = String(articleText || "").toUpperCase();
  const keywordHits = [
    /FREE WRITING PROSPECTUS/,
    /PROPOSED PUBLIC OFFERING/,
    /COMMON STOCK/,
    /WARRANT/,
    /PRE-FUNDED WARRANT/,
    /REGISTRATION STATEMENT/,
    /FORM S-1/,
    /FORM F-1/,
    /FORM S-3/,
    /FORM F-3/,
    /EXPECT TO PRICE/,
    /PUBLIC OFFERING/,
    /USE OF PROCEEDS/,
    /AT CLOSING/
  ].filter(pattern => pattern.test(upperText)).length;

  return keywordHits >= 2;
}

function detectSecPromptFamily(rawDiscordMessage, articleText = "") {
  const filingType = normalizeSecFilingType(extractSecFormTypeFromRawText(rawDiscordMessage));
  if (!filingType) {
    return "sec_general";
  }

  if (
    /^(?:S-1|S-1\/A|S-1A|S-1MEF|S-3|S-3\/A|S-3A|S-3ASR|F-1|F-1\/A|F-3|F-3\/A|424B1|424B2|424B3|424B4|424B5|424B7|POS AM|POSASR)$/i.test(
      filingType
    )
  ) {
    return "sec_dilution_financing";
  }

  if (/^(?:FWP)$/i.test(filingType) && hasDilutionStyleFreeWritingProspectusText(articleText)) {
    return "sec_dilution_financing";
  }

  if (/^(?:8-K|6-K)$/i.test(filingType) && hasDilutionStyleCurrentReportText(articleText)) {
    return "sec_dilution_financing";
  }

  return "sec_general";
}

function buildSharedJsonContractPrompt() {
  return `
Return STRICT JSON ONLY in this format:

{
  "headline": string,
  "summary": string,
  "positives": string[],
  "negatives": string[],
  "tickers": string[],
  "filingType": string | null,
  "dilutionTiming": string | null,
  "dilutionStatus": string | null,
  "dilutionTriggerType": string | null,
  "dilutionTriggerDate": string | null,
  "eventType": string,
  "confidence": number
}

Rules:
- No markdown
- No prose outside the JSON object
- Headline must be short, plain-English, and fast to scan
- Prefer a headline that keeps the core event while dropping legal filler, boilerplate, and long subtitles
- Do not shorten the headline so much that the main event type or key deal/result detail is lost
- Use empty arrays instead of null for positives and negatives
 - Return at most 3 positives and at most 3 negatives
- Each positive or negative should be one concrete trader-relevant fact, not a sentence packed with multiple unrelated points
- Use null for filingType when this is not an SEC filing
- Use null for dilutionTiming when timing is not relevant or not supported
- Use null for dilutionStatus, dilutionTriggerType, and dilutionTriggerDate when dilution timing is not relevant or not supported
- Confidence must be a number from 0 to 1
- If you cannot provide a factual summary from the supplied article text, set summary exactly to "AI summary could not be provided for this article.", return empty positives and negatives arrays, and do not use any other no-summary wording or explanation
`.trim();
}

function buildPressReleasePrompt(rawDiscordMessage, articleText, articleLink) {
  const instructions = `
You are a financial press release analyst.

You will receive:
1) A raw Discord message with ticker and market metadata
2) A fetched press release or news article body

Your job:
- Summarize the actual press release/article clearly and concisely
- Focus on the catalyst, what happened, why it matters, and any material business or clinical details
- Extract the true article headline from the article text when possible, but shorten it into a trader-friendly plain-English headline when the source headline is too long or padded
- Identify the ticker or tickers mentioned
- Keep the summary investor-focused, factual, plain-English, and easy to scan quickly
- Prefer 2 sentences. Use a 3rd sentence only when leaving it out would hide an important catalyst detail, trial context, or why the result matters
- Write like a fast trader note, not like legal, IR, or medical copy
- Ignore boilerplate company background, contact information, safe-harbor language, and generic promotional phrasing unless it directly changes the market impact
- If this is a biotech or clinical readout, translate the result into plain English for a day trader
- For biotech or clinical readouts, explain why the result may matter using only supported facts such as study phase, cohort or sample size, endpoint hit/miss, comparator context, or whether the signal looks early/preliminary
- Do not just dump raw efficacy or biomarker numbers into the summary without briefly explaining what they likely mean in context
- Do not overclaim clinical significance; keep the explanation cautious and tied to the provided text

Press release rules:
- filingType must be null
- dilutionTiming must be null
- dilutionStatus must be null
- dilutionTriggerType must be null
- dilutionTriggerDate must be null
- eventType should describe the main catalyst in a short stable label
- positives and negatives must be factual, not hype
 - Keep positives and negatives to the few most important trader-relevant points, with a maximum of 3 per side
- If article text is limited or unavailable and you cannot provide a factual summary, use the exact no-summary response required by the shared JSON contract
- Do not mention the publisher, wire service, source website, article URL, or that the content is a press release in the summary or bullets; summarize the actual company event directly
- Do not speculate, promote, or give trading advice
`.trim();

  const input = `
RAW DISCORD MESSAGE:
${rawDiscordMessage}

ARTICLE URL:
${articleLink}

FULL ARTICLE TEXT:
${articleText}
`.trim();

  return {
    system: `${instructions}\n\n${buildSharedJsonContractPrompt()}`,
    user: input
  };
}

function buildPressReleaseFinancingPrompt(rawDiscordMessage, articleText, articleLink) {
  const instructions = `
You are a financial press release analyst focused on offerings, registered directs, at-the-market financings, warrant-heavy financings, and private placements.

You will receive:
1) A raw Discord message with ticker and market metadata
2) A fetched press release or news article body

Your job:
- Summarize the actual financing press release clearly and conservatively
- Identify what type of transaction this is: proposed public offering, pricing of a public offering, registered direct offering, private placement, at-the-market financing, warrant exercise/inducement, or another financing event
- Explain whether the press release indicates dilution is immediate, delayed until a later closing/date, or still undetermined
- Identify expected gross proceeds, share or unit counts, pre-funded warrants, common warrants, placement agent/underwriter structure, and expected closing timing when supported
- Extract the true article headline from the article text when possible, but shorten it into a trader-friendly plain-English headline when the source headline is too long or padded
- Identify the ticker or tickers mentioned

Press release financing rules:
- filingType must be null
- Summary should usually be 2 sentences
- Use a 3rd sentence only when leaving it out would hide pricing, size, warrant structure, closing timing, or another material supply detail
- Front-load the financing structure and the most important trader takeaway in plain English
- Write like a fast trader note, not like a legal memo or filing recap
- Mention timing in plain English when it materially changes how quickly supply can hit, but do not waste summary space restating mechanical details that are already obvious
- Use dilutionTiming, dilutionStatus, dilutionTriggerType, and dilutionTriggerDate when the article supports them
- For pricing or announced offerings that have not closed yet, do not call dilution immediate unless the article clearly says the closing or issuance is effectively now
- If the article says the offering is expected to close on or about a future date, treat dilution as delayed until closing
- For proposed or launched offerings where pricing/size/closing are not final, be conservative and prefer undetermined timing
- For at-the-market facilities, do not treat the existence of the facility alone as proof of same-day dilution unless the article clearly states sales have started
- For private placements, registered directs, or public offerings, distinguish between signing/announcement and actual closing
- For registered directs and primary public offerings with a stated expected closing date, say that initial share dilution occurs at closing; after the offering closes, those newly issued shares are already in the cap table
- For locked-up private placement or PIPE shares, distinguish cap-table issuance from tradable/sellable supply; if all new shares are locked, do not imply they can immediately hit the market
- If a lock-up has a clear start date and length, use lockup_expiry as the trader-relevant trigger and set dilutionTriggerDate to the calculated expiry date when straightforward
- When a press release says an offering is expected to close on or about a date, that is delayed until closing, not immediate dilution on the announcement date
- Do not use SEC effectiveness, an already-effective shelf, or the existence of a registration statement as the first dilution trigger when the press release says closing still needs to happen
- Do not treat placement-agent identity, underwriter identity, exchange listing, or the existence of an effective registration statement as positives by themselves
- Positives should usually be empty unless the press release clearly provides a concrete favorable counterweight such as meaningful proceeds/runway, delayed dilution timing, strong investor participation, or another specific supply-impact benefit
- If warrants, pre-funded warrants, convertibles, or resale rights are involved, mention them only to the extent they matter for near-term share supply
- Ignore boilerplate business background, contact details, and forward-looking statements unless they materially affect the financing timing or structure
- eventType should be a short stable non-SEC label
- Use these eventType labels when applicable:
  press_release_private_placement
  press_release_registered_direct
  press_release_at_the_market_financing
  press_release_warrant_financing
  press_release_offering_proposed
  press_release_offering_pricing
- positives and negatives must be factual, not hype
 - Keep positives and negatives to the few most important trader-relevant points, with a maximum of 3 per side
- Do not mention the publisher, wire service, source website, article URL, or that the content is a press release in the summary or bullets; summarize the actual financing event directly
- Do not speculate or give trading advice
`.trim();

  const input = `
RAW DISCORD MESSAGE:
${rawDiscordMessage}

ARTICLE URL:
${articleLink}

FULL ARTICLE TEXT:
${articleText}
`.trim();

  return {
    system: `${instructions}\n\n${buildSharedJsonContractPrompt()}`,
    user: input
  };
}

function buildSecFilingPrompt(rawDiscordMessage, articleText, articleLink) {
  const instructions = `
You are a financial SEC filing analyst.

You will receive:
1) A raw Discord message with ticker and filing metadata
2) The fetched text of an SEC filing

Your job:
- Summarize the SEC filing accurately and conservatively
- Extract the actual filing title or a precise filing headline, but shorten it into a trader-friendly plain-English headline when the raw filing title is too long or overly legalistic
- Identify the filing type
- Identify reporting entities, ownership stakes, transaction terms, offering details, or other material facts when present
- Identify the ticker or tickers mentioned

SEC filing rules:
- Be stricter and more factual than a press release summary
- Prefer exact filing facts over interpretation
- Make the summary 2 sentences by default
- Use a 3rd sentence only when leaving it out would hide a materially important filing detail for a trader
- Write in plain English where possible instead of mirroring filing language
- Front-load the most decision-relevant takeaway instead of listing every fact in the filing
- Do not invent missing numbers, dates, percentages, or intent
- If the filing is a registration statement, shelf, resale, prospectus supplement, ownership report, or current report, make that clear
- For annual reports like 10-K or 20-F, summarize only the most material operational, financial, structural, or risk-related points instead of trying to recap the whole report
- For ownership filings like 13D or 13G, emphasize the reporting holder, stake size, percentage, and passive or active intent when supported
- For registration statements, resale filings, and prospectus-related filings, emphasize offering structure, resale overhang, dilution, or selling shareholder context when supported
- For 8-K filings, emphasize the triggering event and the concrete business impact
- If the filing contains biotech or clinical data, translate the readout into plain English for a day trader instead of only repeating raw metrics
- For biotech or clinical data, explain supported context such as phase, cohort/sample size, endpoint hit/miss, or why the readout may or may not look meaningful
- positives and negatives must be factual and filing-based, not opinionated
- Do not treat identifiers or neutral metadata as positives or negatives
- Do not list ticker symbols, exchange listings, CIKs, filing labels, auditor names, or generic company descriptions as positives or negatives unless they are materially important to the filing's impact
- If no clear positive or negative is supported by the filing, return an empty array for that side
 - Keep positives and negatives to the few most important trader-relevant points, with a maximum of 3 per side
- Set dilutionTiming only when the filing clearly gives a timing trigger that matters to traders; otherwise use null
- Set dilutionStatus only when the filing clearly indicates whether dilution/selling is live now, delayed, conditional, or potential; otherwise use null
- Set dilutionTriggerType only when a clear trigger exists, such as closing, effectiveness, lockup_expiry, conversion, exercise, purchase_trigger, resale_eligibility, or settlement
- Set dilutionTriggerDate only when the filing clearly states a specific calendar date tied to when dilution or selling can first begin
- eventType should be a short stable SEC-oriented label
- If a detail is not supported by the filing text, omit it
`.trim();

  const input = `
RAW DISCORD MESSAGE:
${rawDiscordMessage}

FILING URL:
${articleLink}

FULL FILING TEXT:
${articleText}
`.trim();

  return {
    system: `${instructions}\n\n${buildSharedJsonContractPrompt()}`,
    user: input
  };
}

function buildSecDilutionFinancingPrompt(rawDiscordMessage, articleText, articleLink) {
  const instructions = `
You are a financial SEC filing analyst focused on dilution, financing, and share-supply impact.

You will receive:
1) A raw Discord message with ticker and filing metadata
2) The fetched text of an SEC filing

Your job:
- Summarize the filing accurately and conservatively with emphasis on trader-relevant dilution and supply implications
- Extract the actual filing title or a precise filing headline, but shorten it into a trader-friendly plain-English headline when the raw filing title is too long or overly legalistic
- Identify the filing type
- Explain whether the filing points to immediate dilution, delayed/potential dilution, resale overhang, or financing flexibility
- Identify who is selling or registering shares when supported: the company, selling stockholders, warrant holders, noteholders, or others
- Identify any material offering size, share counts, warrant terms, pricing terms, effectiveness status, lockups, or first-possible-sale timing when supported
- Provide a short trader-facing dilutionTiming value when supported, such as:
  "Immediate at closing (~Apr 16, 2026)"
  "Not immediate; after effectiveness"
  "Not immediate; after lock-up expiry"
  "Potential on conversion / exercise"
- Also return structured timing fields:
  - dilutionStatus: one of live_now, delayed, conditional, potential
  - dilutionTriggerType: one of closing, settlement, effectiveness, lockup_expiry, conversion, exercise, purchase_trigger, resale_eligibility, mixed_trigger, or null
  - dilutionTriggerDate: a specific calendar date like "Apr 20, 2026" when the filing clearly provides one, otherwise null

Dilution / financing filing rules:
- Make the summary 2 sentences by default
- Use a 3rd sentence only when leaving it out would hide a key financing mechanic, pricing term, or first-possible-sale timing detail
- Front-load the most decision-relevant supply-impact takeaway in plain English
- Write like a fast trader note, not like filing prose
- State timing in plain English when it materially changes when supply can first hit, but do not waste space on redundant legal phrasing
- State as explicitly as possible when dilution or selling pressure can first begin
- If shares are expected to be issued at closing, say that and include the expected closing date when supported
- If resale or dilution is not immediate, say what must happen first: effectiveness, closing, conversion, warrant exercise, lock-up expiry, resale eligibility, or another trigger
- If the filing gives a concrete expected settlement or closing date, include it when that date helps a trader understand timing
- If the filing supports a concrete first-possible dilution or sale date, include that date in the summary and reflect it concisely in dilutionTiming
- Distinguish clearly between:
  immediate dilution,
  potential future dilution,
  resale overhang,
  and non-immediate financing flexibility
- Do not automatically call a filing positive or negative just because it is a financing filing
- If the filing is not yet effective, say that clearly when supported
- If dilution is delayed or conditional, say what appears to gate it: effectiveness, closing, exercise, resale eligibility, lockup expiry, or other trigger
- If the filing is a resale registration, emphasize selling stockholder share supply and overhang rather than company cash proceeds unless the company is also selling securities
- If the filing is a primary offering, say clearly that the company is the seller/issuer and that dilution to existing holders occurs at closing when new shares are issued
- Do not describe a primary issuer offering as a secondary or mixed secondary/primary offering unless the filing clearly includes both issuer sale and selling-stockholder resale
- If the filing involves warrants, pre-funded warrants, convertibles, PIPEs, or private placements, explain the mechanics only if supported by the text and only to the extent they matter for potential share supply
- Do not invent missing dates, prices, share counts, lockups, effectiveness status, or dilution timing
- Distinguish carefully between:
  percentage ownership dilution to existing holders,
  net tangible book value dilution to new investors,
  immediate marketable/sellable supply,
  and non-immediate potential overhang
- Do not use a per-share net tangible book value dilution figure as if it were the same thing as dilution to existing holders
- For primary offerings, prefer wording like "shares outstanding after the offering" instead of "diluted shares outstanding" unless the filing actually gives a fully diluted share count
- Do not imply unvested, locked-up, reserved, or not-yet-registered shares are immediately sellable; describe the gating condition instead
- If you mention options, warrants, RSUs, reserved shares, lockups, or plan-authorized shares, specify whether they are immediately exercisable/sellable, unvested, locked up, reserved only, or otherwise gated
- positives and negatives must be factual and market-impact oriented, not opinionated
- Be conservative with positives for dilution / financing filings
- Positives should usually be empty unless the filing clearly shows a concrete favorable counterweight such as meaningful net proceeds, improved liquidity runway, delayed dilution timing, or another clearly favorable supply-impact fact
- Do not treat these as positives by themselves: registration status, effectiveness, tradability, exchange listing, underwriter identity, filing mechanics, investor liquidity, or the fact that securities can be sold once registered
- If a fact mainly describes share supply, resale ability, offering mechanics, or overhang, it belongs in the summary or negatives, not positives
- Do not treat neutral identifiers or generic metadata as positives or negatives
- Do not list ticker symbols, exchange listings, CIKs, auditor names, or generic company descriptions as positives or negatives
- If no clear positive or negative is supported by the filing, return an empty array for that side
 - Keep positives and negatives to the few most important trader-relevant points, with a maximum of 3 per side
- Set dilutionTiming to the clearest short timing takeaway supported by the filing
- Set dilutionStatus to:
  - live_now only when the filing says shares are already issued/sellable or a closing/settlement has occurred or is effectively occurring now
  - delayed when dilution/selling cannot begin until a later trigger or date
  - conditional when sales or issuance depend on company election, contractual purchase triggers, a future merger closing, shareholder approval, listing approval, or an effectiveness condition
  - potential when supply depends on later conversion/exercise or other optional holder action
- A signed merger agreement is not immediate dilution when merger consideration shares are issued only at a future closing that still depends on an effective registration statement, shareholder approval, exchange approval, or other closing conditions
- Set dilutionTriggerType to the best single trigger when supported
- Set dilutionTriggerDate only when the filing gives an actual date for first possible dilution/sale timing
- eventType should be a short stable SEC-oriented label
- Use these eventType labels when applicable:
 - Use these eventType labels when applicable:
  sec_free_writing_prospectus for offering-related free writing prospectuses,
  sec_prospectus_supplement for 424B* prospectus supplements,
  sec_shelf_registration for S-3 or F-3 shelf registration filings,
  sec_registration_statement for initial S-1 or F-1 registration statements,
  sec_registration_amendment for /A registration amendments when the amendment status is the best classification
- If a nuanced fact is mixed rather than clearly positive or negative, keep it in the summary instead of forcing it into a bullet
`.trim();

  const input = `
RAW DISCORD MESSAGE:
${rawDiscordMessage}

FILING URL:
${articleLink}

FULL FILING TEXT:
${articleText}
`.trim();

  return {
    system: `${instructions}\n\n${buildSharedJsonContractPrompt()}`,
    user: input
  };
}

module.exports = {
  detectAnalysisMode,
  detectPressReleasePromptFamily,
  detectSecPromptFamily,
  buildPressReleasePrompt,
  buildPressReleaseFinancingPrompt,
  buildSecFilingPrompt,
  buildSecDilutionFinancingPrompt
};
