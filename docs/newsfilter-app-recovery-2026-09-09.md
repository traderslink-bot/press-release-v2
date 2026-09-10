# Newsfilter app delivery repair

## Owner correction: coordinator-sequenced local activation

The owner requires coordinator sequencing before any runtime reload or recovery command. This project runs on the owner's computer; it does not deploy its code to Railway.

Owner-corrected rule: Discord and the app use the same post eligibility decision. Every post accepted for Discord is also published to the app; every filtered post, including PR Drop, goes to neither. Missing market cap never excludes an otherwise accepted item; the Platform publish API attempts Finnhub enrichment and accepts the item if enrichment is unavailable.

Routing correction: valid host-server articles without an AI summary remain in their normal app destination route with no summary, positives, or negatives. The app opens their direct source URL. Discord behavior remains unchanged. Activate only through the coordinator's local-runner sequence.

2026-09-10 investigation: BRNX, both TNON items, OMH, and ATER were detected and processed. The SEC items were incorrectly filtered before both delivery destinations, and the TNON Select News item reused a stale-skip result from another ticker sharing its source URL. SEC items from the accepted host route now pass the shared eligibility decision unless they are PR Drop or a posted duplicate, and stale market-cap skip rows are excluded from reusable analysis.

Owner authorized fixing retrieval and ensuring alerts sent to Discord also reach the app.

- Confirmed with the runtime HTTP client: Newsfilter returned HTTP 200 with a zero-byte body. A native fetch returned HTTP 429 directing automated clients to the API.
- No NEWSFILTER_API_KEY is configured. Full-text retrieval cannot be claimed restored without authorized content access.
- Added the documented Newsfilter article content API path when NEWSFILTER_API_KEY is configured, with credential-safe errors and caching.
- No-summary records are valid app items. Their app payload omits the summary, positives, and negatives and retains the original source URL.
- Completed: Node syntax checks of the three changed/new JavaScript files. No test suites run.
- Completed: 15 missing Discord delivery records from 12:30 UTC onward published to the app (13 distinct ticker articles). Original timestamps and route tags retained. QNTM and FEED each had two source routes.
- Completed: QNTM, FEED and EPOW public app article URLs returned HTTP 200 and contained the unavailable-analysis disclosure. A second recovery preview found zero remaining candidates in this interval.
- Completed: graceful reload requested at 12:43:20 UTC. At 12:45:00 UTC the new runner PID 12988 was logged in and all three watchers (Press Release, Market Cap and Scanner) were live. App delivery repair and the 8:30 batch recovery are complete.
- Full Newsfilter text/AI recovery remains pending an authorized NEWSFILTER_API_KEY. Optional API path is implemented but cannot be live-verified without credentials. No hosted code deployment is involved.

## September 10 app-loss correction

- Local implementation complete: Discord and app publication use the same eligibility decision; PR Drop and other filtered posts go to neither.
- Local implementation complete: stale market-cap skip rows cannot be reused as canonical AI analysis for a Select News item.
- Local implementation complete: if persistence/enqueueing throws, the watcher removes that message from its in-memory duplicate guards so the 10-second rescan can retry it instead of losing it until restart.
- Local implementation complete: no-summary payloads retain the source headline and URL and omit summary, positives, and negatives.
- Platform implementation complete: the publish API fills a missing market cap from Finnhub when available and never rejects an item because the lookup failed.
- Platform implementation complete: the `/press-releases` drawer hides unavailable AI sections and labels its source action `Open source article`.
- Diagnostic preview from 15:00 UTC found 13 historical app omissions, including all five examples supplied by the owner. The preview did not publish them, and the owner explicitly directed that they must not be recovered.
- Pending coordinator actions: preserve the narrow file allowlists, sequence the local runner reload, arrange the Platform GitHub/Railway release, and confirm `FINNHUB_API_KEY` exists in Railway. Do not run historical recovery for this correction.

API reference: https://developers.newsfilter.io/docs/article-content-render-api-overview.html
