const fs = require("fs");
const path = require("path");
const {
  MOOMOO_DIR,
  cleanText,
  readJsonFile
} = require("./queue");

const LOCK_FILE = path.join(MOOMOO_DIR, "live-worker.lock");
const STATUS_FILE = path.join(MOOMOO_DIR, "live-worker-status.json");
const STALE_STATUS_MS = 5 * 60 * 1000;

function parsePid(value) {
  const pid = Number(cleanText(value || ""));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function readLockPid() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  return parsePid(fs.readFileSync(LOCK_FILE, "utf8"));
}

function processIsRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function ageMs(isoValue) {
  const timestamp = new Date(cleanText(isoValue || "")).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Date.now() - timestamp;
}

function formatAge(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function main() {
  const status = readJsonFile(STATUS_FILE, null);
  const lockPid = readLockPid();
  const statusPid = parsePid(status?.pid);
  const effectivePid = lockPid || statusPid;
  const running = processIsRunning(effectivePid);
  const statusAgeMs = status ? ageMs(status.updatedAt) : null;
  const state = status?.state || "unknown";
  const terminalState = state === "auth_required" || state === "profile_locked" || state === "not_approved" || state === "stopped";
  const stale = !terminalState && statusAgeMs !== null && statusAgeMs > STALE_STATUS_MS;

  const report = {
    running,
    pid: effectivePid,
    lockPid,
    statusPid,
    state,
    sourceFilter: status?.sourceFilter || "",
    updatedAt: status?.updatedAt || "",
    statusAge: formatAge(statusAgeMs),
    staleStatus: stale,
    currentTicker: status?.currentTicker || "",
    currentId: status?.currentId || "",
    nextCheckAt: status?.nextCheckAt || "",
    nextAllowedAt: status?.nextAllowedAt || "",
    lastPostedTicker: status?.lastPostedTicker || "",
    lastPostedAt: status?.lastPostedAt || "",
    lastError: status?.lastError || ""
  };

  console.log(JSON.stringify(report, null, 2));

  if (!running && lockPid) {
    process.exitCode = 2;
  } else if (running && stale) {
    process.exitCode = 3;
  }
}

main();
