const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  STOCKTWITS_DIR,
  DEFAULT_HISTORY_FILE,
  DEFAULT_MAX_LENGTH,
  DEFAULT_MIN_POST_INTERVAL_MS,
  cleanText,
  ensureDir,
  loadQueue,
  readHistory,
  appendHistory,
  selectNextDuePost,
  markPostStatus,
  resolveQueueFile,
  updateQueue,
  writeJsonFileAtomic
} = require("./queue");

const LOG_DIR = path.join(STOCKTWITS_DIR, "logs");
const SCREENSHOT_DIR = path.join(STOCKTWITS_DIR, "screenshots");
const PROFILE_DIR = path.resolve(process.env.STOCKTWITS_PROFILE_DIR || path.join(STOCKTWITS_DIR, ".chrome-profile"));
const TRACE_DIR = path.join(STOCKTWITS_DIR, "traces");
const LAST_DRY_RUN_FILE = path.join(STOCKTWITS_DIR, ".last-dry-run.json");
const KILL_SWITCH_FILE = path.join(STOCKTWITS_DIR, "KILL_SWITCH");
const STOCKTWITS_HOME_URL = "https://stocktwits.com/";

const COMPOSE_TRIGGER_CANDIDATES = [
  { kind: "role", role: "button", name: /post|message|share|write|compose/i, label: "button name post/message/share/write/compose" },
  { kind: "css", selector: "button[aria-label*='Post' i]", label: "button[aria-label*=Post]" },
  { kind: "css", selector: "button[aria-label*='Message' i]", label: "button[aria-label*=Message]" },
  { kind: "css", selector: "[data-testid*='compose' i]", label: "[data-testid*=compose]" }
];

const COMPOSE_BOX_CANDIDATES = [
  { kind: "role", role: "textbox", name: /share|message|post|idea|what/i, label: "textbox name share/message/post/idea/what" },
  { kind: "css", selector: "textarea[placeholder*='Share' i]", label: "textarea[placeholder*=Share]" },
  { kind: "css", selector: "textarea[placeholder*='message' i]", label: "textarea[placeholder*=message]" },
  { kind: "css", selector: "[contenteditable='true'][role='textbox']", label: "[contenteditable=true][role=textbox]" },
  { kind: "css", selector: "[contenteditable='true'][role='combobox']", label: "[contenteditable=true][role=combobox]" },
  { kind: "css", selector: "[contenteditable='true']", label: "[contenteditable=true]" },
  { kind: "css", selector: "textarea", label: "textarea" }
];

const SUBMIT_BUTTON_CANDIDATES = [
  { kind: "role", role: "button", name: /^post$/i, label: "button exact Post" },
  { kind: "role", role: "button", name: /post|send|share/i, label: "button name post/send/share" },
  { kind: "css", selector: "button[type='submit']", label: "button[type=submit]" },
  { kind: "css", selector: "button[aria-label*='Post' i]", label: "button[aria-label*=Post]" }
];

function nowStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function logFilePath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `stocktwits-${date}.jsonl`);
}

function logEvent(level, message, data = {}) {
  ensureDir(LOG_DIR);
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...data
  };
  fs.appendFileSync(logFilePath(), `${JSON.stringify(entry)}\n`, "utf8");
  const prefix = level.toUpperCase();
  console.log(`[${prefix}] ${message}`);
  if (Object.keys(data).length) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function parseArgs(argv) {
  const args = new Set(argv.slice(3));
  return {
    confirmPost: args.has("--confirm-post"),
    keepOpen: args.has("--keep-open"),
    noDryRunGate: args.has("--no-dry-run-gate")
  };
}

function isKillSwitchActive() {
  return (
    process.env.STOCKTWITS_KILL_SWITCH === "1" ||
    /^true$/i.test(process.env.STOCKTWITS_KILL_SWITCH || "") ||
    fs.existsSync(KILL_SWITCH_FILE)
  );
}

