const {
  STOCKTWITS_DIR,
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
const { spawn } = require("child_process");

const DEFAULT_SOURCE_FILTER = "press_release_v2";
const DEFAULT_POLL_MS = 60 * 1000;
const DEFAULT_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_MAX_STALE_MS = 45 * 60 * 1000;
const KILL_SWITCH_FILE = path.join(STOCKTWITS_DIR, "KILL_SWITCH");
const LOCK_FILE = path.join(STOCKTWITS_DIR, "live-worker.lock");
const STATUS_FILE = path.join(STOCKTWITS_DIR, "live-worker-status.json");
const workerStatus = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  state: "starting"
};
let preserveExitStatus = false;

function parseArgs(argv) {
  const args = {
    once: false,
    source: process.env.STOCKTWITS_SOURCE_FILTER || DEFAULT_SOURCE_FILTER,
    pollMs: Number(process.env.STOCKTWITS_WORKER_POLL_MS || DEFAULT_POLL_MS),
    failureBackoffMs: Number(process.env.STOCKTWITS_WORKER_FAILURE_BACKOFF_MS || DEFAULT_FAILURE_BACKOFF_MS),
    maxStaleMs: Number(process.env.STOCKTWITS_LIVE_MAX_STALE_MS || DEFAULT_MAX_STALE_MS)
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
  const value = Number(process.env.STOCKTWITS_MAX_LENGTH || DEFAULT_MAX_LENGTH);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_LENGTH;
}

function envNumber(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue == null || String(rawValue).trim() === "") return fallback;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : fallback;
}

function minPostIntervalMs() {
  const value = Number(process.env.STOCKTWITS_MIN_POST_INTERVAL_MS || DEFAULT_MIN_POST_INTERVAL_MS);
  const baseMs = Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_POST_INTERVAL_MS;
  const jitterMaxMs = Math.max(0, envNumber("STOCKTWITS_MIN_POST_INTERVAL_JITTER_MS", 45 * 1000));
  const jitterMs = jitterMaxMs > 0 ? Math.round(Math.random() * jitterMaxMs) : 0;
  return baseMs + jitterMs;
}

function isKillSwitchActive() {
  return (
    process.env.STOCKTWITS_KILL_SWITCH === "1" ||
    /^true$/i.test(process.env.STOCKTWITS_KILL_SWITCH || "") ||
    fs.existsSync(KILL_SWITCH_FILE)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
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
    log("Unable to write Stocktwits live worker status file.", { error: err.message });
  }
}

function getQueueError(id) {
  const queueFile = resolveQueueFile();
  const rows = loadQueue(queueFile);
  const target = rows.find(row => cleanText(row?.id || "") === cleanText(id || ""));
  return cleanText(target?.error || "");
}

function isAuthRequiredError(errorText) {
  return /(login|logged-out|account controls|security|captcha|mfa|multi-factor|two-factor|suspicious|verify|continue with google|not a bot|cloudflare)/i.test(cleanText(errorText || ""));
}

function isProfileLockedError(errorText) {
  return /could not open the dedicated stocktwits chrome profile|profile lock|user data directory is already in use|chrome has not released the profile lock/i.test(cleanText(errorText || ""));
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
    lastError: errorText || "Stocktwits login/security check required"
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
    lastError: errorText || "Dedicated Stocktwits Chrome profile is locked by another Chrome window"
  });
}

