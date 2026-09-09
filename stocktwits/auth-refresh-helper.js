const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  ROOT_DIR,
  STOCKTWITS_DIR,
  cleanText,
  ensureDir
} = require("./queue");
const { openManualRefreshChrome } = require("./open-login-chrome");

const LOG_DIR = path.join(STOCKTWITS_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "auth-refresh.log");

function timestamp() {
  return new Date().toISOString();
}

function log(message, data = null) {
  ensureDir(LOG_DIR);
  const line = `[${timestamp()}] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`;
  fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  console.log(line);
}

function envNumber(name, fallback) {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) ? value : fallback;
}

function retryEnabled() {
  return !/^false$/i.test(process.env.STOCKTWITS_AUTH_REFRESH_AUTO_RETRY || "true");
}

function retryDepth() {
  return Math.max(0, envNumber("STOCKTWITS_AUTH_REFRESH_RETRY_DEPTH", 0));
}

function maxRetryDepth() {
  return Math.max(0, envNumber("STOCKTWITS_AUTH_REFRESH_MAX_RETRY_DEPTH", 1));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function spawnOneShotWorker() {
  const outFd = fs.openSync(path.join(LOG_DIR, "live-worker.out.log"), "a");
  const errFd = fs.openSync(path.join(LOG_DIR, "live-worker.err.log"), "a");
  try {
    const child = spawn(process.execPath, [path.join(STOCKTWITS_DIR, "live-worker.js"), "--once"], {
      cwd: ROOT_DIR,
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        STOCKTWITS_SOURCE_FILTER: cleanText(process.env.STOCKTWITS_SOURCE_FILTER || "press_release_v2"),
        STOCKTWITS_AUTH_REFRESH_RETRY_DEPTH: String(retryDepth() + 1)
      },
      stdio: ["ignore", outFd, errFd]
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

async function main() {
  ensureDir(LOG_DIR);

  const depth = retryDepth();
  const maxDepth = maxRetryDepth();
  const refresh = openManualRefreshChrome({ wait: true });
  log("Opened normal Chrome for Stocktwits manual login/security refresh.", {
    pid: refresh.child.pid,
    profileDir: refresh.profileDir,
    url: refresh.url,
    retryDepth: depth,
    maxRetryDepth: maxDepth
  });

  await new Promise(resolve => {
    refresh.child.once("exit", (code, signal) => {
      log("Normal Chrome manual refresh window closed.", { code, signal });
      resolve();
    });
  });

  if (!retryEnabled()) {
    log("Auto-retry after manual Stocktwits refresh is disabled.");
    return;
  }

  if (depth >= maxDepth) {
    log("Auto-retry after manual Stocktwits refresh skipped because max retry depth was reached.", {
      retryDepth: depth,
      maxRetryDepth: maxDepth
    });
    return;
  }

  const delayMs = Math.max(0, envNumber("STOCKTWITS_AUTH_REFRESH_RETRY_DELAY_MS", 3000));
  if (delayMs) await sleep(delayMs);

  const pid = spawnOneShotWorker();
  log("Started one-shot Stocktwits worker after manual login/security refresh.", { pid });
}

main().catch(err => {
  log("Stocktwits auth refresh helper failed.", { error: err.message, stack: err.stack });
  process.exitCode = 1;
});
