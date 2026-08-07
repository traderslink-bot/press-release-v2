const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { MOOMOO_DIR, ensureDir } = require("./queue");

const PROFILE_DIR = path.join(MOOMOO_DIR, ".chrome-profile");
const MOOMOO_LOGIN_URL = process.env.MOOMOO_LOGIN_URL || "https://www.moomoo.com/community/nnq";

function chromeCandidates() {
  const candidates = [];
  const envChrome = process.env.CHROME_PATH || process.env.MOOMOO_CHROME_PATH;
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

function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error("Chrome was not found. Set MOOMOO_CHROME_PATH to chrome.exe and rerun.");
  }

  ensureDir(PROFILE_DIR);
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--new-window",
    MOOMOO_LOGIN_URL
  ];

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();

  process.stdout.write([
    "Opened normal Chrome for moomoo login/session refresh.",
    `Profile: ${PROFILE_DIR}`,
    "Complete login or any security check manually, confirm moomoo Community is logged in, then close that Chrome window before running npm run moomoo:dry-run."
  ].join("\n") + "\n");
}

main();