function shouldAllowPost(args) {
  return args.confirmPost || process.env.STOCKTWITS_ALLOW_POST === "YES";
}

function shouldPostFromSymbolPage() {
  return !/^false$/i.test(process.env.STOCKTWITS_POST_FROM_SYMBOL_PAGE || "true");
}

function shouldKeepOpenOnFailure(args) {
  return args.keepOpen || process.env.STOCKTWITS_KEEP_OPEN_ON_FAILURE === "1";
}

function manualLoginWaitMs() {
  const value = Number(process.env.STOCKTWITS_MANUAL_LOGIN_WAIT_MS || 10 * 60 * 1000);
  return Number.isFinite(value) && value >= 0 ? value : 10 * 60 * 1000;
}

function maxLength() {
  const value = Number(process.env.STOCKTWITS_MAX_LENGTH || DEFAULT_MAX_LENGTH);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_LENGTH;
}

function stripLeadingCashtagForSymbolPage(message, ticker) {
  const text = String(message || "").trim();
  if (!shouldPostFromSymbolPage()) return text;

  const normalizedTicker = cleanText(ticker || "").replace(/^\$/, "").toUpperCase();
  if (!normalizedTicker) return text;

  const autoTagEnabled = !/^false$/i.test(process.env.STOCKTWITS_SYMBOL_PAGE_AUTO_TAG || "true");
  if (!autoTagEnabled) return text;

  const pattern = new RegExp(`^\\$${normalizedTicker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i");
  return text.replace(pattern, "").trim();
}

function minPostIntervalMs() {
  const value = Number(process.env.STOCKTWITS_MIN_POST_INTERVAL_MS || DEFAULT_MIN_POST_INTERVAL_MS);
  const baseMs = Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_POST_INTERVAL_MS;
  const jitterMaxMs = Math.max(0, envNumber("STOCKTWITS_MIN_POST_INTERVAL_JITTER_MS", 45 * 1000));
  const jitterMs = jitterMaxMs > 0 ? Math.round(Math.random() * jitterMaxMs) : 0;
  return baseMs + jitterMs;
}

function sourceFilter() {
  return cleanText(process.env.STOCKTWITS_SOURCE_FILTER || "");
}

function shouldSaveDryRunScreenshot() {
  return !/^false$/i.test(process.env.STOCKTWITS_SAVE_DRY_RUN_SCREENSHOTS || "true");
}

function shouldAllowBrowserFallback() {
  return /^true$/i.test(process.env.STOCKTWITS_ALLOW_BROWSER_FALLBACK || "false");
}

function envNumber(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue == null || String(rawValue).trim() === "") return fallback;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : fallback;
}

function randomDelayMs(minName, maxName, defaultMin, defaultMax) {
  const min = Math.max(0, envNumber(minName, defaultMin));
  const max = Math.max(min, envNumber(maxName, defaultMax));
  return Math.round(min + Math.random() * (max - min));
}

async function waitForInteractionPacing(page, label, minName, maxName, defaultMin, defaultMax) {
  const waitMs = randomDelayMs(minName, maxName, defaultMin, defaultMax);
  if (waitMs <= 0) return;
  logEvent("info", `Waiting before ${label}.`, { waitMs });
  await page.waitForTimeout(waitMs);
}

async function saveScreenshot(page, reason) {
  ensureDir(SCREENSHOT_DIR);
  const safeReason = cleanText(reason).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 32) || "screenshot";
  const filePath = path.join(SCREENSHOT_DIR, `${nowStamp()}-${safeReason}.png`);
  try {
    await page.screenshot({ path: filePath, fullPage: false, timeout: 10000 });
  } catch (err) {
    console.warn(`[WARN] Failed to save screenshot ${filePath}: ${err.message}`);
    return null;
  }
  return filePath;
}

async function locatorFromCandidate(page, candidate) {
  if (candidate.kind === "role") {
    return page.getByRole(candidate.role, { name: candidate.name }).first();
  }
  return page.locator(candidate.selector).first();
}

async function findVisibleCandidate(page, candidates, timeoutMs = 1500) {
  for (const candidate of candidates) {
    const locator = await locatorFromCandidate(page, candidate);
    try {
      await locator.first().waitFor({ state: "attached", timeout: timeoutMs });
    } catch (_) {
      continue;
    }

    const count = Math.min(await locator.count().catch(() => 0), 25);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      const visible = await item.isVisible({ timeout: 250 }).catch(() => false);
      if (visible) return { locator: item, candidate };
    }
  }
  return null;
}

async function readLocatorText(locator, timeoutMs = 3000) {
  return locator.evaluate(element => {
    if ("value" in element) return element.value || "";
    return element.innerText || element.textContent || "";
  }, undefined, { timeout: timeoutMs }).catch(() => "");
}

async function fillComposerText(page, composeLocator, message) {
  const isContentEditable = await composeLocator.evaluate(element => Boolean(element.isContentEditable)).catch(() => false);
  if (!isContentEditable) {
    await composeLocator.fill(message, { timeout: 5000 });
    return;
  }

  await composeLocator.click({ timeout: 5000 }).catch(async () => {
    await composeLocator.click({ timeout: 5000, force: true });
  });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => null);
  await page.keyboard.press("Backspace").catch(() => null);
  await page.keyboard.insertText(message);
}

async function findSubmitButtonNearComposer(composeLocator) {
  const handle = await composeLocator.evaluateHandle(element => {
    function isVisible(candidate) {
      if (!candidate) return false;
      const style = window.getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function isPostButton(candidate) {
      if (!candidate || candidate.disabled || candidate.getAttribute("aria-disabled") === "true") {
        return false;
      }
      const text = String(candidate.innerText || candidate.textContent || candidate.getAttribute("aria-label") || "").trim();
      return /^post$/i.test(text) || /\bpost\b/i.test(text);
    }

    const composeRect = element.getBoundingClientRect();
    const targetX = composeRect.right;
    const targetY = composeRect.bottom;
    const candidates = Array.from(document.querySelectorAll("button"))
      .filter(button => isVisible(button) && isPostButton(button))
      .map(button => {
        const rect = button.getBoundingClientRect();
        const horizontallyNear = rect.right >= composeRect.left - 80 && rect.left <= composeRect.right + 220;
        const verticallyNear = rect.top >= composeRect.top - 120 && rect.top <= composeRect.bottom + 420;
        const distance = Math.abs(rect.left - targetX) + Math.abs(rect.top - targetY);
        return { button, rect, horizontallyNear, verticallyNear, distance };
      })
      .filter(item => item.horizontallyNear && item.verticallyNear)
      .sort((a, b) => a.distance - b.distance);

    if (candidates.length) {
      return candidates[0].button;
    }

    return null;
  });

  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => null);
    return null;
  }

  return element;
}

async function dismissTransientUi(page) {
  const security = await pageLooksLikeSecurityOrLogin(page);
  if (security.blocked) {
    return { ok: false, reason: security.reason };
  }

  await page.keyboard.press("Escape").catch(() => null);
  await page.waitForTimeout(500);

  const dismissers = [
    page.getByRole("button", { name: /close|dismiss|not now|maybe later|skip/i }).first(),
    page.locator("button[aria-label*='Close' i]").first(),
    page.locator(".ReactModalPortal button").filter({ hasText: /close|dismiss|not now|maybe later|skip/i }).first()
  ];

  for (const locator of dismissers) {
    const visible = await locator.isVisible({ timeout: 500 }).catch(() => false);
    if (!visible) continue;
    await locator.click({ timeout: 1500 }).catch(() => null);
    await page.waitForTimeout(500);
    break;
  }

  const after = await pageLooksLikeSecurityOrLogin(page);
  if (after.blocked) {
    return { ok: false, reason: after.reason };
  }
  return { ok: true };
}

async function clickSubmitButton(page, composeLocator) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const security = await pageLooksLikeSecurityOrLogin(page);
    if (security.blocked) {
      return { ok: false, reason: `login/security prompt before submit: ${security.reason}` };
    }

    const submitElement = await findSubmitButtonNearComposer(composeLocator);
    if (!submitElement) {
      return { ok: false, reason: "post button not found before submit" };
    }

    try {
      await waitForInteractionPacing(
        page,
        "submitting Stocktwits post",
        "STOCKTWITS_PRE_SUBMIT_DELAY_MIN_MS",
        "STOCKTWITS_PRE_SUBMIT_DELAY_MAX_MS",
        3000,
        8000
      );
      await submitElement.evaluate(element => {
        element.scrollIntoView({ block: "center", inline: "center" });
      }).catch(() => null);
      await page.waitForTimeout(500);
      await submitElement.click({ timeout: 5000 });
      return { ok: true };
    } catch (err) {
      lastError = err;
      const intercepted = /intercepts pointer events|not receiving pointer events|iframe.+Advertisement/i.test(err.message || "");
      if (intercepted) {
        await page.evaluate(() => window.scrollBy({ top: 260, behavior: "instant" })).catch(() => null);
        await page.waitForTimeout(750);
      }
      await submitElement.dispose().catch(() => null);

      const dismissed = await dismissTransientUi(page);
      if (!dismissed.ok) {
        return { ok: false, reason: `submit blocked by login/security prompt: ${dismissed.reason}` };
      }
    }
  }

  return {
    ok: false,
    reason: `post button click failed after retrying transient UI: ${lastError?.message || "unknown click failure"}`
  };
}

async function waitForPostAccepted(page, composeLocator, originalMessage) {
  const startedAt = Date.now();
  const timeoutMs = Number(process.env.STOCKTWITS_POST_CONFIRM_TIMEOUT_MS || 15000);
  const messagePrefix = String(originalMessage || "").slice(0, Math.min(40, String(originalMessage || "").length));

  while (Date.now() - startedAt < timeoutMs) {
    const security = await pageLooksLikeSecurityOrLogin(page);
    if (security.blocked) {
      return { ok: false, reason: `login/security prompt after submit: ${security.reason}` };
    }

    const bodyText = await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
    if (/(message sent|posted|your post|successfully posted)/i.test(bodyText)) {
      return { ok: true, reason: "post confirmation text visible" };
    }
    if (/(could not|failed|try again|rate limit|too many|error|not allowed)/i.test(bodyText)) {
      return { ok: false, reason: "Stocktwits error text visible after submit" };
    }

    const composeText = await readLocatorText(composeLocator);
    const stillHasDraft = composeText.includes(messagePrefix) || composeText.includes(String(originalMessage || "").slice(0, 12));
    if (!stillHasDraft && composeText.trim().length === 0) {
      return { ok: true, reason: "composer cleared after submit" };
    }

    await page.waitForTimeout(1000);
  }

  return { ok: false, reason: `post confirmation timed out after ${timeoutMs}ms` };
}

async function isVisible(page, candidate, timeoutMs = 700) {
  const locator = await locatorFromCandidate(page, candidate);
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch (_) {
    return false;
  }
}

async function pageLooksLikeSecurityOrLogin(page) {
  const url = page.url();
  if (/accounts\.google\.com|\/signin|\/login|\/signup|captcha|challenge|mfa|2fa/i.test(url)) {
    return { blocked: true, reason: `login or security URL: ${url}` };
  }

  const loginButtonVisible = await isVisible(page, {
    kind: "role",
    role: "button",
    name: /log in|login|sign in|continue with google/i,
    label: "login button"
  });
  if (loginButtonVisible) return { blocked: true, reason: "login button is visible" };

  const loginLinkVisible = await isVisible(page, {
    kind: "role",
    role: "link",
    name: /log in|login|sign in|create account|sign up/i,
    label: "login link"
  });
  if (loginLinkVisible) return { blocked: true, reason: "login/create-account link is visible" };

  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  if (/(continue with google|create account|sign up to continue)/i.test(bodyText) && !/(what are your thoughts|share an idea|post a message)/i.test(bodyText)) {
    return { blocked: true, reason: "logged-out account controls are visible" };
  }

  if (/(captcha|multi-factor|two-factor|suspicious|verify it'?s you|security check|security verification|unusual traffic|not a bot|cloudflare)/i.test(bodyText)) {
    return { blocked: true, reason: "security checkpoint text is visible" };
  }

  return { blocked: false, reason: "" };
}

async function openBrowser() {
  ensureDir(PROFILE_DIR);
  ensureDir(TRACE_DIR);

  const cdpEndpoint = cleanText(process.env.STOCKTWITS_CDP_ENDPOINT || "");
  if (cdpEndpoint) {
    const browser = await chromium.connectOverCDP(cdpEndpoint);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    return {
      page,
      context,
      usingSharedBrowser: true,
      close: async () => {
        await browser.close().catch(() => null);
      }
    };
  }

  const launchOptions = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    tracesDir: TRACE_DIR,
    args: ["--disable-dev-shm-usage"]
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      ...launchOptions,
      channel: process.env.STOCKTWITS_BROWSER_CHANNEL || "chrome"
    });
  } catch (err) {
    if (process.env.STOCKTWITS_BROWSER_CHANNEL || !shouldAllowBrowserFallback()) {
      const message = [
        "Could not open the dedicated Stocktwits Chrome profile.",
        `Profile: ${PROFILE_DIR}`,
        "This usually means a manual Stocktwits login Chrome window is still open, or Chrome has not released the profile lock yet.",
        "Close every Stocktwits login/automation Chrome window, wait a few seconds, then rerun the command.",
        "The automator will not silently fall back to another browser profile because that profile is usually not logged in."
      ].join(" ");
      logEvent("error", message, { profileDir: PROFILE_DIR, error: err.message });
      err.message = `${message}\nOriginal error: ${err.message}`;
      throw err;
    }

    const fallbackProfileDir = path.join(STOCKTWITS_DIR, ".playwright-profile");
    logEvent("warn", "System Chrome persistent profile could not be opened; falling back to bundled Playwright Chromium because STOCKTWITS_ALLOW_BROWSER_FALLBACK=true.", {
      profileDir: PROFILE_DIR,
      fallbackProfileDir,
      error: err.message
    });
    ensureDir(fallbackProfileDir);
    context = await chromium.launchPersistentContext(fallbackProfileDir, launchOptions);
  }
  const page = context.pages()[0] || await context.newPage();
  return {
    page,
    context,
    usingSharedBrowser: false,
    close: async () => {
      await context.close().catch(() => null);
    }
  };
}

async function waitForManualLoginIfNeeded(page) {
  let state = await pageLooksLikeSecurityOrLogin(page);
  if (!state.blocked) return { ok: true };

  const waitMs = manualLoginWaitMs();
  logEvent("warn", "Stocktwits login or account security is required. Complete it manually in the opened browser; this script will not automate credentials or security checks.", {
    reason: state.reason,
    waitMs
  });

  if (waitMs <= 0) {
    return { ok: false, reason: state.reason };
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    state = await pageLooksLikeSecurityOrLogin(page);
    if (!state.blocked) {
      logEvent("info", "Manual login/security check appears complete; continuing dry-run.");
      return { ok: true };
    }
  }

  return { ok: false, reason: `manual login wait timed out after ${waitMs}ms` };
}

async function runSessionCheck() {
  if (isKillSwitchActive()) {
    logEvent("warn", "Kill switch is active; exiting without opening Stocktwits.", {
      killSwitchFile: KILL_SWITCH_FILE
    });
    return 0;
  }

  const browser = await openBrowser();
  try {
    await browser.page.goto(STOCKTWITS_HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await browser.page.waitForTimeout(2500);

    const state = await pageLooksLikeSecurityOrLogin(browser.page);
    if (state.blocked) {
      const screenshot = await saveScreenshot(browser.page, "session-check-auth-required");
      logEvent("warn", "Stocktwits session check requires manual login/security refresh.", {
        reason: state.reason,
        screenshot
      });
      return 2;
    }

    logEvent("info", "Stocktwits session check passed; the dedicated browser profile appears logged in.", {
      profileDir: PROFILE_DIR,
      url: browser.page.url()
    });
    return 0;
  } finally {
    await browser.close().catch(() => null);
  }
}

async function navigateForPost(page, ticker) {
  const url = shouldPostFromSymbolPage() && ticker
    ? `https://stocktwits.com/symbol/${encodeURIComponent(ticker)}`
    : STOCKTWITS_HOME_URL;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
  await waitForInteractionPacing(
    page,
    "interacting with Stocktwits page",
    "STOCKTWITS_PAGE_SETTLE_DELAY_MIN_MS",
    "STOCKTWITS_PAGE_SETTLE_DELAY_MAX_MS",
    8000,
    15000
  );
}

async function prepareComposer(page, post) {
  await navigateForPost(page, post.ticker);
  const composerMessage = post.composerMessage || post.message;

  const login = await waitForManualLoginIfNeeded(page);
  if (!login.ok) {
    const screenshot = await saveScreenshot(page, "login-required");
    return { ok: false, reason: login.reason, screenshot };
  }

  let composeBox = await findVisibleCandidate(page, COMPOSE_BOX_CANDIDATES, 10000);
  let triggerCandidate = null;

  if (!composeBox) {
    const trigger = await findVisibleCandidate(page, COMPOSE_TRIGGER_CANDIDATES, 5000);
    if (trigger) {
      triggerCandidate = trigger.candidate;
      await trigger.locator.click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      composeBox = await findVisibleCandidate(page, COMPOSE_BOX_CANDIDATES, 10000);
    }
  }

  if (!composeBox) {
    const screenshot = await saveScreenshot(page, "compose-box-not-found");
    return { ok: false, reason: "compose box not found", screenshot };
  }

  try {
    await composeBox.locator.click({ timeout: 5000 });
  } catch (_) {
    await composeBox.locator.click({ timeout: 5000, force: true }).catch(async () => {
      await composeBox.locator.evaluate(element => element.focus());
    });
  }

  await fillComposerText(page, composeBox.locator, composerMessage).catch(async () => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.insertText(composerMessage);
  });

  let filledText = await readLocatorText(composeBox.locator);
  if (!filledText.includes(composerMessage.slice(0, Math.min(20, composerMessage.length)))) {
    await composeBox.locator.evaluate(element => element.focus()).catch(() => null);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => null);
    await page.keyboard.insertText(composerMessage).catch(() => null);
    filledText = await readLocatorText(composeBox.locator);
  }
  const expectedPrefix = composerMessage.slice(0, Math.min(40, composerMessage.length));
  if (!filledText.includes(expectedPrefix)) {
    const screenshot = await saveScreenshot(page, "compose-fill-not-verified");
    return {
      ok: false,
      reason: "compose fill could not be verified",
      screenshot,
      composeSelector: composeBox.candidate.label,
      filledTextPreview: filledText.slice(0, 200)
    };
  }

  const submitElement = await findSubmitButtonNearComposer(composeBox.locator);
  const submitSelector = "button near composer";

  if (!submitElement) {
    const screenshot = await saveScreenshot(page, "post-button-not-found");
    return { ok: false, reason: "post button not found", screenshot, composeSelector: composeBox.candidate.label };
  }

  return {
    ok: true,
    composeSelector: composeBox.candidate.label,
    triggerSelector: triggerCandidate?.label || null,
    submitSelector,
    submitElement,
    composeLocator: composeBox.locator
  };
}

