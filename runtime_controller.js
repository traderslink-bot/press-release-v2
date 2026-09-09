const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const projectRoot = __dirname;
const levelsRoot = path.resolve(projectRoot, "..", "..", "levels");
const runnerPath = path.join(levelsRoot, "run_both_levels_bots.js");
const pidPath = path.join(levelsRoot, "shared_levels_runner.pid");
const healthPath = path.join(levelsRoot, "shared_levels_runtime_health.json");
const manualStopPath = path.join(levelsRoot, "pr_v2_manual_stop_until_next_schedule.flag");
const aliveCheckPath = path.join(projectRoot, "controller_runner_alive.js");
const controllerLogPath = path.join(levelsRoot, "shared_levels_controller.log");
const CHECK_INTERVAL_MS = 20_000;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(controllerLogPath, line, "utf8");
  } catch (_) {}
}

function easternClockParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function isActiveWindow(date = new Date()) {
  const parts = easternClockParts(date);
  if (["Sat", "Sun"].includes(parts.weekday)) return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 3 * 60 + 55 && minutes < 20 * 60;
}

function isRunnerAlive() {
  const result = spawnSync(process.execPath, [aliveCheckPath, pidPath, healthPath], {
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
  });
  return result.status === 0;
}

function launchRunner() {
  const child = spawn(process.execPath, [runnerPath], {
    cwd: levelsRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  log(`Runner launch requested (PID ${child.pid || "unknown"}).`);
}

function stopRunner() {
  let pid = null;
  try {
    pid = Number(fs.readFileSync(pidPath, "utf8").trim());
  } catch (_) {}
  if (!Number.isInteger(pid) || pid <= 0) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
  });
  log(`Runner stop requested (PID ${pid}).`);
}

let launching = false;
function check() {
  if (fs.existsSync(manualStopPath)) {
    stopRunner();
    log("Manual stop flag detected; controller exiting until next scheduled run.");
    process.exit(0);
  }
  if (!isActiveWindow()) {
    stopRunner();
    log("Outside active weekday window; controller exiting.");
    process.exit(0);
  }
  if (isRunnerAlive()) {
    launching = false;
    return;
  }
  if (!launching) {
    launching = true;
    launchRunner();
  } else {
    log("Runner is still unavailable; requesting another lock-protected launch.");
    launchRunner();
  }
}

try {
  if (fs.existsSync(manualStopPath)) fs.unlinkSync(manualStopPath);
} catch (_) {}

log("Node runtime controller started.");
check();
setInterval(check, CHECK_INTERVAL_MS);
