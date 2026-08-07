const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  ROOT_DIR,
  STOCKTWITS_DIR,
  cleanText,
  ensureDir,
  readJsonFile
} = require("./queue");

const LOCK_FILE = path.join(STOCKTWITS_DIR, "live-worker.lock");
const STATUS_FILE = path.join(STOCKTWITS_DIR, "live-worker-status.json");
const LOG_DIR = path.join(STOCKTWITS_DIR, "logs");
const AUTOSTART_LOG = path.join(LOG_DIR, "autostart.log");
const KILL_SWITCH_FILE = path.join(STOCKTWITS_DIR, "KILL_SWITCH");
const scheduledIds = new Set();

function timestamp() {
  return new Date().toISOString();
}

function log(message, data = null) {
  ensureDir(LOG_DIR);
  const line = `[${timestamp()}] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`;
  fs.appendFileSync(AUTOSTART_LOG, `${line}\n`, "utf8");
  console.log(`[STOCKTWITS_AUTOSTART] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

function isAutostartEnabled() {
  return !/^false$/i.test(process.env.STOCKTWITS_AUTOSTART_WORKER_ENABLED || "true");
}

function isKillSwitchActive() {
  return (
    process.env.STOCKTWITS_KILL_SWITCH === "1" ||
    /^true$/i.test(process.env.STOCKTWITS_KILL_SWITCH || "") ||
    fs.existsSync(KILL_SWITCH_FILE)
  );
}

function authCooldownMs() {
  const value = Number(process.env.STOCKTWITS_AUTOSTART_AUTH_COOLDOWN_MS || 2 * 60 * 1000);
  return Number.isFinite(value) && value >= 0 ? value : 2 * 60 * 1000;
}

function recentAuthRequiredStatus() {
  const cooldownMs = authCooldownMs();
  if (!cooldownMs) return null;

  const status = readJsonFile(STATUS_FILE, null);
  if (cleanText(status?.state || "") !== "auth_required") return null;

  const updatedAtMs = new Date(cleanText(status?.updatedAt || "")).getTime();
  if (!Number.isFinite(updatedAtMs)) return null;

  const ageMs = Date.now() - updatedAtMs;
  if (ageMs < 0 || ageMs > cooldownMs) return null;
  return {
    state: status.state,
    currentId: cleanText(status.currentId || ""),
    currentTicker: cleanText(status.currentTicker || ""),
    lastError: cleanText(status.lastError || ""),
    updatedAt: status.updatedAt,
    remainingMs: cooldownMs - ageMs
  };
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

function readLockPid() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return null;
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function stocktwitsWorkerIsRunning() {
  const lockPid = readLockPid();
  return Boolean(lockPid && processIsRunning(lockPid));
}

function openAppendFd(filePath) {
  ensureDir(path.dirname(filePath));
  return fs.openSync(filePath, "a");
}

function startStocktwitsOneShotWorker(reason = {}) {
  if (isKillSwitchActive()) {
    log("Kill switch active; one-shot worker not launched.", reason);
    return { ok: false, skipped: true, reason: "kill switch active" };
  }

  if (!isAutostartEnabled()) {
    log("Autostart disabled; one-shot worker not launched.", reason);
    return { ok: false, skipped: true, reason: "autostart disabled" };
  }

  const authCooldown = recentAuthRequiredStatus();
  if (authCooldown) {
    log("Recent Stocktwits auth/security checkpoint is active; one-shot worker not launched.", {
      ...reason,
      authCooldown
    });
    return { ok: true, skipped: true, reason: "auth/security checkpoint cooldown", authCooldown };
  }

  if (stocktwitsWorkerIsRunning()) {
    log("Live worker already running; one-shot worker not launched.", reason);
    return { ok: true, skipped: true, reason: "worker already running" };
  }

  const outFd = openAppendFd(path.join(LOG_DIR, "live-worker.out.log"));
  const errFd = openAppendFd(path.join(LOG_DIR, "live-worker.err.log"));
  try {
    const child = spawn(process.execPath, [path.join(STOCKTWITS_DIR, "live-worker.js"), "--once"], {
      cwd: ROOT_DIR,
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        STOCKTWITS_SOURCE_FILTER: process.env.STOCKTWITS_SOURCE_FILTER || "press_release_v2"
      },
      stdio: ["ignore", outFd, errFd]
    });
    child.unref();
    log("Started one-shot Stocktwits worker.", { ...reason, pid: child.pid });
    return { ok: true, pid: child.pid };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

function scheduleStocktwitsOneShotWorkerForDraft(result) {
  if (!result?.ok) return { ok: false, skipped: true, reason: "draft not queued" };
  if (isKillSwitchActive()) return { ok: false, skipped: true, reason: "kill switch active" };
  if (!isAutostartEnabled()) return { ok: false, skipped: true, reason: "autostart disabled" };

  const id = cleanText(result.id || "");
  if (id && scheduledIds.has(id)) {
    return { ok: true, skipped: true, reason: "already scheduled", id };
  }
  if (id) scheduledIds.add(id);

  const dueMs = new Date(cleanText(result.scheduledAt || "")).getTime();
  const graceMs = Number(process.env.STOCKTWITS_AUTOSTART_GRACE_MS || 3000);
  const waitMs = Math.max(0, (Number.isFinite(dueMs) ? dueMs : Date.now()) - Date.now() + (Number.isFinite(graceMs) ? graceMs : 3000));

  const timeout = setTimeout(() => {
    if (id) scheduledIds.delete(id);
    startStocktwitsOneShotWorker({
      id,
      ticker: result.ticker,
      scheduledAt: result.scheduledAt,
      trigger: "queued draft due"
    });
  }, waitMs);
  if (typeof timeout.unref === "function") timeout.unref();

  log("Scheduled one-shot Stocktwits worker.", {
    id,
    ticker: result.ticker,
    scheduledAt: result.scheduledAt,
    waitMs
  });

  return { ok: true, scheduled: true, id, waitMs };
}

module.exports = {
  scheduleStocktwitsOneShotWorkerForDraft,
  startStocktwitsOneShotWorker,
  stocktwitsWorkerIsRunning
};
