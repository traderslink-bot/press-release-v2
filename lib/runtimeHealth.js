const fs = require("fs");
const path = require("path");

const LEVELS_ROOT = path.resolve(__dirname, "..", "..", "..", "levels");
const HEALTH_FILE_PATH = process.env.SHARED_LEVELS_HEALTH_PATH ||
  path.join(LEVELS_ROOT, "shared_levels_runtime_health.json");
const WRITE_THROTTLE_MS = 5000;

let flushTimer = null;
let state = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  runner: {},
  watchers: {}
};

function nowIso() {
  return new Date().toISOString();
}

function cleanError(value) {
  const text = String(value?.message || value || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 500);
}

function definedEntries(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function flushRuntimeHealth() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  state.updatedAt = nowIso();
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_FILE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    // Health reporting must never take down the live bots.
    console.warn(`[HEALTH] Could not write runtime health: ${cleanError(error)}`);
  }
}

function scheduleFlush(immediate = false) {
  if (immediate) {
    flushRuntimeHealth();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(flushRuntimeHealth, WRITE_THROTTLE_MS);
  flushTimer.unref?.();
}

function resetRuntimeHealth(runner = {}) {
  const timestamp = nowIso();
  state = {
    schemaVersion: 1,
    updatedAt: timestamp,
    runner: {
      pid: process.pid,
      startedAt: timestamp,
      phase: "starting",
      lastProgressAt: timestamp,
      discordLoggedIn: false,
      ...runner
    },
    watchers: {
      press_release: { enabled: true, status: "starting", pageHealthy: false },
      market_cap: { enabled: true, status: "starting", pageHealthy: false },
      scanner: { enabled: true, status: "starting", pageHealthy: false }
    }
  };
  scheduleFlush(true);
}

function updateRunnerHealth(patch = {}, options = {}) {
  state.runner = {
    ...state.runner,
    ...definedEntries(patch)
  };
  if (options.progress !== false) {
    state.runner.lastProgressAt = nowIso();
  }
  scheduleFlush(Boolean(options.immediate));
}

function updateWatcherHealth(name, patch = {}, options = {}) {
  if (!name) return;
  const current = state.watchers[name] || {};
  state.watchers[name] = {
    ...current,
    ...definedEntries(patch)
  };

  const required = Object.values(state.watchers).filter(watcher => watcher.enabled !== false);
  if (required.length && required.every(watcher => watcher.status === "live" && watcher.pageHealthy === true)) {
    state.runner.phase = "live";
    state.runner.liveAt = state.runner.liveAt || nowIso();
    state.runner.lastProgressAt = nowIso();
  }

  scheduleFlush(Boolean(options.immediate));
}

function markWatcherError(name, error, options = {}) {
  const timestamp = nowIso();
  updateWatcherHealth(name, {
    status: "error",
    pageHealthy: false,
    lastErrorAt: timestamp,
    lastError: cleanError(error)
  }, { immediate: options.immediate !== false });
}

function getRuntimeHealthSnapshot() {
  return JSON.parse(JSON.stringify(state));
}

module.exports = {
  HEALTH_FILE_PATH,
  resetRuntimeHealth,
  updateRunnerHealth,
  updateWatcherHealth,
  markWatcherError,
  flushRuntimeHealth,
  getRuntimeHealthSnapshot,
  cleanError
};
