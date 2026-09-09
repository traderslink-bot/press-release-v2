const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { STOCKTWITS_DIR, ensureDir } = require("./queue");

const PROFILE_DIR = path.join(STOCKTWITS_DIR, ".chrome-profile");
const STOCKTWITS_REFRESH_URL = process.env.STOCKTWITS_MANUAL_REFRESH_URL || "https://stocktwits.com/";

function chromeCandidates() {
  const candidates = [];
  const envChrome = process.env.CHROME_PATH || process.env.STOCKTWITS_CHROME_PATH;
  if (envChrome) candidates.push(envChrome);

  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push("google-chrome", "google-chrome-stable", "chromium-browser", "chromium");
  }

  return candidates.filter(Boolean);
}

function findChrome() {
  for (const candidate of chromeCandidates()) {
    if (candidate.includes(path.sep) || /^[A-Za-z]:\\/.test(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  return null;
}

function openManualRefreshChrome(options = {}) {
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error("Chrome was not found. Set STOCKTWITS_CHROME_PATH to chrome.exe and rerun.");
  }

  ensureDir(PROFILE_DIR);
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--new-window",
    STOCKTWITS_REFRESH_URL
  ];

  const child = spawn(chromePath, args, {
    detached: !options.wait,
    stdio: "ignore",
    windowsHide: false
  });
  if (!options.wait) child.unref();

  return {
    child,
    chromePath,
    profileDir: PROFILE_DIR,
    url: STOCKTWITS_REFRESH_URL
  };
}

function main() {
  const result = openManualRefreshChrome({ wait: false });

  process.stdout.write([
    "Opened normal Chrome for Stocktwits login/security refresh.",
    `Profile: ${result.profileDir}`,
    "Complete any login or human/security check manually, confirm Stocktwits is usable, then close that Chrome window before rerunning the autoposter."
  ].join("\n") + "\n");
}

if (require.main === module) {
  main();
}

module.exports = {
  openManualRefreshChrome
};
