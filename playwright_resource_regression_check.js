const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const levelsRoot = path.resolve(projectRoot, "..", "..", "levels");

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const runnerSource = read(path.join(levelsRoot, "run_both_levels_bots.js"));
const controllerSource = read(path.join(levelsRoot, "run-scanner-pr-time-triggers.bat"));
const controllerAliveSource = read(path.join(projectRoot, "controller_runner_alive.js"));
const scannerSource = read(path.join(levelsRoot, "scanner_levels.js"));
const liveBotSource = read(path.join(projectRoot, "lib", "liveBot.js"));
const configSource = read(path.join(projectRoot, "lib", "config.js"));
const runtimeHealthSource = read(path.join(projectRoot, "lib", "runtimeHealth.js"));
const watchdogSource = read(path.join(projectRoot, "runtime_health_watchdog.js"));
const nodeControllerSource = read(path.join(projectRoot, "runtime_controller.js"));
const nodeControllerRegistrationSource = read(path.join(projectRoot, "register_runtime_controller.ps1"));
const supervisorLauncherSource = read(path.join(projectRoot, "runtime_supervisor_launch_hidden.vbs"));

assert(
  runnerSource.includes('new Set(["0650", "0920", "1100", "1300", "1530"])'),
  "Existing scheduled restart times must remain unchanged"
);
assert(runnerSource.includes("headless: HEADLESS"), "Shared Chromium must honor HEADLESS");
assert(
  runnerSource.includes('launchOptions.channel = "chromium"'),
  "Headless mode must use Playwright's current Chromium headless engine"
);
assert(
  runnerSource.includes('"--disable-background-timer-throttling"') &&
    runnerSource.includes('"--disable-backgrounding-occluded-windows"') &&
    runnerSource.includes('"--disable-renderer-backgrounding"'),
  "Headless Discord tabs must remain scheduled in the background"
);
assert(runnerSource.includes('reducedMotion: "reduce"'), "Reduced motion must be enabled");
assert(runnerSource.includes("deviceScaleFactor: 1"), "Headless rendering must use a 1x device scale");
assert(
  runnerSource.includes('"--force-device-scale-factor=1"'),
  "Chromium must avoid the host display's higher device scale"
);
assert(runnerSource.includes("acceptDownloads: false"), "Automatic downloads must be disabled");
assert(
  runnerSource.includes('launchOptions.args.push("--blink-settings=imagesEnabled=false")'),
  "Lightweight image blocking must remain configurable"
);
assert(runnerSource.includes("RUNNER_LOG_MAX_BYTES"), "Runner log rotation must remain enabled");
assert(
  runnerSource.includes("RUNNER_HEALTH_PATH") &&
    runnerSource.includes('processStatus === "unknown"') &&
    runnerSource.includes("keeping the lock and exiting duplicate start") &&
    !runnerSource.includes("clearing lock without terminating it"),
  "Stale-lock recovery must keep ownership when a live PID cannot be verified"
);
assert(
  runnerSource.includes("RUNNER_SHUTDOWN_TIMEOUT_MS") &&
    runnerSource.includes("closeBrowserForShutdown") &&
    runnerSource.includes("runSupervisedScanner") &&
    runnerSource.includes('await waitForWatcherReady("market_cap")') &&
    runnerSource.includes("Restarting only the scanner tab") &&
    runnerSource.includes('process.on("SIGBREAK"'),
  "Shared-runner shutdown must be bounded and scanner failures must be page-local"
);
assert(
  runnerSource.includes("satisfied by an active fresh startup"),
  "A scheduled restart must not interrupt a fresh Discord startup"
);
assert(
  controllerSource.includes("Existing shared runner detected. Controller is adopting it without a restart."),
  "The scheduled controller must adopt one healthy runner without restarting it"
);
assert(
  !controllerSource.includes("tasklist /V"),
  "The scheduled controller must not use an unbounded verbose tasklist query"
);
assert(
  controllerSource.includes("shared_levels_controller.log"),
  "The scheduled controller must persist startup and recovery diagnostics"
);
assert(
  controllerSource.includes("controller_runner_alive.js"),
  "The scheduled controller must use the bounded runner identity check"
);
assert(
  controllerSource.includes("runtime_supervisor_launch_hidden.vbs") &&
    !controllerSource.includes('start "Shared PR + Scanner Levels"'),
  "The scheduled controller must launch the supervisor without the blocking console start builtin"
);
assert(
  !controllerSource.includes("Closing Shared Levels Runner lock PID"),
  "Controller cleanup must not kill a possibly reused PID sourced only from a stale lock"
);
assert(
  controllerAliveSource.includes("timeout: 3000") &&
    controllerAliveSource.includes("run_both_levels_bots.js") &&
    controllerAliveSource.includes("HEALTH_FRESH_MS") &&
    controllerAliveSource.includes("STARTUP_GRACE_MS"),
  "The controller check must be bounded and allow a finite startup grace"
);
assert(
  controllerAliveSource.indexOf("\nif (hasFreshMatchingHealth(pid))") <
    controllerAliveSource.indexOf("\nconst commandLineMatch = hasRunnerCommandLine(pid)"),
  "Fresh matching health must bypass slow Windows command-line lookup"
);
assert(
  nodeControllerSource.includes("spawn(process.execPath, [runnerPath]") &&
    nodeControllerSource.includes("CHECK_INTERVAL_MS = 20_000") &&
    !nodeControllerSource.includes("ComSpec"),
  "The scheduled Node controller must monitor and launch the runner without cmd.exe"
);
assert(
  nodeControllerRegistrationSource.includes("-Priority 3") &&
    nodeControllerRegistrationSource.includes("-MultipleInstances IgnoreNew"),
  "The scheduled Node controller must run Above Normal and reject overlapping task instances"
);
assert(
  supervisorLauncherSource.includes("shell.Run command, 0, False") &&
    supervisorLauncherSource.includes("run_both_levels_bots_forever.bat"),
  "The runner supervisor must have an asynchronous hidden launcher"
);

