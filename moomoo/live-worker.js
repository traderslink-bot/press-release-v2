const {
  MOOMOO_DIR,
  DEFAULT_HISTORY_FILE,
  DEFAULT_MAX_LENGTH,
  DEFAULT_MIN_POST_INTERVAL_MS,
  cleanText,
  loadQueue,
  readHistory,
  resolveQueueFile,
  selectNextDuePost,
  markPostStatus,
  updateQueue,
  writeJsonFileAtomic
} = require("./queue");
const { openBrowser, run } = require("./automator");
const fs = require("fs");
const path = require("path");

const DEFAULT_SOURCE_FILTER = "press_release_v2";
const DEFAULT_POLL_MS = 60 * 1000;
const DEFAULT_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_MAX_STALE_MS = 45 * 60 * 1000;
const LOCK_FILE = path.join(MOOMOO_DIR, "live-worker.lock");
const STATUS_FILE = path.join(MOOMOO_DIR, "live-worker-status.json");
const APPROVAL_FILE = path.join(MOOMOO_DIR, "LIVE_APPROVED.local");
const KILL_SWITCH_FILE = path.join(MOOMOO_DIR, "KILL_SWITCH");
const workerStatus = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  state: "starting"
};
let preserveExitStatus = false;

function parseArgs(argv) {
  const args = {
    once: false,
    source: process.env.MOOMOO_SOURCE_FILTER || DEFAULT_SOURCE_FILTER,
    pollMs: Number(process.env.MOOMOO_WORKER_POLL_MS || DEFAULT_POLL_MS),
    failureBackoffMs: Number(process.env.MOOMOO_WORKER_FAILURE_BACKOFF_MS || DEFAULT_FAILURE_BACKOFF_MS),
    maxStaleMs: Number(process.env.MOOMOO_LIVE_MAX_STALE_MS || DEFAULT_MAX_STALE_MS)
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") {
      args.once = true;
    } else if (arg === "--source") {
      args.source = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--poll-ms") {
      args.pollMs = Number(argv[index + 1] || "");
      index += 1;
    } else if (arg === "--failure-backoff-ms") {
      args.failureBackoffMs = Number(argv[index + 1] || "");
      index += 1;
    } else if (arg === "--max-stale-ms") {
      args.maxStaleMs = Number(argv[index + 1] || "");
      index += 1;
    }
  }

  args.source = cleanText(args.source);
  if (!Number.isFinite(args.pollMs) || args.pollMs < 5000) args.pollMs = DEFAULT_POLL_MS;
  if (!Number.isFinite(args.failureBackoffMs) || args.failureBackoffMs < 30000) {
    args.failureBackoffMs = DEFAULT_FAILURE_BACKOFF_MS;
  }
  if (!Number.isFinite(args.maxStaleMs) || args.maxStaleMs < 0) args.maxStaleMs = DEFAULT_MAX_STALE_MS;
  return args;
}

function maxLength() {
  const value = Number(process.env.MOOMOO_MAX_LENGTH || DEFAULT_MAX_LENGTH);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_LENGTH;
}

