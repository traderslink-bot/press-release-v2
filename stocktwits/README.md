# Stocktwits Local Posting Automator

Local Playwright automator for one conservative Stocktwits post at a time from the queue in `stocktwits/posts.json`.

## Safety Defaults

- Uses a persistent local Chrome profile in `stocktwits/.chrome-profile/`.
- Refuses to silently fall back to a different browser profile if that Chrome profile is locked, because the fallback profile is usually not logged in.
- Does not automate Google credentials, CAPTCHA, MFA, suspicious-login checks, or account security prompts.
- `npm run dry-run` fills the composer but does not click the final post button.
- `npm run post-next` and `npm run run-once` refuse to submit unless you pass `-- --confirm-post` or set `STOCKTWITS_ALLOW_POST=YES`.
- Posting also requires a recent successful dry-run for the same queue item.
- Actual posts are globally rate-limited by `STOCKTWITS_MIN_POST_INTERVAL_MS`, defaulting to 2 minutes between Stocktwits submissions.
- By default the automator opens the relevant Stocktwits symbol page, such as `/symbol/YSXT`. On symbol pages it strips the leading `$TICKER` from the typed composer text when `STOCKTWITS_SYMBOL_PAGE_AUTO_TAG=true`, because Stocktwits may auto-tag the symbol page context. Set `STOCKTWITS_POST_FROM_SYMBOL_PAGE=false` only if you intentionally want to test home-feed posting.
- Create `stocktwits/KILL_SWITCH` or set `STOCKTWITS_KILL_SWITCH=1` to stop before opening Stocktwits.
- Logs are written to `stocktwits/logs/`; screenshots are written to `stocktwits/screenshots/`.

## Queue Format

`stocktwits/posts.json` is a JSON array:

```json
[
  {
    "id": "unique-source-event-id",
    "ticker": "AAPL",
    "title": "Article title",
    "summary": "A.I. article summary",
    "message": "$AAPL Article title\n\nA.I. article summary",
    "sentiment": "",
    "scheduledAt": "2026-07-02T14:03:00.000Z",
    "status": "pending",
    "postedAt": "",
    "error": ""
  }
]
```

If `message` is omitted, the enqueue helper builds:

```text
$TICKER Title

Summary
```

## Commands

```powershell
npm run stocktwits:install-browser
npm run stocktwits:login-chrome
npm run stocktwits:session-check
npm run dry-run
npm run post-next -- --confirm-post
npm run run-once -- --confirm-post
npm run stocktwits:live-worker
npm run stocktwits:worker-status
```

For first login, run:

```powershell
npm run stocktwits:login-chrome
```

Complete Google OAuth manually in the normal Chrome window, confirm Stocktwits is logged in, then close that Chrome window. Later dry-runs reuse the same dedicated Chrome profile through Playwright. If Google shows an account security check again, complete it manually in normal Chrome; do not try to bypass it in Playwright.

If a dry run or live-worker attempt says the dedicated Stocktwits Chrome profile could not be opened, close every Stocktwits login/automation Chrome window and rerun the command after a few seconds. The app intentionally does not use `.playwright-profile/` as an automatic fallback because that creates the confusing case where your real Chrome session is logged in but the automator is not.

To check the saved Stocktwits session without using the queue or preparing a post, run:

```powershell
npm run stocktwits:session-check
```

That command opens Stocktwits with the dedicated profile, verifies that logged-out/security UI is not visible, then closes the browser.

## Enqueue With 3 Minute Delay

```powershell
npm run stocktwits:enqueue -- --id event-123 --ticker AAPL --title "Article title" --summary "A.I. article summary"
```

The default enqueue delay is 3 minutes. Override with:

```powershell
$env:STOCKTWITS_ENQUEUE_DELAY_MS = "180000"
```

The live press-release pipeline also queues a Stocktwits draft after a normal news-filtered Discord post succeeds. It writes the same queue format and uses:

```powershell
$env:STOCKTWITS_QUEUE_DELAY_MS = "180000"
$env:STOCKTWITS_QUEUE_ENABLED = "true"
$env:STOCKTWITS_AUTOSTART_WORKER_ENABLED = "true"
$env:STOCKTWITS_AUTOSTART_AUTH_COOLDOWN_MS = "120000"
$env:STOCKTWITS_MANUAL_REFRESH_URL = "https://stocktwits.com/"
$env:STOCKTWITS_AUTH_REFRESH_AUTO_RETRY = "true"
$env:STOCKTWITS_AUTH_REFRESH_RETRY_DELAY_MS = "3000"
$env:STOCKTWITS_AUTH_REFRESH_MAX_RETRY_DEPTH = "1"
$env:STOCKTWITS_MIN_POST_INTERVAL_MS = "120000"
```

Set `STOCKTWITS_QUEUE_ENABLED=false` to disable draft queueing without changing the browser automator. Set `STOCKTWITS_AUTOSTART_WORKER_ENABLED=false` to queue drafts without launching the poster.

In the normal press-release flow, a successfully queued draft schedules a detached one-shot Stocktwits worker for that draft's `scheduledAt` time. The one-shot worker processes at most one due item, then exits. This keeps Stocktwits closed while idle and avoids needing the Windows scheduled start/stop tasks for normal operation.

If Stocktwits shows a login or human/security check, the worker exits without posting and opens normal Chrome using the dedicated Stocktwits profile. After you manually complete the check and close that normal Chrome window, the helper starts one one-shot retry. Already scheduled one-shot launches pause briefly while `auth_required` is recent so multiple queued drafts do not keep opening challenged browser windows.

