# Newsfilter request spacing

Owner requested that concurrent Newsfilter article requests wait a random 5–8 seconds between requests.

Status: implementation complete locally; runtime activation pending coordinator sequencing under the existing app recovery boundary.

- One process-wide queue covers Newsfilter public pages and the optional content API across the app's watchers.
- The first request starts immediately. Each completed or failed request sets a fresh random 5,000–8,000 ms cooldown before another request can start. Idle time counts toward that cooldown.
- Requests remain serialized until response text is read or the HTTP request fails. Failure releases the queue.
- Cache hits do not make network requests or consume queue slots. Other sources keep their existing behavior.
- Scope is one Node process; separately launched recovery tools do not share this in-memory queue.
- Validation: source review and Node syntax check only; no tests or live requests run.
- Existing local Newsfilter API retrieval and publishing changes were preserved. No runtime reload or hosted action performed.
