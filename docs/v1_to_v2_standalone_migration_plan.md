# V1 to V2 Standalone Migration Plan

## Goal

Make `press_release_levels_v2` the only live press-release/SEC posting system and remove its dependency on the older `levels/press_release_levels.js` process.

V2 should own:

- Discord host-channel intake
- Nuntio article fetching
- SEC filing fetching and document selection
- Article cache reads/writes
- AI summarization
- Discord posting
- Review/audit/rerun tooling

## Current State

The older v1 script at:

```text
C:\Users\jerac\Documents\TraderLink\playwright\levels\press_release_levels.js
```

fetches Nuntio articles directly and writes article text into v2's cache folder:

```text
projects\press_release_levels_v2\cache\article_fetch
```

V2 currently has this local config:

```env
ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS="news.nuntiobot.com"
ARTICLE_SHARED_CACHE_WAIT_MS="30000"
```

Because of that, v2 treats `news.nuntiobot.com` as a read-only shared-cache source:

1. Check local cache.
2. If missing, wait for another process to write it.
3. Use the shared cached article if v1 writes it.
4. If nobody writes it, fail/fallback.

This creates lag and makes v2 dependent on v1.

## Migration Steps

1. Stop running v1 during a controlled test window.

2. Change v2 config so Nuntio is no longer read-only:

```env
ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS=""
ARTICLE_SHARED_CACHE_WAIT_MS="0"
```

3. Change v2 defaults in code/example env so standalone mode is the default.

4. Confirm v2 direct-fetches a fresh Nuntio URL:

- Expected: no `Waiting up to ... for shared article cache`
- Expected: no `Using shared cached article text after wait`
- Expected selection kind: `direct_fetch`
- Expected article source mode: `fetched_direct`

5. Keep v2's own local cache enabled.

It is still good for repeated URLs and duplicate prevention. The key difference is ownership: v2 should write cache entries itself instead of waiting on v1.

6. Audit the first session after switching:

```powershell
node .\daily_ingest_audit.js --since YYYY-MM-DD
```

Watch:

- `news.nuntiobot.com / fetched_direct`
- fallback counts
- slowest posts
- headline-only fallback count
- article source modes

7. Leave v1 files in place temporarily, but do not run them.

After v2 has survived several live sessions, archive v1 with a note that it is historical only.

## Rollback

If direct Nuntio fetching creates cooldown/rate-limit problems:

1. Put `news.nuntiobot.com` back into `ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS`.
2. Restart v1 as the fetch/cache worker.
3. Re-run the audit to compare fallback and latency.

## Done Criteria

- V2 runs alone without v1.
- Fresh Nuntio posts no longer wait for shared cache.
- V2 writes its own cache entries.
- Posted items retain `article_source_mode = fetched_direct` for successful Nuntio fetches.
- Daily audit shows acceptable fallback/latency numbers.
