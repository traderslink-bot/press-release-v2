# moomoo Community Local Posting Automator

Local Playwright automator for one conservative moomoo Community post at a time from `moomoo/posts.json`.

## Safety Defaults

- Uses a dedicated persistent Chrome profile in `moomoo/.chrome-profile/`.
- Does not automate usernames, passwords, CAPTCHA, MFA, suspicious-login checks, or account security prompts.
- Refuses to silently fall back to another browser profile when the dedicated profile is locked.
- `npm run moomoo:dry-run` fills the next due draft and finds the final post button, but does not click it.
- `npm run moomoo:post-next` and `npm run moomoo:run-once` refuse to submit unless you pass `-- --confirm-post` or set `MOOMOO_ALLOW_POST=YES`.
- `npm run moomoo:live-worker` refuses to post until `MOOMOO_LIVE_APPROVED=YES` is set or `moomoo/LIVE_APPROVED.local` exists after dry-run review.
- Actual posts are globally rate-limited by `MOOMOO_MIN_POST_INTERVAL_MS`, defaulting to 2 minutes.
- Set `MOOMOO_POST_COMMENT_ENABLED=YES` to add the standard TradersLink group comment after a confirmed post. The default is off; when enabled, the automator records the post URL and comment result and will not submit a duplicate when the same comment is already visible.
- Create `moomoo/KILL_SWITCH` or set `MOOMOO_KILL_SWITCH=1` to stop before opening moomoo.
- Logs, screenshots, and traces are written under `moomoo/logs/`, `moomoo/screenshots/`, and `moomoo/traces/`.

## Queue Format

`moomoo/posts.json` is a JSON array:

```json
[
  {
    "id": "unique-source-event-id",
    "ticker": "AAPL",
    "title": "Article title",
    "summary": "A.I. article summary",
    "message": "$AAPL Article title\n\nA.I. article summary",
    "scheduledAt": "2026-07-03T14:03:00.000Z",
    "source": "press_release_v2",
    "status": "pending",
    "postedAt": "",
    "error": ""
  }
]
```

The pipeline helper builds:

```text
$TICKER Title

A.I. article summary
```

Long title/summary combinations are truncated to the configured `MOOMOO_MAX_LENGTH` and returned with truncation metadata so the pipeline logs it instead of failing the whole item.

## Commands

```powershell
npm run moomoo:login-chrome
npm run moomoo:session-check
npm run moomoo:dry-run
npm run moomoo:post-next -- --confirm-post
npm run moomoo:run-once -- --confirm-post
npm run moomoo:live-worker
npm run moomoo:worker-status
npm run moomoo:qa
```

For first login, run:

```powershell
npm run moomoo:login-chrome
```

Complete login manually in the normal Chrome window, confirm moomoo Community is logged in, then close that Chrome window. Later Playwright commands reuse the same dedicated profile. If a security check appears, complete it manually through `moomoo:login-chrome`; the automator will not bypass it.

To check the saved session without using the queue or composing a post:

```powershell
npm run moomoo:session-check
```

## Live Worker

The worker filters to `source: "press_release_v2"`, skips stale live queue items older than `MOOMOO_LIVE_MAX_STALE_MS` (default 45 minutes), honors the 5 minute queue delay plus the 2 minute global post spacing rule, internally dry-runs the item, then posts only after live approval is enabled.

Live approval is intentionally separate from dry-run:

```powershell
$env:MOOMOO_LIVE_APPROVED = "YES"
npm run moomoo:live-worker
```

The worker status file is `moomoo/live-worker-status.json`. Check it with:

```powershell
npm run moomoo:worker-status
```

Expected states include `idle`, `cooldown`, `posting`, `failed`, `auth_required`, `profile_locked`, `not_approved`, and `stopped`.

## Pipeline Hook

The press-release pipeline queues moomoo drafts after a normal news-filtered Discord/news post succeeds, using the same source content as Stocktwits: ticker, article title, and A.I. summary. When autostart is enabled, a queued draft schedules a detached one-shot moomoo worker for that draft's `scheduledAt` time. The one-shot worker processes at most one due item, then exits.

Useful settings:

```powershell
$env:MOOMOO_QUEUE_ENABLED = "true"
$env:MOOMOO_QUEUE_DELAY_MS = "300000"
$env:MOOMOO_MAX_LENGTH = "900"
$env:MOOMOO_MIN_POST_INTERVAL_MS = "120000"
$env:MOOMOO_WORKER_POLL_MS = "60000"
$env:MOOMOO_WORKER_FAILURE_BACKOFF_MS = "300000"
$env:MOOMOO_LIVE_MAX_STALE_MS = "2700000"
$env:MOOMOO_AUTOSTART_WORKER_ENABLED = "true"
$env:MOOMOO_LIVE_APPROVED = "YES"
```

Queueing a draft never bypasses the safety gate. One-shot posting remains blocked unless `MOOMOO_LIVE_APPROVED=YES` is set or `moomoo/LIVE_APPROVED.local` exists after dry-run review. Set `MOOMOO_AUTOSTART_WORKER_ENABLED=false` to queue drafts without launching one-shot workers.

## Troubleshooting

If moomoo shows `Number of drafts reached the sync limit`, delete old moomoo drafts before live posting. Dry-run can still prove selectors, but live posting may fail or create confusing draft behavior while the account is at the draft limit.

## Manual Scheduled Articles

Manual articles use a separate queue source, `manual_article`, so they do not mix with the live press-release feed. Put draft files under:

```text
moomoo/manual-articles/articles/
```

Article files can be `.docx`, `.md`, or `.txt`. Create `moomoo/manual-articles/schedule.json` from `schedule.example.json`. For top-gainer posts, set `topGainers.enabled` to `true`; the manual scheduler waits until the preflight window before the post time, fetches the ranked table from `https://stockanalysis.com/markets/gainers/`, takes the top 3 symbols, queues the article, and launches a one-shot `manual_article` worker. If that page is temporarily unavailable or cannot be parsed, the post is skipped so stale ticker symbols are never used.

```bash
npm run moomoo:manual-queue
npm run moomoo:manual-scheduler
npm run moomoo:manual-tasks-preview
npm run moomoo:manual-install-tasks
npm run moomoo:manual-delete-tasks
npm run moomoo:manual-worker
```

`manual-queue` checks once and exits. `manual-scheduler` keeps checking every minute. The default preflight window is 10 minutes before `scheduledAt`; change it with `MOOMOO_MANUAL_ARTICLE_PREFLIGHT_MS`. The checked-in `top-gainers.example.json` file is only a development fixture; it is not used for live scheduled posts.

`manual-tasks-preview` reads `schedule.json` and prints the Windows scheduled tasks that would be created. `manual-install-tasks` creates one Windows Task Scheduler entry per article, starting at that article's `scheduledAt`. Each task runs `manual-queue` once; that resolves the top 3 gainers, queues the post, and schedules the one-shot `manual_article` worker.

## Desktop Batch Files

Convenience launchers are in `moomoo/desktop-batches/` and copied to `C:\Users\jerac\Desktop\Moomoo autoposter\`.

There is intentionally no one-click direct live post batch.
