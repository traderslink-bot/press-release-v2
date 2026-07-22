const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const pidPath = process.argv[2];
const healthPath = process.argv[3];
const HEALTH_FRESH_MS = 2 * 60 * 1000;

function readPid() {
  try {
    const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function hasRunnerCommandLine(pid) {
  if (process.platform !== "win32") return true;

  try {
    const commandLine = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($p) { $p.CommandLine }`,
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
    ).trim();
    const normalized = commandLine.replace(/\//g, "\\").toLowerCase();
    return normalized.includes("node") && normalized.includes("run_both_levels_bots.js");
  } catch (_) {
    return null;
  }
}

function hasFreshMatchingHealth(pid) {
  try {
    const health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
    const updatedAt = Date.parse(health.updatedAt || "");
    return (
      Number(health?.runner?.pid) === pid &&
      Number.isFinite(updatedAt) &&
      Date.now() - updatedAt <= HEALTH_FRESH_MS
    );
  } catch (_) {
    return false;
  }
}

const pid = readPid();
if (!pid || !isProcessAlive(pid)) {
  process.exit(1);
}

if (hasFreshMatchingHealth(pid)) {
  process.exit(0);
}

const commandLineMatch = hasRunnerCommandLine(pid);
if (commandLineMatch === true) {
  process.exit(0);
}

process.exit(1);