function openManualLoginChrome() {
  const scriptPath = path.join(STOCKTWITS_DIR, "auth-refresh-helper.js");
  try {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(STOCKTWITS_DIR),
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    log("Started Stocktwits manual login/security refresh helper.", { scriptPath, pid: child.pid });
  } catch (err) {
    log("Unable to start Stocktwits manual login/security refresh helper.", { error: err.message });
  }
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
      throw new Error(`Stocktwits live worker is already running with PID ${existingPid}.`);
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
        error: `stale live Stocktwits queue item older than ${Math.round(maxStaleMs / 60000)} minutes`,
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

async function processOneDue(sourceFilter) {
  process.env.STOCKTWITS_SOURCE_FILTER = sourceFilter;

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
      log("Stocktwits cooldown active; worker sleeping.", {
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
  log(`Preparing live Stocktwits queue item: $${ticker}`, { id, sourceFilter });

  let browser;
  try {
    browser = await openBrowser();
  } catch (err) {
    if (isProfileLockedError(err.message)) {
      markProfileLocked(sourceFilter, id, ticker, err.message);
      log(`Stocktwits Chrome profile is locked for $${ticker}; stopping live worker until the manual Stocktwits Chrome window is closed.`, { id, reason: err.message });
      return { posted: false, waitMs: null, failed: true, profileLocked: true };
    }
    throw err;
  }
  try {
    const itemTimeoutMs = envNumber("STOCKTWITS_WORKER_ITEM_TIMEOUT_MS", 2 * 60 * 1000);
    const postCode = await withTimeout(
      run("run-once", { confirmPost: true, keepOpen: false, noDryRunGate: true }, { browser }),
      itemTimeoutMs,
      `Stocktwits live item $${ticker}`
    );
    if (postCode !== 0) {
      const queueError = getQueueError(id);
      if (isAuthRequiredError(queueError)) {
        markAuthRequired(sourceFilter, id, ticker, queueError);
        log(`Stocktwits auth/security check required for $${ticker}; stopping live worker until manual login is refreshed.`, { id, reason: queueError });
        return { posted: false, waitMs: null, failed: true, authRequired: true };
      }
      writeStatus({
        state: "failed",
        sourceFilter,
        currentId: id,
        currentTicker: ticker,
        lastError: `run-once failed with exit code ${postCode}`
      });
      log(`Live run-once failed for $${ticker}; local queue was not marked posted.`, { id, postCode });
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
    log(`Posted live Stocktwits queue item: $${ticker}`, { id });
    return { posted: true, waitMs: 1000 };
  } finally {
    await browser.close().catch(() => null);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.source) throw new Error("Live worker requires a source filter.");

  if (isKillSwitchActive()) {
    writeStatus({
      state: "disabled",
      sourceFilter: args.source,
      currentId: "",
      currentTicker: "",
      nextCheckAt: "",
      nextAllowedAt: "",
      lastError: "Stocktwits kill switch active"
    });
    log("Stocktwits live worker disabled by kill switch; exiting before opening browser.", {
      killSwitchFile: KILL_SWITCH_FILE
    });
    return;
  }

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

  process.env.STOCKTWITS_SOURCE_FILTER = args.source;
  process.env.STOCKTWITS_ALLOW_POST = "YES";
  if (!process.env.STOCKTWITS_MANUAL_LOGIN_WAIT_MS) process.env.STOCKTWITS_MANUAL_LOGIN_WAIT_MS = "0";
  if (!process.env.STOCKTWITS_SAVE_DRY_RUN_SCREENSHOTS) process.env.STOCKTWITS_SAVE_DRY_RUN_SCREENSHOTS = "false";

  log("Stocktwits live worker started.", {
    sourceFilter: args.source,
    pollMs: args.pollMs,
    failureBackoffMs: args.failureBackoffMs,
    maxStaleMinutes: Math.round(args.maxStaleMs / 60000)
  });

  while (true) {
    const skipped = cleanupStalePending(args.source, args.maxStaleMs);
    if (skipped) log(`Skipped ${skipped} stale pending Stocktwits item(s).`, { sourceFilter: args.source });

    const result = await processOneDue(args.source).catch(err => {
      writeStatus({
        state: "failed",
        sourceFilter: args.source,
        lastError: err.message,
        nextCheckAt: new Date(Date.now() + args.failureBackoffMs).toISOString()
      });
      log("Stocktwits live worker iteration failed.", { error: err.message, stack: err.stack });
      return { posted: false, waitMs: null, failed: true };
    });

    if (result.authRequired) {
      log("Stocktwits live worker stopped for manual login/security refresh.", { sourceFilter: args.source });
      openManualLoginChrome();
      break;
    }
    if (result.profileLocked) {
      log("Stocktwits live worker stopped because the dedicated Chrome profile is locked.", { sourceFilter: args.source });
      break;
    }
    if (args.once) {
      if (result.idle) log("No due live Stocktwits queue item found.", { sourceFilter: args.source });
      break;
    }
    await sleep(result.waitMs ?? (result.failed ? args.failureBackoffMs : args.pollMs));
  }
}

main().catch(err => {
  console.error(`[${timestamp()}] [ERROR] ${err.message}`);
  process.exitCode = 1;
});