function loadLastDryRun() {
  if (!fs.existsSync(LAST_DRY_RUN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LAST_DRY_RUN_FILE, "utf8"));
  } catch (_) {
    return null;
  }
}

function assertDryRunGate(post, args) {
  if (args.noDryRunGate) return;

  const last = loadLastDryRun();
  if (!last) {
    throw new Error("No successful dry-run record found. Run npm run dry-run first.");
  }
  if (last.id !== post.id || last.messageHash !== post.messageHash) {
    throw new Error("Last successful dry-run does not match the next queued post.");
  }
  const ageMs = Date.now() - new Date(last.ts).getTime();
  const maxAgeMs = Number(process.env.STOCKTWITS_DRY_RUN_MAX_AGE_MS || 30 * 60 * 1000);
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
    throw new Error(`Last successful dry-run is too old (${Math.round(ageMs / 1000)}s).`);
  }
}

function patchPostStatus(queueFile, id, patch) {
  return updateQueue(queueFile, rows => markPostStatus(rows, id, patch));
}

function markTerminalSkips(queueFile, skipped) {
  const terminalSkips = skipped.filter(item => item.terminal && item.id);
  if (!terminalSkips.length) return false;

  return updateQueue(queueFile, rows => {
    let changed = false;
    for (const item of terminalSkips) {
      changed = markPostStatus(rows, item.id, {
        status: "skipped",
        error: item.reason,
        postedAt: ""
      }) || changed;
    }
    return changed;
  });
}

