# Newsfilter app delivery repair

## Owner correction: coordinator-sequenced local activation

The owner requires coordinator sequencing before any runtime reload or recovery command. This project runs on the owner's computer; it does not deploy its code to Railway.

Owner-corrected rule: publish a TradersLink article only when an AI summary was generated. When no AI summary exists, do not create a TradersLink article and send Discord directly to the original source URL.

Routing correction: valid host-server articles without an AI summary remain in their normal destination route. Discord shows only `Summary could not be generated.` and links directly to the original source. Activate only through the coordinator's local-runner sequence.

Owner authorized fixing retrieval and ensuring alerts sent to Discord also reach the app.

- Confirmed with the runtime HTTP client: Newsfilter returned HTTP 200 with a zero-byte body. A native fetch returned HTTP 429 directing automated clients to the API.
- No NEWSFILTER_API_KEY is configured. Full-text retrieval cannot be claimed restored without authorized content access.
- Added the documented Newsfilter article content API path when NEWSFILTER_API_KEY is configured, with credential-safe errors and caching.
- The prior fallback-app publishing behavior is superseded. No AI summary means no TradersLink article.
- Recovery accepts only records with article text and a completed AI `summary` operation; it cannot publish headline-only fallbacks.
- Completed: Node syntax checks of the three changed/new JavaScript files. No test suites run.
- Completed: 15 missing Discord delivery records from 12:30 UTC onward published to the app (13 distinct ticker articles). Original timestamps and route tags retained. QNTM and FEED each had two source routes.
- Completed: QNTM, FEED and EPOW public app article URLs returned HTTP 200 and contained the unavailable-analysis disclosure. A second recovery preview found zero remaining candidates in this interval.
- Completed: graceful reload requested at 12:43:20 UTC. At 12:45:00 UTC the new runner PID 12988 was logged in and all three watchers (Press Release, Market Cap and Scanner) were live. App delivery repair and the 8:30 batch recovery are complete.
- Full Newsfilter text/AI recovery remains pending an authorized NEWSFILTER_API_KEY. Optional API path is implemented but cannot be live-verified without credentials. No hosted code deployment is involved.

Recovery command: `node recover_missing_app_articles.js --date 2026-09-09 --after 2026-09-09T12:30:00Z --publish`.
Omit `--publish` to inspect remaining candidates. This script makes app publication calls only, not Discord or social posts.

API reference: https://developers.newsfilter.io/docs/article-content-render-api-overview.html