## Live Worker

After dry-run/live testing is complete, use the live worker to consume only normal live press-release queue items:

```powershell
npm run stocktwits:live-worker
```

The worker filters to `source: "press_release_v2"`, ignores backfill test rows, skips stale live queue items older than `STOCKTWITS_LIVE_MAX_STALE_MS` (default 45 minutes), honors the 3 minute queue delay plus the global post spacing rule, internally dry-runs the item, then posts it without per-item approval. It opens the persistent Stocktwits Chrome profile only when a due item is ready, then closes Chrome after the attempt to keep idle resource use low. In normal operation the press-release pipeline starts it with `--once` after queueing a fresh draft.

The queue file is protected by a local lock while drafts are appended or statuses are updated, so the press-release pipeline and live worker do not overwrite each other's `posts.json` changes. In live-worker mode, successful dry-run screenshots are disabled by default to reduce browser overhead; failure screenshots are still attempted.

The worker writes a local ignored status file at `stocktwits/live-worker-status.json`. Check it when you need a quick answer about whether the worker is `idle`, in `cooldown`, `posting`, `failed`, `auth_required`, `profile_locked`, or `stopped`:

```powershell
npm run stocktwits:worker-status
```

That command prints JSON with the lock PID, status PID, state, last error, current ticker, and whether the status looks stale.

## Desktop Batch Files

Convenience launchers are stored in `stocktwits/desktop-batches/` and can be copied to your Desktop. The current Desktop copy lives in `C:\Users\jerac\Desktop\ST autoposter\`.

- `Stocktwits Login Chrome.bat` opens the dedicated Chrome profile for manual Stocktwits/Google login checks.
- `Stocktwits Session Check.bat` verifies the saved Stocktwits session without using the queue or composing a post.
- `Stocktwits Dry Run.bat` fills the next due draft without submitting it.
- `Stocktwits Start Worker.bat` starts the live worker in the background and prints worker status.
- `Stocktwits Stop Worker.bat` stops only the Stocktwits live worker process and prints worker status.
- `Stocktwits Worker Status.bat` prints the worker status JSON.
- `Stocktwits QA Check.bat` runs the local QA checks.
- `Stocktwits Open Logs.bat`, `Stocktwits Open Queue.bat`, and `Stocktwits Open Folder.bat` open the common troubleshooting locations.

There is intentionally no one-click `post-next` batch file. Direct posting should stay behind the live worker rules or an explicit terminal command.

Useful live-worker settings:

```powershell
$env:STOCKTWITS_WORKER_POLL_MS = "60000"
$env:STOCKTWITS_WORKER_FAILURE_BACKOFF_MS = "300000"
$env:STOCKTWITS_LIVE_MAX_STALE_MS = "2700000"
$env:STOCKTWITS_SAVE_DRY_RUN_SCREENSHOTS = "false"
$env:STOCKTWITS_PAGE_SETTLE_DELAY_MIN_MS = "8000"
$env:STOCKTWITS_PAGE_SETTLE_DELAY_MAX_MS = "15000"
$env:STOCKTWITS_PRE_SUBMIT_DELAY_MIN_MS = "3000"
$env:STOCKTWITS_PRE_SUBMIT_DELAY_MAX_MS = "8000"
$env:STOCKTWITS_MIN_POST_INTERVAL_JITTER_MS = "45000"
```

`STOCKTWITS_ALLOW_BROWSER_FALLBACK=true` exists only as an emergency troubleshooting escape hatch. Leave it unset for normal use.

The page-settle and pre-submit delays make browser interaction more patient and less brittle after page load. They are not used to bypass security checks; if Stocktwits, Google, CAPTCHA, MFA, Cloudflare, or another security check appears, the worker does not bypass it. It stops with `state: "auth_required"` instead of retrying every few minutes and opens normal Chrome with the dedicated Stocktwits profile for manual refresh. Complete the check manually, close that Chrome window, then restart the worker.

If a manual Stocktwits Chrome window is still open and locking the dedicated profile, the worker stops with `state: "profile_locked"`. Close the manual Stocktwits Chrome window, then restart the worker.

## Controlled Backfill Batch

For one-time backfill testing, the batch runner processes only one source at a time. It dry-runs each item, then posts it only if the dry-run succeeds. It honors the same cooldown and stops on the first failure.

```powershell
npm run stocktwits:batch-test -- --confirm-batch --source press_release_v2_backfill_2026-07-02 --max 9
```

## Shared Browser Option

By default this launches one persistent Chrome profile only when the command runs. If the scanner later launches a Chromium instance with remote debugging enabled, set:

```powershell
$env:STOCKTWITS_CDP_ENDPOINT = "http://127.0.0.1:9222"
```

The automator will connect to that browser instead of launching a second local Chromium process. The current press-release scanner code does not appear to launch Playwright itself, so the default persistent profile is the practical first path.

## Task Scheduler Sketch

The normal setup does not require the Stocktwits Task Scheduler start/stop tasks; the press-release pipeline autostarts one-shot workers after queueing drafts. Only use a scheduled worker if you intentionally want a time-window process watching the queue:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"cd 'C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2'; `$env:STOCKTWITS_ALLOW_POST='YES'; npm run run-once`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "TradersLink Stocktwits Queue Once" -Action $action -Trigger $trigger -Description "Processes at most one due Stocktwits queue item per run."
```