async function run(mode, args, options = {}) {
  if (isKillSwitchActive()) {
    logEvent("warn", "Kill switch is active; exiting without opening Stocktwits.", {
      killSwitchFile: KILL_SWITCH_FILE
    });
    return 0;
  }

  if ((mode === "post-next" || mode === "run-once") && !shouldAllowPost(args)) {
    throw new Error("Posting is disabled. Re-run with --confirm-post or STOCKTWITS_ALLOW_POST=YES only after reviewing a successful dry-run.");
  }

  const queueFile = resolveQueueFile();
  const rows = loadQueue(queueFile);
  const history = readHistory(DEFAULT_HISTORY_FILE);
  const selection = selectNextDuePost(rows, history, new Date(), {
    maxLength: maxLength(),
    minPostIntervalMs: minPostIntervalMs(),
    sourceFilter: sourceFilter()
  });

  if (selection.skipped.length) {
    logEvent("info", "Skipped invalid or not-due queue items while selecting the next post.", {
      skipped: selection.skipped
    });
    markTerminalSkips(queueFile, selection.skipped);
  }

  if (!selection.post) {
    if (selection.cooldown?.active) {
      logEvent("info", "Stocktwits post cooldown is active; no post will be prepared yet.", {
        queueFile,
        sourceFilter: sourceFilter() || null,
        lastPostedAt: selection.cooldown.lastPostedAt,
        nextAllowedAt: selection.cooldown.nextAllowedAt,
        remainingSeconds: Math.ceil(selection.cooldown.remainingMs / 1000),
        minPostIntervalMs: selection.cooldown.minPostIntervalMs
      });
    } else {
      logEvent("info", "No pending due Stocktwits post is ready.", {
        queueFile,
        sourceFilter: sourceFilter() || null
      });
    }
    return 0;
  }

  const post = {
    id: selection.validation.id,
    ticker: selection.validation.ticker,
    message: selection.validation.message,
    messageHash: selection.validation.messageHash,
    composerMessage: stripLeadingCashtagForSymbolPage(selection.validation.message, selection.validation.ticker)
  };

  if (mode === "post-next" || mode === "run-once") {
    assertDryRunGate(post, args);
  }

  const browser = options.browser || await openBrowser();
  let keepOpen = args.keepOpen;
  try {
    logEvent("info", `${mode} preparing Stocktwits post.`, {
      id: post.id,
      ticker: post.ticker,
      messageLength: post.message.length,
      composerMessageLength: post.composerMessage.length,
      queueFile,
      sharedBrowser: browser.usingSharedBrowser,
      postFromSymbolPage: shouldPostFromSymbolPage(),
      sourceFilter: sourceFilter() || null
    });

    const prepared = await prepareComposer(browser.page, post);
    if (!prepared.ok) {
      patchPostStatus(queueFile, post.id, {
        status: "pending",
        error: prepared.reason,
        postedAt: ""
      });
      logEvent("error", "Stocktwits compose preparation failed safely; no post was submitted.", prepared);
      keepOpen = shouldKeepOpenOnFailure(args);
      return 2;
    }

    if (mode === "dry-run") {
      const screenshot = shouldSaveDryRunScreenshot()
        ? await saveScreenshot(browser.page, `dry-run-${post.ticker}-${post.id}`)
        : null;
      writeJsonFileAtomic(LAST_DRY_RUN_FILE, {
        ts: new Date().toISOString(),
        id: post.id,
        ticker: post.ticker,
        messageHash: post.messageHash,
        messageLength: post.message.length,
        composerMessageLength: post.composerMessage.length,
        composeSelector: prepared.composeSelector,
        triggerSelector: prepared.triggerSelector,
        submitSelector: prepared.submitSelector,
        screenshot
      });
      patchPostStatus(queueFile, post.id, {
        status: "pending",
        error: "",
        postedAt: ""
      });
      logEvent("info", "Dry-run completed. The compose box was filled, and the final post button was not clicked.", {
        id: post.id,
        ticker: post.ticker,
        composeSelector: prepared.composeSelector,
        triggerSelector: prepared.triggerSelector,
        submitSelector: prepared.submitSelector,
        screenshot
      });
      return 0;
    }

    const submitted = await clickSubmitButton(browser.page, prepared.composeLocator);
    if (!submitted.ok) {
      const screenshot = await saveScreenshot(browser.page, "submit-click-failed");
      patchPostStatus(queueFile, post.id, {
        status: "pending",
        error: submitted.reason,
        postedAt: ""
      });
      logEvent("error", "Stocktwits submit click failed safely; no confirmed post was submitted.", {
        id: post.id,
        ticker: post.ticker,
        reason: submitted.reason,
        screenshot
      });
      keepOpen = shouldKeepOpenOnFailure(args);
      return 3;
    }

    const accepted = await waitForPostAccepted(browser.page, prepared.composeLocator, post.composerMessage);
    if (!accepted.ok) {
      patchPostStatus(queueFile, post.id, {
        status: "unconfirmed",
        error: accepted.reason,
        postedAt: ""
      });
      logEvent("error", "Stocktwits submit was not confirmed; local queue was not marked posted.", {
        id: post.id,
        ticker: post.ticker,
        reason: accepted.reason
      });
      return 3;
    }

    const postedAt = new Date().toISOString();
    patchPostStatus(queueFile, post.id, {
      status: "posted",
      postedAt,
      error: ""
    });
    appendHistory({
      id: post.id,
      ticker: post.ticker,
      messageHash: post.messageHash,
      messageLength: post.message.length,
      postedAt,
      mode
    });
    logEvent("info", "Submitted one Stocktwits post and updated queue status.", {
      id: post.id,
      ticker: post.ticker,
      postedAt
    });
    return 0;
  } finally {
    if (options.browser) {
      // Caller owns the shared browser lifecycle.
    } else if (!keepOpen) {
      await browser.close();
    } else {
      logEvent("info", "Leaving the browser open for manual review/login. Close it when finished.");
    }
  }
}

async function main() {
  const mode = process.argv[2] || "dry-run";
  if (!["dry-run", "post-next", "run-once", "session-check"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  if (mode === "session-check") {
    const exitCode = await runSessionCheck();
    process.exitCode = exitCode;
    return;
  }
  const args = parseArgs(process.argv);
  const exitCode = await run(mode, args);
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch(err => {
    logEvent("error", err.message, { stack: err.stack });
    process.exitCode = 1;
  });
}

module.exports = {
  openBrowser,
  run,
  runSessionCheck
};
