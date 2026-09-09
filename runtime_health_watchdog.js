const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = __dirname;
const LEVELS_ROOT = path.resolve(PROJECT_ROOT, "..", "..", "levels");
const ENV_PATH = path.join(PROJECT_ROOT, ".env.press_release_v2");
const HEALTH_PATH = process.env.SHARED_LEVELS_HEALTH_PATH ||
  path.join(LEVELS_ROOT, "shared_levels_runtime_health.json");
const PID_PATH = path.join(LEVELS_ROOT, "shared_levels_runner.pid");
const LOCK_PATH = path.join(LEVELS_ROOT, "shared_levels_runner.lock");
const WATCHDOG_STATE_PATH = path.join(LEVELS_ROOT, "shared_levels_watchdog_state.json");
const AUTO_RECOVERY_REQUEST_PATH = path.join(LEVELS_ROOT, "shared_levels_auto_recovery_request.json");
const INCIDENT_LOG_PATH = path.join(LEVELS_ROOT, "shared_levels_health_incidents.jsonl");

function cleanText(value, maxLength = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parsePositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function loadEnvFile(filePath = ENV_PATH) {
  const result = {};
  try {
    const source = fs.readFileSync(filePath, "utf8");
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const equalsIndex = line.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = line.slice(0, equalsIndex).trim();
      let value = line.slice(equalsIndex + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  } catch (_) {}
  return result;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendIncident(entry) {
  try {
    fs.mkdirSync(path.dirname(INCIDENT_LOG_PATH), { recursive: true });
    fs.appendFileSync(INCIDENT_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (_) {}
}

function parseTimestamp(value) {
  const numeric = Date.parse(value || "");
  return Number.isFinite(numeric) ? numeric : null;
}

function ageMs(nowMs, value) {
  const timestamp = parseTimestamp(value);
  return timestamp == null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - timestamp);
}

function readRunnerPid() {
  try {
    const value = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (_) {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function parseClock(value, fallback) {
  const normalized = /^\d{4}$/.test(String(value || "")) ? String(value) : fallback;
  return Number(normalized.slice(0, 2)) * 60 + Number(normalized.slice(2, 4));
}

function isActiveWindow(date, env) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const start = parseClock(env.APP_HEALTH_ACTIVE_START, "0355");
  const end = parseClock(env.APP_HEALTH_ACTIVE_END, "2000");
  return minutes >= start && minutes < end;
}

function activeWindowGraceComplete(date, env) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const start = parseClock(env.APP_HEALTH_ACTIVE_START, "0355");
  const graceMinutes = parsePositiveNumber(env.APP_HEALTH_STARTUP_GRACE_MINUTES, 15);
  return minutes >= start + graceMinutes;
}

function incident(code, summary, details = "") {
  return { code, summary, details: cleanText(details, 800) };
}

function formatEasternTimestamp(value) {
  const timestamp = parseTimestamp(value);
  if (timestamp == null) return "never";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(new Date(timestamp));
}

function evaluateHealth({ now = new Date(), env = {}, health, pid, pidAlive }) {
  const nowMs = now.getTime();
  const incidents = [];
  if (!isActiveWindow(now, env) || !activeWindowGraceComplete(now, env)) {
    return incidents;
  }

  if (!pid || !pidAlive) {
    incidents.push(incident("runner_not_running", "Shared Playwright runner is not running"));
    return incidents;
  }

  if (!health || typeof health !== "object") {
    incidents.push(incident("health_state_missing", "Runner health state is missing"));
    return incidents;
  }

  if (Number(health?.runner?.pid) !== pid) {
    incidents.push(incident(
      "health_pid_mismatch",
      "Runner PID and health state do not match",
      `pid file=${pid}, health pid=${health?.runner?.pid || "missing"}`
    ));
    return incidents;
  }

  const healthStaleMs = parsePositiveNumber(env.APP_HEALTH_STATE_STALE_MINUTES, 4) * 60 * 1000;
  if (ageMs(nowMs, health.updatedAt) > healthStaleMs) {
    incidents.push(incident(
      "runner_health_stale",
      "Runner heartbeat file is stale",
      `last update=${health.updatedAt || "never"}, phase=${health?.runner?.phase || "unknown"}`
    ));
    return incidents;
  }

  const runner = health.runner || {};
  const phase = cleanText(runner.phase || "unknown", 80);
  const startupLimitMs = parsePositiveNumber(env.APP_HEALTH_STARTUP_TIMEOUT_MINUTES, 15) * 60 * 1000;
  const runnerAge = ageMs(nowMs, runner.startedAt);

  if (phase === "error") {
    incidents.push(incident("runner_error", "Shared runner reported a fatal error", runner.lastError));
    return incidents;
  }

  if (phase !== "live") {
    if (runnerAge > startupLimitMs) {
      incidents.push(incident(
        "runner_startup_slow",
        "Shared runner has not reached live status",
        `phase=${phase}, started=${runner.startedAt || "unknown"}`
      ));
    }
    if (!runner.discordLoggedIn && runnerAge > startupLimitMs) {
      incidents.push(incident(
        "discord_not_logged_in",
        "Discord login has not completed",
        `runner phase=${phase}`
      ));
    }
    return incidents;
  }

  if (!runner.discordLoggedIn) {
    incidents.push(incident("discord_not_logged_in", "Runner is live but Discord is not logged in"));
  }

  const watcherStaleMs = parsePositiveNumber(env.APP_HEALTH_WATCHER_STALE_MINUTES, 4) * 60 * 1000;
  const processingLimitMs = parsePositiveNumber(env.APP_HEALTH_PROCESSING_TIMEOUT_MINUTES, 20) * 60 * 1000;
  const watcherLabels = {
    press_release: "Press-release host channel",
    market_cap: "Market-cap host channel",
    scanner: "Scanner host channel"
  };

  for (const [name, label] of Object.entries(watcherLabels)) {
    const watcher = health?.watchers?.[name];
    if (watcher?.enabled === false) continue;
    if (!watcher) {
      incidents.push(incident(`${name}_missing`, `${label} health state is missing`));
      continue;
    }

    if (watcher.status !== "live" || watcher.pageHealthy !== true) {
      incidents.push(incident(
        `${name}_unhealthy`,
        `${label} watcher is not healthy`,
        `status=${watcher.status || "unknown"}, error=${watcher.lastError || "none"}`
      ));
      continue;
    }

    if (ageMs(nowMs, watcher.lastHealthCheckAt) > watcherStaleMs) {
      incidents.push(incident(
        `${name}_heartbeat_stale`,
        `${label} health check is stale`,
        `last check=${watcher.lastHealthCheckAt || "never"}`
      ));
      continue;
    }

    const liveAt = parseTimestamp(watcher.liveAt) || parseTimestamp(runner.liveAt) || 0;
    const detectedAt = parseTimestamp(watcher.lastDetectedAt) || 0;
    const visibleAt = parseTimestamp(watcher.lastVisibleMessageAt) || 0;
    const visibleCheckFresh = ageMs(nowMs, watcher.lastVisibleCheckAt) <= watcherStaleMs;
    const comparisonBaseline = Math.max(liveAt, detectedAt);
    if (
      visibleCheckFresh &&
      visibleAt > comparisonBaseline + 15000 &&
      nowMs - visibleAt <= 2 * 60 * 60 * 1000
    ) {
      incidents.push(incident(
        `${name}_visible_not_detected`,
        `${label} has a visible message that was not detected`,
        `visible=${formatEasternTimestamp(watcher.lastVisibleMessageAt)}, ` +
          `detected=${formatEasternTimestamp(watcher.lastDetectedAt)}`
      ));
    }

    if (
      watcher.pipelineStatus === "processing" &&
      ageMs(nowMs, watcher.lastProcessingStartedAt || watcher.lastDetectedAt) > processingLimitMs
    ) {
      incidents.push(incident(
        `${name}_processing_stuck`,
        `${label} message processing appears stuck`,
        `ticker=${watcher.lastProcessingTicker || watcher.lastDetectedTicker || "unknown"}`
      ));
    }

    const errorAt = parseTimestamp(watcher.lastProcessingErrorAt) || 0;
    const processedAt = parseTimestamp(watcher.lastProcessedAt) || 0;
    if (watcher.pipelineStatus === "error" && errorAt > processedAt) {
      incidents.push(incident(
        `${name}_processing_error`,
        `${label} last message failed processing`,
        watcher.lastProcessingError
      ));
    }
  }

  return incidents;
}

function fingerprintIncidents(incidents) {
  return incidents.map(item => item.code).sort().join("|");
}

function buildNotificationLines({ recovery = false, incidents = [] }) {
  if (!incidents.length) {
    return ["All three Discord channel watchers are healthy again."];
  }

  return Array.from(new Set(incidents.map(item => {
    if (String(item.code || "").startsWith("press_release_")) {
      return recovery
        ? "Press release processing is working again."
        : "A press release post failed to process.";
    }
    return `${item.summary}${item.details ? ` - ${item.details}` : ""}`;
  })));
}

function buildNotification({ recovery = false, incidents = [], firstSeenAt = null }) {
  const lines = buildNotificationLines({ recovery, incidents });
  return {
    username: "TraderLink App Monitor",
    embeds: [{
      title: recovery ? "\u2705 TraderLink app recovered" : "\ud83d\udea8 TraderLink app health alert",
      description: lines.map(line => `\u2022 ${line}`).join("\n").slice(0, 3900),
      color: recovery ? 0x2ecc71 : 0xe74c3c,
      fields: [
        {
          name: "Detected (Eastern)",
          value: formatEasternTimestamp(firstSeenAt || new Date().toISOString()),
          inline: true
        }
      ],
      timestamp: new Date().toISOString()
    }]
  };
}

function buildTelegramMessage({ recovery = false, incidents = [], firstSeenAt = null }) {
  const title = recovery ? "TraderLink app recovered" : "TraderLink app health alert";
  const lines = buildNotificationLines({ recovery, incidents });
  return [
    title,
    "",
    ...lines.map(line => `- ${line}`),
    "",
    `Detected (Eastern): ${formatEasternTimestamp(firstSeenAt || new Date().toISOString())}`
  ].join("\n").slice(0, 4096);
}

async function postWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    throw new Error("No APP_HEALTH_WEBHOOK_URL is configured and primary webhook fallback is disabled");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Discord webhook returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function postTelegram(botToken, chatId, message) {
  if (!botToken || !chatId) {
    throw new Error("Telegram bot token or chat ID is not configured");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Telegram returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function configuredDestinations(env, webhookUrl) {
  const destinations = [];
  if (webhookUrl) {
    destinations.push({ name: "discord", webhookUrl });
  }
  const botToken = cleanText(env.APP_HEALTH_TELEGRAM_BOT_TOKEN, 500);
  const chatId = cleanText(env.APP_HEALTH_TELEGRAM_CHAT_ID, 100);
  if (botToken && chatId) {
    destinations.push({ name: "telegram", botToken, chatId });
  }
  return destinations;
}

async function deliverNotification(destination, notificationArgs) {
  if (destination.name === "discord") {
    await postWebhook(destination.webhookUrl, buildNotification(notificationArgs));
    return;
  }
  if (destination.name === "telegram") {
    await postTelegram(
      destination.botToken,
      destination.chatId,
      buildTelegramMessage(notificationArgs)
    );
    return;
  }
  throw new Error(`Unknown notification destination: ${destination.name}`);
}

async function checkRuntimeHealth(options = {}) {
  const fileEnv = loadEnvFile();
  const env = { ...fileEnv, ...process.env };
  const now = options.now || new Date();
  const health = readJson(HEALTH_PATH, null);
  const pid = readRunnerPid();
  const pidAlive = isProcessAlive(pid);
  const previous = readJson(WATCHDOG_STATE_PATH, {}) || {};
  const incidents = evaluateHealth({ now, env, health, pid, pidAlive });
  const previousRecoveryTargets = Array.isArray(previous.pendingAutoRecoveryTargets)
    ? previous.pendingAutoRecoveryTargets
    : [];
  const unresolvedRecoveryTargets = previousRecoveryTargets.filter(target => {
    const processedId = cleanText(health?.watchers?.[target.watcher]?.lastProcessedId, 200);
    const targetId = cleanText(target?.messageId, 200);
    return targetId && !(processedId === targetId || processedId.startsWith(`${targetId}:`));
  });
  for (const target of unresolvedRecoveryTargets) {
    const code = `${target.watcher}_visible_not_detected`;
    if (incidents.some(item => item.code === code)) continue;
    incidents.push(incident(
      code,
      `${target.label || target.watcher} missed message has not reached processed state`,
      `message=${target.messageId}, visible=${formatEasternTimestamp(target.visibleAt)}`
    ));
  }
  const fingerprint = fingerprintIncidents(incidents);
  const sameIncident = Boolean(fingerprint) && previous.activeFingerprint === fingerprint;
  const consecutiveChecks = fingerprint ? (sameIncident ? Number(previous.consecutiveChecks || 0) + 1 : 1) : 0;
  const firstSeenAt = sameIncident ? previous.firstSeenAt : now.toISOString();
  const notifyAfterChecks = Math.max(1, Math.floor(parsePositiveNumber(env.APP_HEALTH_ALERT_AFTER_CHECKS, 1)));
  const repeatMinutes = parsePositiveNumber(env.APP_HEALTH_REPEAT_MINUTES, 60);
  const lastAlertMs = parseTimestamp(previous.lastAlertAt) || 0;
  const shouldRepeat = lastAlertMs > 0 && now.getTime() - lastAlertMs >= repeatMinutes * 60 * 1000;
  const usePrimaryFallback = parseBoolean(env.APP_HEALTH_USE_PRIMARY_WEBHOOK, false);
  const webhookUrl = cleanText(
    env.APP_HEALTH_WEBHOOK_URL || (usePrimaryFallback ? env.DISCORD_WEBHOOK_URL : ""),
    2000
  );
  const destinations = configuredDestinations(env, webhookUrl);
  const previousDelivery = previous.notificationDelivery && typeof previous.notificationDelivery === "object"
    ? previous.notificationDelivery
    : {};
  const nextDelivery = { ...previousDelivery };
  let notification = "none";
  let notificationError = null;

  let pendingRecovery = previous.pendingRecovery && typeof previous.pendingRecovery === "object"
    ? previous.pendingRecovery
    : null;
  if (fingerprint) {
    pendingRecovery = null;
  } else if (
    previous.activeFingerprint &&
    Number(previous.consecutiveChecks || 0) >= notifyAfterChecks
  ) {
    pendingRecovery = {
      eventKey: `recovery:${previous.activeFingerprint}:${previous.firstSeenAt || "unknown"}`,
      incidents: Array.isArray(previous.incidents) ? previous.incidents : [],
      firstSeenAt: previous.firstSeenAt || now.toISOString()
    };
  }

  const alertEligible = Boolean(fingerprint) && consecutiveChecks >= notifyAfterChecks;
  const recoveryEligible = !fingerprint && Boolean(pendingRecovery);
  const eventType = recoveryEligible ? "recovery" : "alert";
  const eventKey = recoveryEligible
    ? pendingRecovery.eventKey
    : (alertEligible ? `alert:${fingerprint}` : null);
  const notificationArgs = recoveryEligible
    ? {
        recovery: true,
        incidents: pendingRecovery.incidents,
        firstSeenAt: pendingRecovery.firstSeenAt
      }
    : {
        recovery: false,
        incidents,
        firstSeenAt
      };
  const wasDelivered = destination => {
    if (previousDelivery[destination.name]?.eventKey === eventKey) return true;
    return destination.name === "discord" && eventType === "alert" &&
      previous.alertedFingerprint === fingerprint;
  };
  const targets = eventKey
    ? destinations.filter(destination => eventType === "alert" && shouldRepeat
      ? true
      : !wasDelivered(destination))
    : [];

  if (!options.noNotify && eventKey && targets.length) {
    const successes = [];
    const errors = [];
    for (const destination of targets) {
      try {
        await deliverNotification(destination, notificationArgs);
        successes.push(destination.name);
        nextDelivery[destination.name] = {
          eventKey,
          sentAt: now.toISOString()
        };
      } catch (error) {
        errors.push(`${destination.name}: ${cleanText(error?.message || error, 400)}`);
      }
    }
    notification = errors.length
      ? (successes.length ? `${eventType}_partial` : "failed")
      : `${eventType}_sent`;
    notificationError = errors.length ? errors.join("; ") : null;
  } else if (!options.noNotify && eventKey && !destinations.length) {
    notification = "failed";
    notificationError = "No health notification destination is fully configured";
  }

  const recoveryComplete = pendingRecovery && destinations.length > 0 && destinations.every(destination =>
    nextDelivery[destination.name]?.eventKey === pendingRecovery.eventKey
  );
  if (recoveryComplete) {
    pendingRecovery = null;
  }

  const alertWasSent = notification === "alert_sent" || notification === "alert_partial";
  const recoveryWasSent = notification === "recovery_sent" || notification === "recovery_partial";
  const missedIncidents = incidents.filter(item => /_visible_not_detected$/.test(String(item?.code || "")));
  const missedRecoveryKey = missedIncidents.map(item => item.code).sort().join("|");
  const autoRecoveryTargets = missedIncidents.map(item => {
    const watcher = String(item.code).replace(/_visible_not_detected$/, "");
    const watcherHealth = health?.watchers?.[watcher] || {};
    return {
      watcher,
      label: item.summary || watcher,
      messageId: cleanText(watcherHealth.lastVisibleMessageId, 200) || null,
      visibleAt: watcherHealth.lastVisibleMessageAt || null
    };
  }).filter(target => target.messageId);
  const hasMissedHostMessage = missedIncidents.length > 0;
  const shouldRequestAutoRecovery = alertEligible && hasMissedHostMessage && autoRecoveryTargets.length > 0 &&
    previous.autoRecoveryRequestedKey !== missedRecoveryKey;
  let autoRecoveryRequest = "none";
  let autoRecoveryRequestError = null;
  if (!options.noNotify && shouldRequestAutoRecovery) {
    try {
      writeJson(AUTO_RECOVERY_REQUEST_PATH, {
        requestedAt: now.toISOString(),
        fingerprint,
        incidents: missedIncidents,
        targets: autoRecoveryTargets
      });
      autoRecoveryRequest = "requested";
    } catch (error) {
      autoRecoveryRequest = "failed";
      autoRecoveryRequestError = cleanText(error?.message || error, 400);
    }
  }
  const nextState = {
    checkedAt: now.toISOString(),
    activeFingerprint: fingerprint || null,
    firstSeenAt: fingerprint ? firstSeenAt : null,
    consecutiveChecks,
    incidents,
    alertedFingerprint: alertWasSent
      ? fingerprint
      : (fingerprint ? previous.alertedFingerprint || null : null),
    lastAlertAt: alertWasSent ? now.toISOString() : previous.lastAlertAt || null,
    lastRecoveryAt: recoveryWasSent ? now.toISOString() : previous.lastRecoveryAt || null,
    autoRecoveryRequestedKey: autoRecoveryRequest === "requested"
      ? missedRecoveryKey
      : (fingerprint ? previous.autoRecoveryRequestedKey || null : null),
    pendingAutoRecoveryTargets: autoRecoveryRequest === "requested"
      ? autoRecoveryTargets
      : (unresolvedRecoveryTargets.length ? unresolvedRecoveryTargets : []),
    lastAutoRecoveryRequestedAt: autoRecoveryRequest === "requested"
      ? now.toISOString()
      : previous.lastAutoRecoveryRequestedAt || null,
    lastAutoRecoveryRequestError: autoRecoveryRequestError,
    notificationDelivery: nextDelivery,
    pendingRecovery,
    lastNotification: notification,
    lastNotificationError: notificationError
  };
  writeJson(WATCHDOG_STATE_PATH, nextState);

  const transitioned = previous.activeFingerprint !== nextState.activeFingerprint;
  if (transitioned || notification === "failed" || notification.endsWith("_partial")) {
    appendIncident({
      at: now.toISOString(),
      status: fingerprint ? "unhealthy" : "healthy",
      incidents,
      notification,
      notificationError
    });
  }

  return {
    ok: incidents.length === 0,
    activeWindow: isActiveWindow(now, env),
    pid,
    pidAlive,
    runnerPhase: health?.runner?.phase || null,
    incidents,
    consecutiveChecks,
    notifyAfterChecks,
    notification,
    notificationError,
    autoRecoveryRequest,
    autoRecoveryRequestError
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const fileEnv = loadEnvFile();
  const env = { ...fileEnv, ...process.env };
  const usePrimaryFallback = parseBoolean(env.APP_HEALTH_USE_PRIMARY_WEBHOOK, false);
  const webhookUrl = cleanText(
    env.APP_HEALTH_WEBHOOK_URL || (usePrimaryFallback ? env.DISCORD_WEBHOOK_URL : ""),
    2000
  );
  const destinations = configuredDestinations(env, webhookUrl);

  if (args.has("--test-alert")) {
    const notificationArgs = {
      incidents: [incident("test", "Health watchdog test succeeded", "No outage was generated")],
      firstSeenAt: new Date().toISOString()
    };
    if (!destinations.length) throw new Error("No health notification destination is fully configured");
    for (const destination of destinations) {
      await deliverNotification(destination, notificationArgs);
    }
    console.log(`Runtime health watchdog test alert sent to ${destinations.map(item => item.name).join(" and ")}.`);
    return;
  }

  if (args.has("--test-telegram")) {
    const telegram = destinations.find(item => item.name === "telegram");
    if (!telegram) throw new Error("Telegram bot token or chat ID is not configured");
    await deliverNotification(telegram, {
      incidents: [incident("test", "Telegram backup notification is working", "No outage was generated")],
      firstSeenAt: new Date().toISOString()
    });
    console.log("Runtime health watchdog Telegram test alert sent.");
    return;
  }

  const result = await checkRuntimeHealth({ noNotify: args.has("--no-notify") });
  if (args.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[WATCHDOG] ${result.ok ? "healthy" : "unhealthy"} | ` +
      `phase=${result.runnerPhase || "unknown"} | incidents=${result.incidents.length} | ` +
      `notification=${result.notification}`
    );
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[WATCHDOG][FATAL] ${cleanText(error?.message || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  evaluateHealth,
  fingerprintIncidents,
  isActiveWindow,
  checkRuntimeHealth,
  buildNotification,
  buildTelegramMessage,
  formatEasternTimestamp
};