assert(
  configSource.includes("PLAYWRIGHT_BLOCK_IMAGES"),
  "Playwright image-blocking configuration must be exported"
);
assert(
  (liveBotSource.match(/waitUntil: "domcontentloaded"/g) || []).length >= 3,
  "Discord login and both live channel navigations must use DOMContentLoaded"
);
assert(
  !liveBotSource.includes("using document body observer fallback"),
  "Live Discord watchers must not observe the full document body"
);
assert(
  !scannerSource.includes("using document body observer fallback"),
  "Scanner watcher must not observe the full document body"
);
assert(
  scannerSource.includes("rescanRecentMessages();") &&
    scannerSource.includes("}, 10000);"),
  "Scanner fallback must stay at 10 seconds to avoid increasing post latency"
);
assert(
  scannerSource.includes('waitUntil: "domcontentloaded"'),
  "Scanner navigation must use DOMContentLoaded"
);
assert(
  liveBotSource.includes('updateWatcherHealth("press_release"') &&
    liveBotSource.includes('updateWatcherHealth("market_cap"'),
  "Press-release and market-cap watchers must publish runtime health"
);
assert(
  scannerSource.includes('updateWatcherHealth("scanner"'),
  "Scanner watcher must publish runtime health"
);
assert(
  scannerSource.includes("restartSignal") &&
    scannerSource.includes("restarting scanner tab") &&
    !scannerSource.includes("requestSharedRunnerRestart"),
  "Scanner failures must restart only the scanner tab"
);
assert(
  liveBotSource.includes("Reconnected watcher to replaced message list") &&
    scannerSource.includes("Reconnected watcher to replaced message list"),
  "All Discord watchers must reconnect after Discord replaces a message list"
);
assert(
  nodeControllerSource &&
    runnerSource.includes("startScannerLevelsBot(context") &&
    runnerSource.includes("bringToFront: true") &&
    runnerSource.includes("rotateFocusForHealth: HEADLESS") &&
    liveBotSource.includes('runner?.phase !== "live"') &&
    liveBotSource.includes("DISCORD_WATCHER_ATTACH_TIMEOUT_MS") &&
    liveBotSource.includes("press-release headless focus") &&
    liveBotSource.includes("market-cap headless focus") &&
    liveBotSource.includes("press-release Discord health check") &&
    liveBotSource.includes("market-cap Discord health check") &&
    scannerSource.includes("scanner headless focus") &&
    scannerSource.includes("scanner Discord health check"),
  "Headless Discord startup must avoid foreground contention and bound attachment steps"
);
assert(
  liveBotSource.includes("window.__prbotRescan?.()") &&
    liveBotSource.includes("window.__mcbotRescan?.()") &&
    scannerSource.includes("window.__scannerLevelsRescan?.()"),
  "Headless health rotation must force a lightweight visible-message rescan"
);
assert(
  read(path.join(projectRoot, "press_release_levels_v2.js")).includes(
    'await waitForWatcherReady("press_release")'
  ),
  "Market-cap startup must wait until the press-release watcher is genuinely live"
);
assert(
  (liveBotSource.match(/}, 10000\);/g) || []).length >= 2,
  "Press-release and market-cap safety rescans must run every 10 seconds"
);
assert(
  liveBotSource.includes("Boolean(window.__prbotMessageRoot?.isConnected)") &&
    liveBotSource.includes("Boolean(window.__mcbotMessageRoot?.isConnected)") &&
    scannerSource.includes("Boolean(window.__scannerLevelsMessageRoot?.isConnected)"),
  "Watcher health must require a connected observed message list"
);
assert(
  configSource.includes("HOST_STARTUP_BACKFILL_HOURS: Number(process.env.HOST_STARTUP_BACKFILL_HOURS || 2)") &&
    configSource.includes("HOST_STARTUP_BACKFILL_MAX_MESSAGES: Number(process.env.HOST_STARTUP_BACKFILL_MAX_MESSAGES || 100)") &&
    liveBotSource.includes("startupEasternDate"),
  "Startup recovery must be two-hour recent-only and must never replay a prior Eastern date"
);
assert(
  !liveBotSource.includes('"x.com", "www.x.com", "twitter.com", "www.twitter.com"') &&
    !liveBotSource.includes("/\\/status\\/\\d+/i"),
  "Host watchers must continue ignoring TradeHawk X/Twitter status links"
);
assert(
  (liveBotSource.match(/newsfilter\.io/g) || []).length >= 2,
  "Both host watchers must accept NuntioBot Newsfilter article links"
);
assert(
  liveBotSource.includes('const feedType = cleanText(data?.feedType || "") || "market_cap"'),
  "Market-cap bundle expansion must preserve startup-backfill semantics"
);
assert(
  controllerAliveSource.includes("const HEALTH_FRESH_MS = 4 * 60 * 1000") &&
    controllerAliveSource.includes('health?.runner?.phase !== "live"') &&
    controllerAliveSource.includes("A verified runner process with a stale heartbeat is frozen"),
  "The runtime controller must replace a verified runner whose live heartbeat is stale"
);
assert(runtimeHealthSource.includes("WRITE_THROTTLE_MS = 5000"), "Health file writes must be throttled");
assert(!watchdogSource.includes('require("playwright")'), "Watchdog must not launch Playwright");

console.log("Playwright resource regression checks: PASS");
