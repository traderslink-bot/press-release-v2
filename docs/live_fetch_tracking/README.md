# Live Fetch Tracking

This folder is the review point for live article-fetch behavior.

Main runtime log:

- `live_events.jsonl`

That file is written automatically during live runs and records article-fetch events such as:

- direct fetch attempts
- direct fetch failures
- status codes by domain
- Nuntio cooldown events
- OpenAI URL fallback usage
- final article source resolution mode

Most useful values to watch:

- `hostname`
- `url`
- `kind`
- `status`
- `articleSourceMode`
- `directFetchError`
- `openaiUrlFallbackError`

Typical `articleSourceMode` values:

- `fetched_direct`
- `openai_url_fallback`
- `headline_only_fallback`
- `sec_unreadable_fallback`

This folder is intentionally inside `docs` so it is easy to inspect after market sessions, but the runtime `.jsonl` log is ignored by git.