function minPostIntervalMs() {
  const value = Number(process.env.MOOMOO_MIN_POST_INTERVAL_MS || DEFAULT_MIN_POST_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_POST_INTERVAL_MS;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString();
}

function log(message, data = null) {
  console.log(`[${timestamp()}] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

function writeStatus(patch = {}) {
  Object.assign(workerStatus, patch, {
    pid: process.pid,
    updatedAt: timestamp()
  });
  try {
    writeJsonFileAtomic(STATUS_FILE, workerStatus);
  } catch (err) {
    log("Unable to write MOOMOO live worker status file.", { error: err.message });
  }
}

function isLivePostingApproved() {
  return process.env.MOOMOO_LIVE_APPROVED === "YES" || fs.existsSync(APPROVAL_FILE);
}

function isKillSwitchActive() {
  return process.env.MOOMOO_KILL_SWITCH === "1" ||
    /^true$/i.test(process.env.MOOMOO_KILL_SWITCH || "") ||
    fs.existsSync(KILL_SWITCH_FILE);
}

function skipStoppedPost(id) {
  if (!id) return false;
  return updateQueue(resolveQueueFile(), rows => markPostStatus(rows, id, {
    status: "skipped",
    error: "Stopped by the Moomoo desktop stop control before posting.",
    postedAt: ""
  }));
}

function getQueueError(id) {
  const queueFile = resolveQueueFile();
  const rows = loadQueue(queueFile);
  const target = rows.find(row => cleanText(row?.id || "") === cleanText(id || ""));
  return cleanText(target?.error || "");
}

function isAuthRequiredError(errorText) {
  return /(login|logged-out|account controls|security|captcha|mfa|multi-factor|two-factor|suspicious|verify|continue with google)/i.test(cleanText(errorText || ""));
}

function isProfileLockedError(errorText) {
  return /could not open the dedicated MOOMOO chrome profile|profile lock|user data directory is already in use|chrome has not released the profile lock/i.test(cleanText(errorText || ""));
}

function markAuthRequired(sourceFilter, id, ticker, errorText) {
  preserveExitStatus = true;
  writeStatus({
    state: "auth_required",
    sourceFilter,
    currentId: id,
    currentTicker: ticker,
    nextCheckAt: "",
    nextAllowedAt: "",
    lastError: errorText || "MOOMOO login/security check required"
  });
}

function markProfileLocked(sourceFilter, id, ticker, errorText) {
  preserveExitStatus = true;
  writeStatus({
    state: "profile_locked",
    sourceFilter,
    currentId: id,
    currentTicker: ticker,
    nextCheckAt: "",
    nextAllowedAt: "",
    lastError: errorText || "Dedicated MOOMOO Chrome profile is locked by another Chrome window"
  });
}

function processIsRunning(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const existingPid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    if (processIsRunning(existingPid)) {
      throw new Error(`MOOMOO live worker is already running with PID ${existingPid}.`);
    }
    fs.unlinkSync(LOCK_FILE);
  }

  fs.writeFileSync(LOCK_FILE, `${process.pid}\n`, "utf8");
}

function releaseLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    const existingPid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    if (existingPid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {
    // Best-effort cleanup only.
  }
}

function pendingStatus(value) {
  const status = cleanText(value || "pending").toLowerCase();
  return !status || status === "pending" || status === "queued";
}

function scheduledAtMs(row) {
  const date = new Date(cleanText(row?.scheduledAt || ""));
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function cleanupStalePending(source, maxStaleMs) {
  if (!maxStaleMs) return 0;

  const queueFile = resolveQueueFile();
  const cutoffMs = Date.now() - maxStaleMs;

  return updateQueue(queueFile, rows => {
    let count = 0;
    for (const row of rows) {
      if (cleanText(row?.source || "") !== source || !pendingStatus(row?.status)) continue;
      const dueMs = scheduledAtMs(row);
      if (!Number.isFinite(dueMs) || dueMs >= cutoffMs) continue;
      if (markPostStatus(rows, row.id, {
        status: "skipped",
        error: `stale live MOOMOO queue item older than ${Math.round(maxStaleMs / 60000)} minutes`,
        postedAt: ""
      })) {
        count += 1;
      }
    }

    return count;
  });
}

function getSelection(sourceFilter) {
  const queueFile = resolveQueueFile();
  const rows = loadQueue(queueFile);
  const history = readHistory(DEFAULT_HISTORY_FILE);
  return {
    queueFile,
    selection: selectNextDuePost(rows, history, new Date(), {
      maxLength: maxLength(),
      minPostIntervalMs: minPostIntervalMs(),
      sourceFilter
    })
  };
}

async function resetPage(browser) {
  const oldPage = browser.page;
  const nextPage = await browser.context.newPage();
  browser.page = nextPage;
  await nextPage.bringToFront().catch(() => null);
  await oldPage.close().catch(() => null);
}

async function processOneDue(sourceFilter) {
  process.env.MOOMOO_SOURCE_FILTER = sourceFilter;

  if (isKillSwitchActive()) {
    writeStatus({
      state: "paused",
      sourceFilter,
      currentId: "",
      currentTicker: "",
      nextCheckAt: "",
      lastError: "Moomoo poster is paused by the desktop stop control."
    });
    return { posted: false, waitMs: null, paused: true };
  }

  const { selection } = getSelection(sourceFilter);
  if (!selection.post) {
    if (selection.cooldown?.active) {
      const waitMs = Math.min(selection.cooldown.remainingMs + 3000, DEFAULT_POLL_MS);
      writeStatus({
        state: "cooldown",
        sourceFilter,
        currentId: "",
        currentTicker: "",
        nextAllowedAt: selection.cooldown.nextAllowedAt,
        nextCheckAt: new Date(Date.now() + waitMs).toISOString(),
        lastError: ""
      });
      log("MOOMOO cooldown active; worker sleeping.", {
        sourceFilter,
        nextAllowedAt: selection.cooldown.nextAllowedAt,
        remainingSeconds: Math.ceil(selection.cooldown.remainingMs / 1000)
      });
      return { posted: false, waitMs, cooldown: true };
    }

    writeStatus({
      state: "idle",
      sourceFilter,
      currentId: "",
      currentTicker: "",
      nextCheckAt: new Date(Date.now() + DEFAULT_POLL_MS).toISOString(),
      lastError: ""
    });
    return { posted: false, waitMs: DEFAULT_POLL_MS, idle: true };
  }

  const ticker = selection.validation.ticker;
  const id = selection.validation.id;
  writeStatus({
    state: "posting",
    sourceFilter,
    currentId: id,
    currentTicker: ticker,
    nextCheckAt: "",
    lastError: ""
  });
  log(`Preparing live MOOMOO queue item: $${ticker}`, { id, sourceFilter });

  let browser;
  try {
    browser = await openBrowser();
  } catch (err) {
    if (isProfileLockedError(err.message)) {
      markProfileLocked(sourceFilter, id, ticker, err.message);
      log(`MOOMOO Chrome profile is locked for $${ticker}; stopping live worker until the manual MOOMOO Chrome window is closed.`, { id, reason: err.message });
      return { posted: false, waitMs: null, failed: true, profileLocked: true };
    }
    throw err;
  }
  try {
    const dryRunCode = await run("dry-run", { confirmPost: false, keepOpen: false, noDryRunGate: false }, { browser });
    if (dryRunCode !== 0) {
      const queueError = getQueueError(id);
      if (isAuthRequiredError(queueError)) {
        markAuthRequired(sourceFilter, id, ticker, queueError);
        log(`MOOMOO auth/security check required for $${ticker}; stopping live worker until manual login is refreshed.`, { id, reason: queueError });
        return { posted: false, waitMs: null, failed: true, authRequired: true };
      }
      writeStatus({
        state: "failed",
        sourceFilter,
        currentId: id,
        currentTicker: ticker,
        lastError: `dry-run failed with exit code ${dryRunCode}`
      });
      log(`Dry-run failed for $${ticker}; item was not posted.`, { id, dryRunCode });
      return { posted: false, waitMs: null, failed: true };
    }

    if (isKillSwitchActive()) {
      skipStoppedPost(id);
      writeStatus({
        state: "paused",
        sourceFilter,
        currentId: id,
        currentTicker: ticker,
        nextCheckAt: "",
        lastError: "Moomoo posting stopped after dry-run and before submit."
      });
      return { posted: false, waitMs: null, paused: true };
    }

    await resetPage(browser);
    const postCode = await run("post-next", { confirmPost: true, keepOpen: false, noDryRunGate: false }, { browser });
    if (postCode !== 0) {
      const queueError = getQueueError(id);
      if (isAuthRequiredError(queueError)) {
        markAuthRequired(sourceFilter, id, ticker, queueError);
        log(`MOOMOO auth/security check required for $${ticker}; stopping live worker until manual login is refreshed.`, { id, reason: queueError });
        return { posted: false, waitMs: null, failed: true, authRequired: true };
      }
      writeStatus({
        state: "failed",
        sourceFilter,
        currentId: id,
        currentTicker: ticker,
        lastError: `post-next failed with exit code ${postCode}`
      });
      log(`Live post failed for $${ticker}; local queue was not marked posted.`, { id, postCode });
      return { posted: false, waitMs: null, failed: true };
    }

    writeStatus({
      state: "posted",
      sourceFilter,
      currentId: "",
      currentTicker: "",
      lastPostedId: id,
      lastPostedTicker: ticker,
      lastPostedAt: timestamp(),
      nextCheckAt: new Date(Date.now() + 1000).toISOString(),
      lastError: ""
    });
    log(`Posted live MOOMOO queue item: $${ticker}`, { id });
    return { posted: true, waitMs: 1000 };
  } finally {
    await browser.close().catch(() => null);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.source) throw new Error("Live worker requires a source filter.");

  acquireLock();
  writeStatus({
    state: "starting",
    sourceFilter: args.source,
    pollMs: args.pollMs,
    failureBackoffMs: args.failureBackoffMs,
    maxStaleMs: args.maxStaleMs
  });
  process.once("exit", () => {
    if (!preserveExitStatus) writeStatus({ state: "stopped", stoppedAt: timestamp() });
    releaseLock();
  });
  process.once("SIGINT", () => {
    writeStatus({ state: "stopped", stoppedAt: timestamp(), signal: "SIGINT" });
    releaseLock();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    writeStatus({ state: "stopped", stoppedAt: timestamp(), signal: "SIGTERM" });
    releaseLock();
    process.exit(143);
  });

  process.env.MOOMOO_SOURCE_FILTER = args.source;
  if (!isLivePostingApproved()) {
    preserveExitStatus = true;
    writeStatus({
      state: "not_approved",
      sourceFilter: args.source,
      currentId: "",
      currentTicker: "",
      nextCheckAt: "",
      nextAllowedAt: "",
      lastError: "Live moomoo posting is blocked until you approve it after dry-run evidence. Set MOOMOO_LIVE_APPROVED=YES or create moomoo/LIVE_APPROVED.local."
    });
    log("moomoo live worker did not start posting because live approval has not been granted.", {
      approvalEnv: "MOOMOO_LIVE_APPROVED=YES",
      approvalFile: APPROVAL_FILE
    });
    return;
  }

  process.env.MOOMOO_ALLOW_POST = "YES";
  if (!process.env.MOOMOO_MANUAL_LOGIN_WAIT_MS) process.env.MOOMOO_MANUAL_LOGIN_WAIT_MS = "0";
  if (!process.env.MOOMOO_SAVE_DRY_RUN_SCREENSHOTS) process.env.MOOMOO_SAVE_DRY_RUN_SCREENSHOTS = "false";

  log("MOOMOO live worker started.", {
    sourceFilter: args.source,
    pollMs: args.pollMs,
    failureBackoffMs: args.failureBackoffMs,
    maxStaleMinutes: Math.round(args.maxStaleMs / 60000)
  });

  while (true) {
    const skipped = cleanupStalePending(args.source, args.maxStaleMs);
    if (skipped) log(`Skipped ${skipped} stale pending MOOMOO item(s).`, { sourceFilter: args.source });

    const result = await processOneDue(args.source).catch(err => {
      writeStatus({
        state: "failed",
        sourceFilter: args.source,
        lastError: err.message,
        nextCheckAt: new Date(Date.now() + args.failureBackoffMs).toISOString()
      });
      log("MOOMOO live worker iteration failed.", { error: err.message, stack: err.stack });
      return { posted: false, waitMs: null, failed: true };
    });

    if (args.once) {
      if (result.idle) log("No due live MOOMOO queue item found.", { sourceFilter: args.source });
      break;
    }
    if (result.authRequired) {
      log("MOOMOO live worker stopped for manual login/security refresh.", { sourceFilter: args.source });
      break;
    }
    if (result.profileLocked) {
      log("MOOMOO live worker stopped because the dedicated Chrome profile is locked.", { sourceFilter: args.source });
      break;
    }
    await sleep(result.waitMs ?? (result.failed ? args.failureBackoffMs : args.pollMs));
  }
}

main().catch(err => {
  console.error(`[${timestamp()}] [ERROR] ${err.message}`);
  process.exitCode = 1;
});
