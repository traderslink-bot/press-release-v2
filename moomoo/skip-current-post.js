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

const LOCK_FILE = path.join(MOOMOO_DIR, "live-worker.lock");
const STATUS_FILE = path.join(MOOMOO_DIR, "live-worker-status.json");

function currentWorkerPid() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function main() {
  const status = readJsonFile(STATUS_FILE, null);
  const id = cleanText(status?.currentId || "");
  const pid = currentWorkerPid();

  if (cleanText(status?.state || "") !== "posting" || !id || !isRunning(pid)) {
    console.log("No active Moomoo post is being reviewed, so nothing was skipped.");
    return;
  }

  updateQueue(resolveQueueFile(), rows => markPostStatus(rows, id, {
    status: "skipped",
    error: "Skipped by the user from the Moomoo desktop control before posting.",
    postedAt: ""
  }));

  try {
    process.kill(pid, "SIGTERM");
  } catch (_) {
    // The queue state is already skipped, so a worker that exits naturally cannot retry it.
  }

  console.log("The current Moomoo post was skipped and will not retry.");
  console.log("Future new articles remain enabled; no resume step is needed.");
}

main();
