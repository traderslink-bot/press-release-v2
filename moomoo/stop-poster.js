const fs = require("fs");
const path = require("path");
const {
  MOOMOO_DIR,
  cleanText,
  resolveQueueFile,
  readJsonFile,
  updateQueue,
  markPostStatus
} = require("./queue");

const KILL_SWITCH_FILE = path.join(MOOMOO_DIR, "KILL_SWITCH");
const LOCK_FILE = path.join(MOOMOO_DIR, "live-worker.lock");
const STATUS_FILE = path.join(MOOMOO_DIR, "live-worker-status.json");

function currentWorkerPid() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function stopWorker(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGTERM");
    return true;
  } catch (_) {
    return false;
  }
}

function skipCurrentPost(status) {
  if (cleanText(status?.state || "") !== "posting") return "";
  const id = cleanText(status?.currentId || "");
  if (!id) return "";

  const changed = updateQueue(resolveQueueFile(), rows => markPostStatus(rows, id, {
    status: "skipped",
    error: "Stopped by the Moomoo desktop stop control before posting.",
    postedAt: ""
  }));
  return changed ? id : "";
}

function main() {
  fs.writeFileSync(KILL_SWITCH_FILE, `Paused by desktop stop control at ${new Date().toISOString()}\n`, "utf8");
  const status = readJsonFile(STATUS_FILE, null);
  const skippedId = skipCurrentPost(status);
  const workerStopped = stopWorker(currentWorkerPid());

  console.log("Moomoo posting is paused.");
  if (skippedId) console.log("The active queued post was skipped and will not retry.");
  if (workerStopped) console.log("The active Moomoo worker was stopped.");
  console.log("Use Resume Moomoo Poster when you want future articles to post again.");
}

main();
