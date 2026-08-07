const fs = require("fs");
const path = require("path");
const {
  evaluateHealth,
  buildNotification,
  buildTelegramMessage,
  formatEasternTimestamp
} = require("./runtime_health_watchdog");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function buildHealthyState(now) {
  const recent = new Date(now.getTime() - 30000).toISOString();
  const liveAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const oldVisible = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const watcher = {
    enabled: true,
    status: "live",
    pageHealthy: true,
    lastHealthCheckAt: recent,
    liveAt,
    lastVisibleCheckAt: recent,
    lastVisibleMessageAt: oldVisible,
    pipelineStatus: "idle"
  };
  return {
    updatedAt: recent,
    runner: {
      pid: 1234,
      phase: "live",
      startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      liveAt,
      discordLoggedIn: true
    },
    watchers: {
      press_release: { ...watcher },
      market_cap: { ...watcher },
      scanner: { ...watcher }
    }
  };
}

const now = new Date(2026, 6, 20, 12, 0, 0);
const env = {};
const healthy = buildHealthyState(now);

assert(
  evaluateHealth({ now, env, health: healthy, pid: 1234, pidAlive: true }).length === 0,
  "Quiet but healthy Discord channels must not trigger alerts"
);

const missedVisible = buildHealthyState(now);
missedVisible.watchers.press_release.lastVisibleMessageAt = new Date(now.getTime() - 60000).toISOString();
assert(
  evaluateHealth({ now, env, health: missedVisible, pid: 1234, pidAlive: true })
    .some(item => item.code === "press_release_visible_not_detected"),
  "A new visible host message that was not detected must trigger an alert"
);

const stuck = buildHealthyState(now);
stuck.watchers.scanner.pipelineStatus = "processing";
stuck.watchers.scanner.lastProcessingStartedAt = new Date(now.getTime() - 25 * 60 * 1000).toISOString();
assert(
  evaluateHealth({ now, env, health: stuck, pid: 1234, pidAlive: true })
    .some(item => item.code === "scanner_processing_stuck"),
  "Stuck channel processing must trigger an alert"
);

const loggedOut = buildHealthyState(now);
loggedOut.runner.phase = "discord_login";
loggedOut.runner.discordLoggedIn = false;
assert(
  evaluateHealth({ now, env, health: loggedOut, pid: 1234, pidAlive: true })
    .some(item => item.code === "discord_not_logged_in"),
  "A runner that cannot complete Discord login must trigger an alert"
);

const watchdogSource = fs.readFileSync(path.join(__dirname, "runtime_health_watchdog.js"), "utf8");
assert(!/require\(["']playwright["']\)/.test(watchdogSource), "Watchdog must not load Playwright");
assert(
  watchdogSource.includes("parsePositiveNumber(env.APP_HEALTH_ALERT_AFTER_CHECKS, 1)"),
  "A single missed-message health check must be enough to alert"
);
assert(
  watchdogSource.includes("shared_levels_auto_recovery_request.json") &&
    watchdogSource.includes("shouldRequestAutoRecovery") &&
    watchdogSource.includes("pendingAutoRecoveryTargets") &&
    watchdogSource.includes("lastProcessedId"),
  "A visible missed host message must request recovery and remain open until its ID is processed"
);

const pressReleaseAlert = buildNotification({
  incidents: [{
    code: "press_release_visible_not_detected",
    summary: "Press-release host channel has a visible message that was not detected",
    details: "visible=UTC, detected=UTC"
  }],
  firstSeenAt: "2026-07-20T16:00:00.000Z"
});
assert(
  pressReleaseAlert.embeds[0].description === "• A press release post failed to process.",
  "Discord PR alerts must use the short user-facing processing message"
);
assert(
  !/host channel|visible=|detected=/i.test(pressReleaseAlert.embeds[0].description),
  "Discord PR alerts must not expose host-channel or raw timestamp diagnostics"
);
assert(
  /EDT|EST/.test(formatEasternTimestamp("2026-07-20T16:00:00.000Z")),
  "Discord alert timestamps must be explicitly formatted in Eastern Time"
);

const telegramAlert = buildTelegramMessage({
  incidents: [{
    code: "press_release_processing_error",
    summary: "Press-release host channel last message failed processing",
    details: "visible=UTC, detected=UTC"
  }],
  firstSeenAt: "2026-07-20T16:00:00.000Z"
});
assert(
  telegramAlert.includes("A press release post failed to process."),
  "Telegram PR alerts must use the short user-facing processing message"
);
assert(
  !/host channel|visible=|detected=/i.test(telegramAlert),
  "Telegram PR alerts must not expose host-channel or raw timestamp diagnostics"
);
assert(
  /Detected \(Eastern\):.*(?:EDT|EST)/.test(telegramAlert),
  "Telegram alert timestamps must be explicitly formatted in Eastern Time"
);

console.log("Runtime health watchdog checks: PASS");
