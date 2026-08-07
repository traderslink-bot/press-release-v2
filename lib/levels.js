const { execFile } = require("child_process");
const { promisify } = require("util");

const {
  PYTHON_EXECUTABLE,
  LEVELS_SCRIPT_PATH,
  LEVELS_TIMEOUT_MS,
  LEVELS_CACHE_MS,
  LEVELS_MAX_CONCURRENT
} = require("./config");

const execFileAsync = promisify(execFile);
const levelsCache = new Map();
const levelsInFlight = new Map();
const levelsQueue = [];
let activeLevelsJobs = 0;

function formatEasternGeneratedAt(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).format(date);
}

function addGeneratedTimestamp(levelsText, generatedAt = new Date()) {
  const text = String(levelsText || "");
  if (!text.trim()) return text;

  const timestamp = formatEasternGeneratedAt(generatedAt);
  const lines = text.split("\n");
  const generatedLineIndex = lines.findIndex(line =>
    /^_?Data generated during /i.test(String(line || "").trim())
  );

  if (generatedLineIndex === -1) return text;

  const originalLine = String(lines[generatedLineIndex] || "");
  const trimmedLine = originalLine.trim();
  const isItalic = trimmedLine.startsWith("_") && trimmedLine.endsWith("_");
  const plainLine = trimmedLine.replace(/^_+|_+$/g, "").trim();

  if (/\bon\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}\s+[AP]M\s+[A-Z]{2,4}\b/.test(plainLine)) {
    return text;
  }

  const stampedLine = `${plainLine} on ${timestamp}`;
  lines[generatedLineIndex] = isItalic ? `_${stampedLine}_` : stampedLine;
  return lines.join("\n");
}

function getMaxConcurrentLevelsJobs() {
  const parsed = Number(LEVELS_MAX_CONCURRENT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2;
}

function pruneLevelsCache(now = Date.now()) {
  const cacheMs = Number(LEVELS_CACHE_MS || 0);
  if (!Number.isFinite(cacheMs) || cacheMs <= 0) {
    levelsCache.clear();
    return;
  }

  for (const [ticker, cached] of levelsCache.entries()) {
    if (!cached?.createdAt || now - cached.createdAt > cacheMs) {
      levelsCache.delete(ticker);
    }
  }
}

function getCachedLevels(safeTicker) {
  pruneLevelsCache();
  const cached = levelsCache.get(safeTicker);
  if (!cached) return null;

  console.log(`[LEVELS] Using cached levels for ${safeTicker}`);
  return cached.text || "";
}

function setCachedLevels(safeTicker, levelsText) {
  const cacheMs = Number(LEVELS_CACHE_MS || 0);
  if (!levelsText || !Number.isFinite(cacheMs) || cacheMs <= 0) return;

  levelsCache.set(safeTicker, {
    text: levelsText,
    createdAt: Date.now()
  });
}

function runLimitedLevelsScript(safeTicker) {
  if (activeLevelsJobs < getMaxConcurrentLevelsJobs()) {
    activeLevelsJobs += 1;
    return runLevelsScriptRaw(safeTicker).finally(() => {
      activeLevelsJobs = Math.max(0, activeLevelsJobs - 1);
      drainLevelsQueue();
    });
  }

  console.log(`[LEVELS] Queueing levels job for ${safeTicker}; ${activeLevelsJobs} active`);
  return new Promise(resolve => {
    levelsQueue.push({ ticker: safeTicker, resolve });
  });
}

function drainLevelsQueue() {
  while (activeLevelsJobs < getMaxConcurrentLevelsJobs() && levelsQueue.length) {
    const job = levelsQueue.shift();
    activeLevelsJobs += 1;
    runLevelsScriptRaw(job.ticker)
      .then(levelsText => job.resolve(levelsText || ""))
      .catch(err => {
        console.warn(`[LEVELS] Queued levels job failed for ${job.ticker}: ${err.message}`);
        job.resolve("");
      })
      .finally(() => {
        activeLevelsJobs = Math.max(0, activeLevelsJobs - 1);
        drainLevelsQueue();
      });
  }
}

async function runLevelsScriptRaw(ticker) {
  const safeTicker = String(ticker || "").trim().toUpperCase();
  if (!safeTicker) return "";

  try {
    console.log(`[LEVELS] Running levels script for ${safeTicker}`);

    const { stdout, stderr } = await execFileAsync(
      PYTHON_EXECUTABLE,
      [LEVELS_SCRIPT_PATH, safeTicker],
      {
        timeout: LEVELS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    );

    const stdoutText = String(stdout || "");
    const stderrText = String(stderr || "").trim();

    if (stderrText) {
      console.warn(`[LEVELS] stderr for ${safeTicker}: ${stderrText}`);
    }

    if (!stdoutText.trim()) {
      console.warn(`[LEVELS] No stdout returned for ${safeTicker}`);
      return "";
    }

    const lines = stdoutText.split(/\r?\n/);
    const startIndex = lines.findIndex(line => {
      const trimmed = line.trim();
      return trimmed === `**$${safeTicker}**` || trimmed === `$${safeTicker}`;
    });

    if (startIndex === -1) {
      console.warn(`[LEVELS] Clean trader block not found for ${safeTicker}`);
      return "";
    }

    const cleanedLines = lines.slice(startIndex).map(line => line.trimEnd());

    while (cleanedLines.length && cleanedLines[cleanedLines.length - 1].trim() === "") {
      cleanedLines.pop();
    }

    const cleaned = cleanedLines.join("\n").trim();
    return cleaned ? addGeneratedTimestamp(cleaned) : "";
  } catch (err) {
    console.error(`[LEVELS] Failed for ${safeTicker}: ${err.message}`);
    return "";
  }
}

async function runLevelsScript(ticker) {
  const safeTicker = String(ticker || "").trim().toUpperCase();
  if (!safeTicker) return "";

  const cachedLevels = getCachedLevels(safeTicker);
  if (cachedLevels !== null) return cachedLevels;

  const inFlight = levelsInFlight.get(safeTicker);
  if (inFlight) {
    console.log(`[LEVELS] Reusing in-flight levels job for ${safeTicker}`);
    return inFlight;
  }

  const levelsPromise = runLimitedLevelsScript(safeTicker)
    .then(levelsText => {
      setCachedLevels(safeTicker, levelsText);
      return levelsText || "";
    })
    .finally(() => {
      levelsInFlight.delete(safeTicker);
    });

  levelsInFlight.set(safeTicker, levelsPromise);
  return levelsPromise;
}

module.exports = {
  runLevelsScript
};
