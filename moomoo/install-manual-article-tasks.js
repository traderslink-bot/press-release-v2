const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  ROOT_DIR,
  MOOMOO_DIR,
  cleanText,
  ensureDir,
  readJsonFile
} = require("./queue");

const MANUAL_DIR = path.join(MOOMOO_DIR, "manual-articles");
const DEFAULT_SCHEDULE_FILE = path.join(MANUAL_DIR, "schedule.json");
const DEFAULT_TOP_GAINERS_FILE = path.join(MANUAL_DIR, "top-gainers.json");
const TASK_BATCH_DIR = path.join(MANUAL_DIR, "tasks");
const TASK_NAME_PREFIX = "Moomoo Manual Article";
const DEFAULT_PREFLIGHT_MS = 0;

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseArgs(argv) {
  const args = {
    install: false,
    delete: false,
    scheduleFile: process.env.MOOMOO_MANUAL_ARTICLE_SCHEDULE_FILE || DEFAULT_SCHEDULE_FILE,
    topGainersFile: process.env.MOOMOO_TOP_GAINERS_FILE || DEFAULT_TOP_GAINERS_FILE,
    preflightMs: numberFromEnv("MOOMOO_MANUAL_ARTICLE_PREFLIGHT_MS", DEFAULT_PREFLIGHT_MS)
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--install") {
      args.install = true;
    } else if (arg === "--delete") {
      args.delete = true;
    } else if (arg === "--schedule-file") {
      args.scheduleFile = argv[index + 1] || args.scheduleFile;
      index += 1;
    } else if (arg === "--top-gainers-file") {
      args.topGainersFile = argv[index + 1] || args.topGainersFile;
      index += 1;
    } else if (arg === "--preflight-ms") {
      args.preflightMs = Number(argv[index + 1] || args.preflightMs);
      index += 1;
    }
  }

  args.scheduleFile = path.resolve(args.scheduleFile);
  args.topGainersFile = path.resolve(args.topGainersFile);
  if (!Number.isFinite(args.preflightMs) || args.preflightMs < 0) args.preflightMs = DEFAULT_PREFLIGHT_MS;
  return args;
}

function normalizeSchedule(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.posts)) return raw.posts;
  return [];
}

function parseScheduledAt(value) {
  const date = new Date(cleanText(value || ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function taskDate(value) {
  return `${value.getFullYear()}/${pad2(value.getMonth() + 1)}/${pad2(value.getDate())}`;
}

function taskTime(value) {
  return `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
}

function safeTaskSuffix(id) {
  return cleanText(id || "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "untitled";
}

function batchPathFor(id) {
  return path.join(TASK_BATCH_DIR, `${safeTaskSuffix(id)}.bat`);
}

function taskNameFor(id) {
  return `${TASK_NAME_PREFIX} ${safeTaskSuffix(id)}`;
}

function escapeBatchValue(value) {
  return String(value || "").replace(/%/g, "%%");
}

function writeTaskBatch(filePath, args) {
  ensureDir(path.dirname(filePath));
  const logFile = path.join(MOOMOO_DIR, "logs", "manual-article-tasks.log");
  const lines = [
    "@echo off",
    "setlocal",
    `cd /d "${escapeBatchValue(ROOT_DIR)}"`,
    "set MOOMOO_SOURCE_FILTER=manual_article",
    "set MOOMOO_LIVE_APPROVED=YES",
    `npm run moomoo:manual-queue -- --schedule-file "${escapeBatchValue(args.scheduleFile)}" --top-gainers-file "${escapeBatchValue(args.topGainersFile)}" --preflight-ms ${Math.round(args.preflightMs)} >> "${escapeBatchValue(logFile)}" 2>&1`,
    "exit /b %ERRORLEVEL%"
  ];
  fs.writeFileSync(filePath, `${lines.join("\r\n")}\r\n`, "utf8");
}

function buildTaskDefinitions(args, now = new Date()) {
  const schedule = normalizeSchedule(readJsonFile(args.scheduleFile, []));
  return schedule.map(item => {
    const id = cleanText(item?.id || "");
    const scheduledAt = parseScheduledAt(item?.scheduledAt);
    const itemPreflightMs = Number(item?.preflightMs ?? args.preflightMs);
    const preflightMs = Number.isFinite(itemPreflightMs) && itemPreflightMs >= 0 ? itemPreflightMs : args.preflightMs;
    const taskAt = scheduledAt ? new Date(scheduledAt.getTime() - preflightMs) : null;
    const taskName = taskNameFor(id);
    return {
      id,
      taskName,
      batchPath: batchPathFor(id),
      scheduledAt: scheduledAt ? scheduledAt.toISOString() : "",
      taskAt: taskAt ? taskAt.toISOString() : "",
      taskDate: taskAt ? taskDate(taskAt) : "",
      taskTime: taskAt ? taskTime(taskAt) : "",
      preflightMs,
      valid: Boolean(id && scheduledAt && taskAt && taskAt.getTime() > now.getTime()),
      reason: !id
        ? "missing id"
        : !scheduledAt
          ? "invalid scheduledAt"
          : taskAt && taskAt.getTime() <= now.getTime()
            ? "task start time is in the past"
            : ""
    };
  });
}

function runSchtasks(argsList) {
  return spawnSync("schtasks.exe", argsList, {
    encoding: "utf8"
  });
}

function installTask(definition, args) {
  writeTaskBatch(definition.batchPath, args);
  const result = runSchtasks([
    "/Create",
    "/TN", definition.taskName,
    "/TR", definition.batchPath,
    "/SC", "ONCE",
    "/SD", definition.taskDate,
    "/ST", definition.taskTime,
    "/F"
  ]);
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: cleanText(result.stdout || ""),
    stderr: cleanText(result.stderr || "")
  };
}

function deleteTask(definition) {
  const result = runSchtasks([
    "/Delete",
    "/TN", definition.taskName,
    "/F"
  ]);
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: cleanText(result.stdout || ""),
    stderr: cleanText(result.stderr || "")
  };
}

function main() {
  if (process.platform !== "win32") {
    throw new Error("Windows scheduled task installation is only supported on Windows.");
  }

  const args = parseArgs(process.argv);
  const definitions = buildTaskDefinitions(args);
  const results = definitions.map(definition => {
    if (!definition.valid) {
      return { ...definition, ok: false, skipped: true };
    }
    if (args.delete) {
      return { ...definition, action: "delete", result: deleteTask(definition) };
    }
    if (args.install) {
      return { ...definition, action: "install", result: installTask(definition, args) };
    }
    return { ...definition, action: "preview", ok: true };
  });

  console.log(JSON.stringify({
    ok: results.every(row => row.ok || row.result?.ok || row.skipped),
    mode: args.delete ? "delete" : args.install ? "install" : "preview",
    scheduleFile: args.scheduleFile,
    topGainersFile: args.topGainersFile,
    taskCount: results.length,
    validTaskCount: results.filter(row => row.valid).length,
    results
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

module.exports = {
  buildTaskDefinitions
};
