const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  MOOMOO_DIR,
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
  getPostTickers,
  resolveQueueFile,
  updateQueue,
  writeJsonFileAtomic
} = require("./queue");

const LOG_DIR = path.join(MOOMOO_DIR, "logs");
const SCREENSHOT_DIR = path.join(MOOMOO_DIR, "screenshots");
const PROFILE_DIR = path.resolve(process.env.MOOMOO_PROFILE_DIR || path.join(MOOMOO_DIR, ".chrome-profile"));
const TRACE_DIR = path.join(MOOMOO_DIR, "traces");
const LAST_DRY_RUN_FILE = path.join(MOOMOO_DIR, ".last-dry-run.json");
const KILL_SWITCH_FILE = path.join(MOOMOO_DIR, "KILL_SWITCH");
const DEFAULT_POST_REVIEW_DELAY_MS = 10 * 1000;
const MOOMOO_COMMUNITY_URL = cleanText(process.env.MOOMOO_COMMUNITY_URL || "https://www.moomoo.com/community/nnq");
const MOOMOO_EDITOR_URL = cleanText(process.env.MOOMOO_EDITOR_URL || "https://www.moomoo.com/community/editor");
const MOOMOO_POST_COMMENT = "Join the traderslink group on moomoo for trade ideas, tools & stock chat\nhttps://snsim.moomoo.com/share/channel/3pyPQ?lang=en-us";
const COMMENT_POST_URL_TIMEOUT_MS = 15000;

const COMPOSE_TRIGGER_CANDIDATES = [
  { kind: "css", selector: ".user_module_logined_post_item:has-text('Post')", label: ".user_module_logined_post_item:has-text(Post)" },
  { kind: "css", selector: ".user_module_logined_post_item", label: ".user_module_logined_post_item" },
  { kind: "role", role: "button", name: /post|publish|share|write|compose|create/i, label: "button name post/publish/share/write/compose/create" },
  { kind: "role", role: "link", name: /post|publish|share|write|compose|create/i, label: "link name post/publish/share/write/compose/create" },
  { kind: "css", selector: "button[aria-label*='Post' i]", label: "button[aria-label*=Post]" },
  { kind: "css", selector: "button[aria-label*='Publish' i]", label: "button[aria-label*=Publish]" },
  { kind: "css", selector: "[data-testid*='compose' i]", label: "[data-testid*=compose]" },
  { kind: "css", selector: "[class*='compose' i]", label: "[class*=compose]" }
];

const PRIMARY_COMPOSE_TRIGGER_CANDIDATES = COMPOSE_TRIGGER_CANDIDATES.slice(0, 2);

const COMPOSE_BOX_CANDIDATES = [
  { kind: "css", selector: ".ProseMirror[contenteditable='true']", label: ".ProseMirror[contenteditable=true]" },
  { kind: "css", selector: ".Real-ProseMirror[contenteditable='true']", label: ".Real-ProseMirror[contenteditable=true]" },
  { kind: "role", role: "textbox", name: /share|message|post|idea|what|say|write|comment/i, label: "textbox name share/message/post/idea/what/say/write/comment" },
  { kind: "css", selector: "textarea[placeholder*='post' i]", label: "textarea[placeholder*=post]" },
  { kind: "css", selector: "textarea[placeholder*='Share' i]", label: "textarea[placeholder*=Share]" },
  { kind: "css", selector: "textarea[placeholder*='message' i]", label: "textarea[placeholder*=message]" },
  { kind: "css", selector: "textarea[placeholder*='What' i]", label: "textarea[placeholder*=What]" },
  { kind: "css", selector: "textarea[placeholder*='Say' i]", label: "textarea[placeholder*=Say]" },
  { kind: "css", selector: "[contenteditable='true'][role='textbox']", label: "[contenteditable=true][role=textbox]" },
  { kind: "css", selector: "[contenteditable='true']", label: "[contenteditable=true]" },
  { kind: "css", selector: "textarea", label: "textarea" }
];

const SUBMIT_BUTTON_CANDIDATES = [
  { kind: "css", selector: "#editor-footer .link-submit", label: "#editor-footer .link-submit" },
  { kind: "css", selector: ".link-submit:has-text('Post')", label: ".link-submit:has-text(Post)" },
  { kind: "css", selector: ".link-submit:has-text('Next')", label: ".link-submit:has-text(Next)" },
  { kind: "role", role: "button", name: /^(post|publish|send|share)$/i, label: "button exact post/publish/send/share" },
  { kind: "role", role: "button", name: /^(post|publish|send|share|next)$/i, label: "button exact post/publish/send/share/next" },
  { kind: "role", role: "button", name: /post|publish|send|share|next/i, label: "button name post/publish/send/share/next" },
  { kind: "css", selector: "button[type='submit']", label: "button[type=submit]" },
  { kind: "css", selector: "button[aria-label*='Post' i]", label: "button[aria-label*=Post]" },
  { kind: "css", selector: "button[aria-label*='Publish' i]", label: "button[aria-label*=Publish]" }
];

const COMMENT_BOX_CANDIDATES = [
  { kind: "css", selector: "[class*='comment' i] .ProseMirror[contenteditable='true']", label: "comment .ProseMirror" },
  { kind: "css", selector: "[class*='comment' i] [contenteditable='true']", label: "comment [contenteditable=true]" },
  { kind: "css", selector: "textarea[placeholder*='comment' i]", label: "textarea[placeholder*=comment]" },
  { kind: "css", selector: "textarea[placeholder*='reply' i]", label: "textarea[placeholder*=reply]" },
  { kind: "role", role: "textbox", name: /comment|reply|write a comment|add a comment/i, label: "textbox name comment/reply" }
];

function nowStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function logFilePath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `moomoo-${date}.jsonl`);
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

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const rawArgs = argv.slice(3);
  const args = new Set(rawArgs);
  const commentTickerIndex = rawArgs.indexOf("--ticker");
  return {
    confirmPost: args.has("--confirm-post"),
    keepOpen: args.has("--keep-open"),
    noDryRunGate: args.has("--no-dry-run-gate"),
    commentTicker: cleanText(commentTickerIndex >= 0 ? rawArgs[commentTickerIndex + 1] : "")
  };
}

function isKillSwitchActive() {
  return (
    process.env.MOOMOO_KILL_SWITCH === "1" ||
    /^true$/i.test(process.env.MOOMOO_KILL_SWITCH || "") ||
    fs.existsSync(KILL_SWITCH_FILE)
  );
}

function shouldAllowPost(args) {
  return args.confirmPost || process.env.MOOMOO_ALLOW_POST === "YES";
}

function shouldPostFollowupComment() {
  return process.env.MOOMOO_POST_COMMENT_ENABLED === "YES";
}

function shouldPostFromSymbolPage() {
  return false;
}

function shouldKeepOpenOnFailure(args) {
  return args.keepOpen || process.env.MOOMOO_KEEP_OPEN_ON_FAILURE === "1";
}

function manualLoginWaitMs() {
  const value = Number(process.env.MOOMOO_MANUAL_LOGIN_WAIT_MS || 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function maxLength() {
  const value = Number(process.env.MOOMOO_MAX_LENGTH || DEFAULT_MAX_LENGTH);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_LENGTH;
}

function stripLeadingCashtagForSymbolPage(message, ticker) {
  const text = String(message || "").trim();
  if (!shouldPostFromSymbolPage()) return text;

  const normalizedTicker = cleanText(ticker || "").replace(/^\$/, "").toUpperCase();
  if (!normalizedTicker) return text;

  const autoTagEnabled = !/^false$/i.test(process.env.MOOMOO_SYMBOL_PAGE_AUTO_TAG || "true");
  if (!autoTagEnabled) return text;

  const pattern = new RegExp(`^\\$${normalizedTicker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i");
  return text.replace(pattern, "").trim();
}

function minPostIntervalMs() {
  const value = Number(process.env.MOOMOO_MIN_POST_INTERVAL_MS || DEFAULT_MIN_POST_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_POST_INTERVAL_MS;
}

function postReviewDelayMs() {
  const value = Number(process.env.MOOMOO_POST_REVIEW_DELAY_MS || DEFAULT_POST_REVIEW_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_POST_REVIEW_DELAY_MS;
}

function sourceFilter() {
  return cleanText(process.env.MOOMOO_SOURCE_FILTER || "");
}

function shouldSaveDryRunScreenshot() {
  return !/^false$/i.test(process.env.MOOMOO_SAVE_DRY_RUN_SCREENSHOTS || "true");
}

function shouldDebugSelectors() {
  return process.env.MOOMOO_SELECTOR_DEBUG === "1";
}

function shouldInsertStockCodeTag() {
  return !/^false$/i.test(process.env.MOOMOO_INSERT_STOCK_CODE_TAG || "true");
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

async function startTrace(context, label) {
  if (!context?.tracing) return null;
  ensureDir(TRACE_DIR);
  const safeLabel = cleanText(label).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 64) || "trace";
  const filePath = path.join(TRACE_DIR, `${nowStamp()}-${safeLabel}.zip`);
  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    return { filePath, active: true };
  } catch (err) {
    logEvent("warn", "Could not start Playwright trace capture.", { error: err.message });
    return null;
  }
}

async function stopTrace(context, traceState) {
  if (!traceState?.active || !context?.tracing) return null;
  try {
    await withTimeout(context.tracing.stop({ path: traceState.filePath }), 15000, "trace stop");
    traceState.active = false;
    return traceState.filePath;
  } catch (err) {
    logEvent("warn", "Could not save Playwright trace capture.", { error: err.message });
    return null;
  }
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
      if (shouldDebugSelectors()) {
        logEvent("info", "checking moomoo selector candidate.", {
          candidate: candidate.label,
          timeoutMs
        });
      }
      const visible = await locator.isVisible({ timeout: timeoutMs }).catch(() => false);
      if (!visible) continue;
      if (shouldDebugSelectors()) {
        logEvent("info", "matched moomoo selector candidate.", {
          candidate: candidate.label
        });
      }
      return { locator, candidate };
    } catch (_) {
      // Try the next selector candidate.
    }
  }
  return null;
}

async function clickPrimaryComposeTrigger(page) {
  return withTimeout(page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".user_module_logined_post_item"));
    const postItem = items.find(element => /\bPost\b/i.test(element.textContent || ""));
    if (!postItem) return false;
    postItem.click();
    return true;
  }), 5000, "primary compose trigger click").catch(() => false);
}

async function findPrimaryComposeBox(page, timeoutMs = 10000) {
  const selector = ".ProseMirror[contenteditable='true'], .Real-ProseMirror[contenteditable='true']";
  const found = await withTimeout(page.waitForFunction(sel => {
    const element = document.querySelector(sel);
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }, selector, { timeout: timeoutMs }), timeoutMs + 1000, "primary compose box wait").then(() => true).catch(() => false);

  if (!found) return null;
  return {
    locator: page.locator(selector).first(),
    candidate: COMPOSE_BOX_CANDIDATES[0]
  };
}

async function readLocatorText(locator, timeoutMs = 3000) {
  return locator.evaluate(element => {
    if ("value" in element) return element.value || "";
    return element.innerText || element.textContent || "";
  }, undefined, { timeout: timeoutMs }).catch(() => "");
}

function truncateForTitle(value) {
  const text = cleanText(value || "");
  const maxTitleLength = Number(process.env.MOOMOO_TITLE_MAX_LENGTH || 200);
  const safeMax = Number.isFinite(maxTitleLength) && maxTitleLength > 20 ? maxTitleLength : 200;
  if (text.length <= safeMax) return text;
  return `${text.slice(0, safeMax - 3).trim()}...`;
}

function buildComposerTitle(post) {
  if (cleanText(post?.source || "") === "manual_article" && !cleanText(post?.title || "")) return "";
  const ticker = cleanText(post?.ticker || "").replace(/^\$/, "").replace(/\.US$/i, "").toUpperCase();
  const title = cleanText(post?.title || "").replace(new RegExp(`^\\$?${ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.US)?\\s+`, "i"), "");
  const fallback = cleanText(post?.message || "").split(/\n+/)[0] || "News alert";
  const raw = title || fallback.replace(/^\$?[A-Z0-9.]+\s+/, "").trim();
  return truncateForTitle(raw);
}

function buildComposerBody(post) {
  const summary = cleanText(post?.summary || "");
  if (summary) return summary;

  const title = cleanText(post?.title || "");
  const message = String(post?.message || "").trim();
  if (!title) return message;
  return message.replace(new RegExp(`^\\$?${cleanText(post?.ticker || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "").trim() || message;
}

function normalizeComposerText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function countComposerBodyOccurrences(editorText, composerBody) {
  const haystack = normalizeComposerText(editorText);
  const needle = normalizeComposerText(composerBody);
  if (!needle) return 0;

  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const foundAt = haystack.indexOf(needle, offset);
    if (foundAt < 0) break;
    count += 1;
    offset = foundAt + needle.length;
  }
  return count;
}

async function clearAndFillComposerBody(page, composeLocator, composerBody, postTickers) {
  await composeLocator.click({ timeout: 5000 }).catch(async () => {
    await composeLocator.evaluate(element => element.focus()).catch(() => null);
  });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => null);
  await page.keyboard.press("Backspace").catch(() => null);

  if (shouldInsertStockCodeTag()) {
    const stockCodeTag = await insertStockCodeTags(page, composeLocator, postTickers);
    if (!stockCodeTag.ok) return stockCodeTag;
    await page.keyboard.insertText(composerBody);
    return { ok: true, stockCodeTags: stockCodeTag.tickers };
  }

  await composeLocator.fill(composerBody, { timeout: 5000 }).catch(async () => {
    await composeLocator.evaluate(element => element.focus()).catch(() => null);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => null);
    await page.keyboard.insertText(composerBody);
  });
  return { ok: true, stockCodeTags: [] };
}

async function insertStockCodeTag(page, composeLocator, ticker, options = {}) {
  const normalizedTicker = cleanText(ticker || "").replace(/^\$/, "").replace(/\.US$/i, "").toUpperCase();
  if (!normalizedTicker) return { ok: false, reason: "missing ticker for stock-code tag insertion" };
  const clearBeforeInsert = options.clearBeforeInsert !== false;

  await composeLocator.click({ timeout: 5000 }).catch(async () => {
    await composeLocator.evaluate(element => element.focus()).catch(() => null);
  });
  if (clearBeforeInsert) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => null);
    await page.keyboard.press("Backspace").catch(() => null);
  }

  const opened = await withTimeout(page.evaluate(() => {
    const control = document.querySelector("#stock-code-menu .menu-icon-wrapper") || document.querySelector("#stock-code-menu");
    if (!control) return false;
    control.click();
    return true;
  }), 5000, "stock-code menu open").catch(() => false);

  if (!opened) {
    return { ok: false, reason: "stock-code menu not found" };
  }

  const input = page.locator("#stock-popup input.stock-popup__input").first();
  const inputVisible = await input.isVisible({ timeout: 7000 }).catch(() => false);
  if (!inputVisible) {
    return { ok: false, reason: "stock-code search input not visible" };
  }

  await input.fill(normalizedTicker, { timeout: 5000 });
  await page.waitForTimeout(3500);

  const selected = await withTimeout(page.evaluate(symbol => {
    const items = Array.from(document.querySelectorAll("#stock-popup .stock-popup__list__item"));
    const exact = items.find(item => {
      const code = String(item.querySelector(".stock-popup__list__item__code")?.textContent || "").trim().toUpperCase();
      const market = String(item.querySelector(".stock-popup__list__item__market")?.textContent || "").trim().toUpperCase();
      return code === symbol && (!market || market === "US");
    }) || items.find(item => {
      const code = String(item.querySelector(".stock-popup__list__item__code")?.textContent || "").trim().toUpperCase();
      return code === symbol;
    });
    if (!exact) return false;
    exact.click();
    return true;
  }, normalizedTicker), 7000, "stock-code result select").catch(() => false);

  if (!selected) {
    return { ok: false, reason: `stock-code picker did not find ${normalizedTicker}` };
  }

  await page.waitForTimeout(1000);
  const editorSnapshot = await composeLocator.evaluate(element => ({
    text: String(element.innerText || element.textContent || ""),
    html: String(element.innerHTML || "")
  })).catch(() => ({ text: "", html: "" }));
  const verifier = `${editorSnapshot.text}\n${editorSnapshot.html}`.toUpperCase();
  if (!verifier.includes(normalizedTicker)) {
    return {
      ok: false,
      reason: `stock-code tag insertion not verified for ${normalizedTicker}`,
      textPreview: editorSnapshot.text.slice(0, 200),
      htmlPreview: editorSnapshot.html.slice(0, 300)
    };
  }

  return { ok: true, ticker: normalizedTicker };
}

async function insertStockCodeTags(page, composeLocator, tickers) {
  const normalizedTickers = [...new Set((Array.isArray(tickers) ? tickers : [tickers])
    .map(ticker => cleanText(ticker || "").replace(/^\$/, "").replace(/\.US$/i, "").toUpperCase())
    .filter(Boolean))];
  if (!normalizedTickers.length) {
    return { ok: false, reason: "missing tickers for stock-code tag insertion" };
  }

  const inserted = [];
  for (const ticker of normalizedTickers) {
    const result = await insertStockCodeTag(page, composeLocator, ticker, {
      clearBeforeInsert: inserted.length === 0
    });
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        inserted,
        failedTicker: ticker
      };
    }
    inserted.push(result.ticker);
    await page.keyboard.insertText(inserted.length === normalizedTickers.length ? "\n\n" : " ");
    await page.waitForTimeout(350);
  }

  const editorSnapshot = await composeLocator.evaluate(element => ({
    text: String(element.innerText || element.textContent || ""),
    html: String(element.innerHTML || "")
  })).catch(() => ({ text: "", html: "" }));
  const verifier = `${editorSnapshot.text}\n${editorSnapshot.html}`.toUpperCase();
  const missing = inserted.filter(ticker => !verifier.includes(ticker));
  if (missing.length) {
    return {
      ok: false,
      reason: `stock-code tag insertion not verified for ${missing.join(", ")}`,
      inserted,
      textPreview: editorSnapshot.text.slice(0, 200),
      htmlPreview: editorSnapshot.html.slice(0, 300)
    };
  }

  return { ok: true, tickers: inserted };
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
      const className = String(candidate.className || "");
      if (/\bno-submit\b/.test(className)) return false;
      const text = String(candidate.innerText || candidate.textContent || candidate.getAttribute("aria-label") || "").trim();
      return /^(post|publish|send|share|next)$/i.test(text) || /\b(post|publish|send|share|next)\b/i.test(text);
    }

    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const buttons = Array.from(node.querySelectorAll("button,[role='button'],.link-submit,[class*='submit']")).filter(button => isVisible(button) && isPostButton(button));
      if (buttons.length) {
        return buttons[buttons.length - 1];
      }
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

async function findVisiblePostFlowControl(page, { includeNext = false } = {}) {
  const handle = await page.evaluateHandle(allowNext => {
    function isVisible(candidate) {
      if (!candidate) return false;
      const style = window.getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function buttonText(candidate) {
      return String(candidate.innerText || candidate.textContent || candidate.getAttribute("aria-label") || "").trim();
    }

    const controls = Array.from(document.querySelectorAll("button,[role='button'],.link-submit,[class*='submit']"));
    const matches = controls.filter(control => {
      if (!isVisible(control) || control.disabled || control.getAttribute("aria-disabled") === "true") return false;
      const className = String(control.className || "");
      if (/\bno-submit\b/.test(className)) return false;
      const text = buttonText(control);
      if (allowNext && /^next$/i.test(text)) return true;
      return /^(post|publish|send|share)$/i.test(text);
    });

    return matches[matches.length - 1] || null;
  }, includeNext);

  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => null);
    return null;
  }
  return element;
}

async function controlText(elementHandle) {
  return elementHandle.evaluate(element => String(element.innerText || element.textContent || element.getAttribute("aria-label") || "").trim()).catch(() => "");
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
    if (isKillSwitchActive()) {
      return { ok: false, reason: "Moomoo posting stopped by the desktop stop control before submit." };
    }
    const security = await pageLooksLikeSecurityOrLogin(page);
    if (security.blocked) {
      return { ok: false, reason: `login/security prompt before submit: ${security.reason}` };
    }

    const submitElement = await findSubmitButtonNearComposer(composeLocator);
    if (!submitElement) {
      return { ok: false, reason: "post button not found before submit" };
    }

    try {
      const firstControlText = await controlText(submitElement);
      await submitElement.click({ timeout: 5000 });
      if (/^next$/i.test(firstControlText)) {
        await page.waitForTimeout(1500);
        const finalSubmit = await findVisiblePostFlowControl(page, { includeNext: false });
        if (!finalSubmit) {
          return { ok: false, reason: "final post button not found after clicking Next" };
        }
        if (isKillSwitchActive()) {
          return { ok: false, reason: "Moomoo posting stopped by the desktop stop control before final submit." };
        }
        await finalSubmit.click({ timeout: 5000 });
      }
      return { ok: true };
    } catch (err) {
      lastError = err;
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
  const timeoutMs = Number(process.env.MOOMOO_POST_CONFIRM_TIMEOUT_MS || 15000);
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
      return { ok: false, reason: "MOOMOO error text visible after submit" };
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

function isLikelyMoomooPostUrl(value) {
  try {
    const url = new URL(value);
    if (!/moomoo\.com$/i.test(url.hostname)) return false;
    return /\/community\/feed\//i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

async function findCurrentUserProfileUrl(page) {
  return page.locator("a[href]").evaluateAll(anchors => {
    const candidates = anchors.map(anchor => ({
      href: anchor.href,
      text: String(anchor.innerText || anchor.textContent || "").trim(),
      label: String(anchor.getAttribute("aria-label") || anchor.getAttribute("title") || "").trim(),
      className: String(anchor.className || "")
    })).filter(candidate => /moomoo\.com\/community\//i.test(candidate.href));

    const ownProfile = candidates.find(candidate => /MoonMafia/i.test(`${candidate.text} ${candidate.label}`));
    if (ownProfile) return ownProfile.href;
    const profileLink = candidates.find(candidate => /profile|user|account|avatar/i.test(`${candidate.href} ${candidate.className} ${candidate.label}`));
    return profileLink?.href || "";
  }).catch(() => "");
}

async function findPublishedPostUrlFromProfile(page, post, profileUrl) {
  if (!profileUrl) return "";
  const titleNeedle = cleanText(post?.composerTitle || post?.title || "").slice(0, 120).toLowerCase();
  if (!titleNeedle) return "";

  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const postUrl = await page.locator("a[href]").evaluateAll((anchors, needle) => {
      const links = anchors.map(anchor => {
        const contexts = [];
        let node = anchor;
        for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
          contexts.push(String(node.innerText || node.textContent || ""));
        }
        return { href: anchor.href, text: contexts.join(" ").toLowerCase() };
      });
      return links.find(link => /\/community\/feed\//i.test(link.href) && link.text.includes(needle))?.href || "";
    }, titleNeedle).catch(() => "");
    if (isLikelyMoomooPostUrl(postUrl)) return postUrl;

    await page.mouse.wheel(0, 900).catch(() => null);
    await page.waitForTimeout(1000);
  }

  return "";
}

async function findPublishedPostUrl(page, post) {
  const deadline = Date.now() + COMMENT_POST_URL_TIMEOUT_MS;
  const titleNeedle = cleanText(post?.composerTitle || post?.title || "").slice(0, 80).toLowerCase();

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    if (isLikelyMoomooPostUrl(currentUrl)) return currentUrl;

    const viewPostLink = page.getByRole("link", { name: /view (?:the )?post|view details|see post/i }).first();
    const viewPostVisible = await viewPostLink.isVisible({ timeout: 300 }).catch(() => false);
    if (viewPostVisible) {
      const href = await viewPostLink.getAttribute("href").catch(() => "");
      const resolvedHref = href ? new URL(href, currentUrl).href : "";
      if (isLikelyMoomooPostUrl(resolvedHref)) return resolvedHref;
      await viewPostLink.click({ timeout: 3000 }).catch(() => null);
      await page.waitForTimeout(750);
      if (isLikelyMoomooPostUrl(page.url())) return page.url();
    }

    const linkedPostUrl = await page.locator("a[href]").evaluateAll((anchors, needle) => {
      const communityLinks = anchors
        .filter(anchor => /\/community\/feed\//i.test(anchor.href || ""))
        .map(anchor => ({
          href: anchor.href,
          text: String(anchor.closest("article, [class*='post'], [class*='feed'], [class*='article']")?.innerText || anchor.innerText || "").toLowerCase()
        }));
      const titleMatch = needle ? communityLinks.find(link => link.text.includes(needle)) : null;
      return titleMatch?.href || "";
    }, titleNeedle).catch(() => "");
    if (isLikelyMoomooPostUrl(linkedPostUrl)) return linkedPostUrl;

    await page.waitForTimeout(750);
  }

  const profileUrl = cleanText(post?.profileUrl || "") || await findCurrentUserProfileUrl(page);
  return findPublishedPostUrlFromProfile(page, post, profileUrl);
}

function commentAlreadyVisible(bodyText) {
  const text = String(bodyText || "");
  return text.includes("Join the traderslink group on moomoo for trade ideas, tools & stock chat") &&
    text.includes("https://snsim.moomoo.com/share/channel/3pyPQ?lang=en-us");
}

async function findCommentSubmitButtonNearBox(commentLocator) {
  const handle = await commentLocator.evaluateHandle(element => {
    function visible(candidate) {
      if (!candidate || candidate.disabled || candidate.getAttribute("aria-disabled") === "true") return false;
      const style = window.getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    function isCommentControl(candidate) {
      const text = String(candidate.innerText || candidate.textContent || candidate.getAttribute("aria-label") || "").trim();
      return /^(comment|reply|send|post)$/i.test(text);
    }

    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const controls = Array.from(node.querySelectorAll("button,[role='button'],[class*='submit'],[class*='send']"));
      const match = controls.find(control => visible(control) && isCommentControl(control));
      if (match) return match;
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

async function waitForCommentAccepted(page, commentLocator) {
  const timeoutMs = Number(process.env.MOOMOO_COMMENT_CONFIRM_TIMEOUT_MS || 15000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const security = await pageLooksLikeSecurityOrLogin(page);
    if (security.blocked) return { ok: false, reason: `login/security prompt after comment submit: ${security.reason}` };

    const bodyText = await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
    if (/(could not|failed|try again|rate limit|too many|error|not allowed)/i.test(bodyText)) {
      return { ok: false, reason: "MOOMOO error text visible after comment submit" };
    }

    const inputText = await readLocatorText(commentLocator);
    if (commentAlreadyVisible(bodyText) && !inputText.includes("Join the traderslink group")) {
      return { ok: true, reason: "comment text visible after submit" };
    }
    await page.waitForTimeout(750);
  }

  return { ok: false, reason: `comment confirmation timed out after ${timeoutMs}ms` };
}

async function publishPostComment(page, post) {
  const postUrl = await findPublishedPostUrl(page, post);
  if (!postUrl) return { ok: false, reason: "published post URL could not be identified", postUrl: "" };

  if (page.url() !== postUrl) {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
  }

  const login = await waitForManualLoginIfNeeded(page);
  if (!login.ok) return { ok: false, reason: login.reason, postUrl };

  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  if (commentAlreadyVisible(bodyText)) {
    return { ok: true, alreadyPresent: true, postUrl, reason: "matching comment is already visible" };
  }

  const commentBox = await findVisibleCandidate(page, COMMENT_BOX_CANDIDATES, 10000);
  if (!commentBox) {
    const screenshot = await saveScreenshot(page, "comment-box-not-found");
    const editableCandidates = await page.locator("textarea,[contenteditable='true'],input[type='text']").evaluateAll(elements => elements.map(element => ({
      tag: element.tagName,
      placeholder: element.getAttribute("placeholder") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      className: String(element.className || ""),
      text: String(element.innerText || element.value || "").slice(0, 100)
    }))).catch(() => []);
    return { ok: false, reason: "comment box not found on published post", postUrl, screenshot, editableCandidates };
  }

  await commentBox.locator.fill(MOOMOO_POST_COMMENT, { timeout: 5000 }).catch(async () => {
    await commentBox.locator.click({ timeout: 3000 }).catch(() => null);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => null);
    await page.keyboard.insertText(MOOMOO_POST_COMMENT);
  });

  const filledText = await readLocatorText(commentBox.locator);
  if (!filledText.includes("Join the traderslink group")) {
    return { ok: false, reason: "comment fill could not be verified", postUrl, commentSelector: commentBox.candidate.label };
  }

  const submitElement = await findCommentSubmitButtonNearBox(commentBox.locator);
  if (!submitElement) {
    return { ok: false, reason: "comment submit button not found", postUrl, commentSelector: commentBox.candidate.label };
  }

  try {
    await submitElement.click({ timeout: 5000 });
  } catch (error) {
    return { ok: false, reason: `comment submit click failed: ${error.message}`, postUrl, commentSelector: commentBox.candidate.label };
  } finally {
    await submitElement.dispose().catch(() => null);
  }

  const accepted = await waitForCommentAccepted(page, commentBox.locator);
  return { ...accepted, postUrl, commentSelector: commentBox.candidate.label };
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
  if (/accounts\.google\.com|\/signin|\/login|\/signup|captcha|challenge|mfa|2fa|security|verify/i.test(url)) {
    return { blocked: true, reason: `login or security URL: ${url}` };
  }

  const bodyText = await page.locator("body").textContent({ timeout: 2000 }).catch(() => "");
  const loggedInCommunityEvidence = /(MoonMafia|Drafts\s*\(\d+\)|\bPost\b)/i.test(bodyText) ||
    await isVisible(page, {
      kind: "role",
      role: "link",
      name: /MoonMafia|Drafts\s*\(\d+\)/i,
      label: "logged-in profile or drafts link"
    });

  if (loggedInCommunityEvidence) {
    if (/(captcha|multi-factor|two-factor|suspicious|verify it'?s you|security check|unusual traffic|verification code|identity verification)/i.test(bodyText)) {
      return { blocked: true, reason: "security checkpoint text is visible" };
    }
    return { blocked: false, reason: "" };
  }

  const loginButtonVisible = await isVisible(page, {
    kind: "role",
    role: "button",
    name: /log in|login|sign in|continue with google|continue with apple|open account/i,
    label: "login button"
  });
  if (loginButtonVisible) return { blocked: true, reason: "login button is visible" };

  const loginLinkVisible = await isVisible(page, {
    kind: "role",
    role: "link",
    name: /log in|login|sign in|create account|sign up|open account/i,
    label: "login link"
  });
  if (loginLinkVisible) return { blocked: true, reason: "login/create-account link is visible" };

  if (/(continue with google|continue with apple|log in|create account|open account)/i.test(bodyText) && !/(what are your thoughts|share an idea|post a message|write a post|publish)/i.test(bodyText)) {
    return { blocked: true, reason: "logged-out account controls are visible" };
  }

  if (/(captcha|multi-factor|two-factor|suspicious|verify it'?s you|security check|unusual traffic|verification code|identity verification)/i.test(bodyText)) {
    return { blocked: true, reason: "security checkpoint text is visible" };
  }

  return { blocked: false, reason: "" };
}

async function openBrowser() {
  ensureDir(PROFILE_DIR);
  ensureDir(TRACE_DIR);

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
      channel: process.env.MOOMOO_BROWSER_CHANNEL || "chrome"
    });
  } catch (err) {
    const message = [
      "profile_locked: Could not open the dedicated moomoo Chrome profile.",
      `Profile: ${PROFILE_DIR}`,
      "This usually means a manual moomoo login Chrome window is still open, or Chrome has not released the profile lock yet.",
      "Close every moomoo login/automation Chrome window, wait a few seconds, then rerun the command.",
      "The automator will not silently fall back to another browser profile because that profile is usually not logged in."
    ].join(" ");
    logEvent("error", message, { profileDir: PROFILE_DIR, error: err.message });
    err.message = `${message}\nOriginal error: ${err.message}`;
    throw err;
  }
  const page = context.pages()[0] || await context.newPage();
  return {
    page,
    context,
    usingSharedBrowser: false,
    close: async () => {
      await withTimeout(context.close(), 15000, "browser close").catch(err => {
        logEvent("warn", "Timed out closing moomoo browser context; continuing cleanup.", { error: err.message });
      });
    }
  };
}

async function waitForManualLoginIfNeeded(page) {
  let state = await pageLooksLikeSecurityOrLogin(page);
  if (!state.blocked) return { ok: true };

  const waitMs = manualLoginWaitMs();
  logEvent("warn", "moomoo login or account security is required. Complete it manually in the dedicated Chrome login window; this script will not automate credentials or security checks.", {
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
    logEvent("warn", "Kill switch is active; exiting without opening moomoo.", {
      killSwitchFile: KILL_SWITCH_FILE
    });
    return 0;
  }

  const browser = await openBrowser();
  try {
    await browser.page.goto(MOOMOO_COMMUNITY_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await browser.page.waitForTimeout(2500);

    const state = await pageLooksLikeSecurityOrLogin(browser.page);
    if (state.blocked) {
      const screenshot = await saveScreenshot(browser.page, "session-check-auth-required");
      logEvent("warn", "moomoo session check requires manual login/security refresh.", {
        reason: state.reason,
        screenshot
      });
      return 2;
    }

    logEvent("info", "moomoo session check passed; the dedicated browser profile appears logged in.", {
      profileDir: PROFILE_DIR,
      url: browser.page.url()
    });
    return 0;
  } finally {
    await browser.close().catch(() => null);
  }
}

async function navigateForPost(page, ticker) {
  await page.goto(MOOMOO_EDITOR_URL, { waitUntil: "commit", timeout: 30000 });
  await page.locator("body").waitFor({ state: "attached", timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(2500);
}

async function prepareComposer(page, post) {
  await navigateForPost(page, post.ticker);
  logEvent("info", "moomoo compose page loaded.", {
    ticker: post.ticker,
    url: page.url()
  });
  const composerTitle = buildComposerTitle(post);
  const composerBody = buildComposerBody(post);
  const postTickers = getPostTickers(post);

  const login = await waitForManualLoginIfNeeded(page);
  if (!login.ok) {
    const screenshot = await saveScreenshot(page, "login-required");
    return { ok: false, reason: login.reason, screenshot };
  }
  logEvent("info", "moomoo login/session gate passed for compose preparation.", {
    ticker: post.ticker
  });

  let triggerCandidate = null;
  let composeBox = await findPrimaryComposeBox(page, 10000);
  if (!composeBox) {
    const primaryTriggered = await clickPrimaryComposeTrigger(page);
    if (primaryTriggered) {
      triggerCandidate = PRIMARY_COMPOSE_TRIGGER_CANDIDATES[0];
      logEvent("info", "moomoo primary compose trigger clicked.", {
        triggerSelector: triggerCandidate.label
      });
      await page.waitForTimeout(1000);
      composeBox = await findPrimaryComposeBox(page, 10000);
    }
  }

  if (!composeBox) {
    const trigger = await findVisibleCandidate(page, COMPOSE_TRIGGER_CANDIDATES);
    if (trigger) {
      triggerCandidate = trigger.candidate;
      await trigger.locator.click({ timeout: 5000 }).catch(async () => {
        await trigger.locator.click({ timeout: 3000, force: true }).catch(async () => {
          await trigger.locator.evaluate(element => element.click());
        });
      });
      await page.waitForTimeout(1000);
      composeBox = await findVisibleCandidate(page, COMPOSE_BOX_CANDIDATES, 3000);
    }
  }

  if (!composeBox) {
    const screenshot = await saveScreenshot(page, "compose-box-not-found");
    return { ok: false, reason: "compose box not found", screenshot };
  }
  logEvent("info", "moomoo compose box found.", {
    composeSelector: composeBox.candidate.label,
    triggerSelector: triggerCandidate?.label || null
  });

  const titleBox = page.locator("textarea[placeholder='Title'], textarea.title-input").first();
  const titleVisible = await titleBox.isVisible({ timeout: 1500 }).catch(() => false);
  if (titleVisible) {
    logEvent("info", "moomoo compose title box found.", {
      titleSelector: "textarea[placeholder=Title]",
      titleLength: composerTitle.length
    });
    await titleBox.fill(composerTitle, { timeout: 5000 }).catch(async () => {
      await titleBox.click({ timeout: 3000 }).catch(() => null);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.insertText(composerTitle);
    });
  }

  const initialFill = await clearAndFillComposerBody(page, composeBox.locator, composerBody, postTickers);
  if (!initialFill.ok) {
    const screenshot = await saveScreenshot(page, "stock-code-tag-not-inserted");
    return {
      ok: false,
      reason: initialFill.reason,
      screenshot,
      composeSelector: composeBox.candidate.label,
      stockCodeTag: initialFill
    };
  }
  let stockCodeTags = initialFill.stockCodeTags;
  logEvent("info", "moomoo compose body fill attempted.", {
    bodyLength: composerBody.length,
    composeSelector: composeBox.candidate.label,
    stockCodeTags
  });

  let filledText = await readLocatorText(composeBox.locator);
  let bodyOccurrences = countComposerBodyOccurrences(filledText, composerBody);
  if (bodyOccurrences !== 1) {
    const rebuilt = await clearAndFillComposerBody(page, composeBox.locator, composerBody, postTickers);
    if (!rebuilt.ok) {
      const screenshot = await saveScreenshot(page, "compose-rebuild-failed");
      return { ok: false, reason: rebuilt.reason, screenshot, composeSelector: composeBox.candidate.label };
    }
    stockCodeTags = rebuilt.stockCodeTags;
    filledText = await readLocatorText(composeBox.locator);
    bodyOccurrences = countComposerBodyOccurrences(filledText, composerBody);
  }
  const titleText = titleVisible ? await readLocatorText(titleBox) : "";
  if (titleVisible && !titleText.includes(composerTitle.slice(0, Math.min(20, composerTitle.length)))) {
    const screenshot = await saveScreenshot(page, "compose-title-fill-not-verified");
    return {
      ok: false,
      reason: "compose title fill could not be verified",
      screenshot,
      titleSelector: "textarea[placeholder=Title]",
      titleTextPreview: titleText.slice(0, 200)
    };
  }

  if (bodyOccurrences !== 1) {
    const screenshot = await saveScreenshot(page, "compose-fill-not-verified");
    return {
      ok: false,
      reason: `compose body must appear exactly once before posting; found ${bodyOccurrences} copies`,
      screenshot,
      composeSelector: composeBox.candidate.label,
      filledTextPreview: filledText.slice(0, 200),
      bodyOccurrences
    };
  }

  await page.waitForTimeout(1000);

  const submitElement = await findSubmitButtonNearComposer(composeBox.locator);
  const submitSelector = "submit control near composer";

  if (!submitElement) {
    const screenshot = await saveScreenshot(page, "post-button-not-found");
    return { ok: false, reason: "post button not found", screenshot, composeSelector: composeBox.candidate.label };
  }
  logEvent("info", "moomoo post button found for dry-run/live flow.", {
    submitSelector,
    composeSelector: composeBox.candidate.label
  });

  return {
    ok: true,
    titleSelector: titleVisible ? "textarea[placeholder=Title]" : null,
    composeSelector: composeBox.candidate.label,
    triggerSelector: triggerCandidate?.label || null,
    submitSelector,
      submitElement,
      composeLocator: composeBox.locator,
      composerTitle,
      composerBody,
      stockCodeTag: stockCodeTags[0] || null,
      stockCodeTags
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
    throw new Error("No successful moomoo dry-run record found. Run npm run moomoo:dry-run first.");
  }
  if (last.id !== post.id || last.messageHash !== post.messageHash) {
    throw new Error("Last successful dry-run does not match the next queued post.");
  }
  const ageMs = Date.now() - new Date(last.ts).getTime();
  const maxAgeMs = Number(process.env.MOOMOO_DRY_RUN_MAX_AGE_MS || 30 * 60 * 1000);
  if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
    throw new Error(`Last successful dry-run is too old (${Math.round(ageMs / 1000)}s).`);
  }
}

function patchPostStatus(queueFile, id, patch) {
  return updateQueue(queueFile, rows => markPostStatus(rows, id, patch));
}

function isQueuedPostPending(queueFile, id) {
  const current = loadQueue(queueFile).find(row => cleanText(row?.id || "") === cleanText(id || ""));
  const status = cleanText(current?.status || "pending").toLowerCase();
  return status === "pending" || status === "queued";
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
    logEvent("warn", "Kill switch is active; exiting without opening MOOMOO.", {
      killSwitchFile: KILL_SWITCH_FILE
    });
    return 0;
  }

  if ((mode === "post-next" || mode === "run-once") && !shouldAllowPost(args)) {
    throw new Error("moomoo posting is disabled. Re-run with --confirm-post or MOOMOO_ALLOW_POST=YES only after reviewing a successful dry-run.");
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
      logEvent("info", "MOOMOO post cooldown is active; no post will be prepared yet.", {
        queueFile,
        sourceFilter: sourceFilter() || null,
        lastPostedAt: selection.cooldown.lastPostedAt,
        nextAllowedAt: selection.cooldown.nextAllowedAt,
        remainingSeconds: Math.ceil(selection.cooldown.remainingMs / 1000),
        minPostIntervalMs: selection.cooldown.minPostIntervalMs
      });
    } else {
      logEvent("info", "No pending due MOOMOO post is ready.", {
        queueFile,
        sourceFilter: sourceFilter() || null
      });
    }
    return 0;
  }

  const post = {
    id: selection.validation.id,
    ticker: selection.validation.ticker,
    tickers: selection.validation.tickers,
    source: cleanText(selection.post?.source || ""),
    title: cleanText(selection.post?.title || ""),
    summary: cleanText(selection.post?.summary || ""),
    message: selection.validation.message,
    messageHash: selection.validation.messageHash,
    composerMessage: stripLeadingCashtagForSymbolPage(selection.validation.message, selection.validation.ticker)
  };

  if (mode === "post-next" || mode === "run-once") {
    assertDryRunGate(post, args);
  }

  const browser = options.browser || await openBrowser();
  let traceState = null;
  async function stopRunTrace() {
    const trace = await stopTrace(browser.context, traceState);
    traceState = null;
    return trace;
  }
  let keepOpen = args.keepOpen;
  try {
    traceState = await startTrace(browser.context, `${mode}-${post.ticker}-${post.id}`);
    logEvent("info", `${mode} preparing MOOMOO post.`, {
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
      const trace = await stopRunTrace();
      patchPostStatus(queueFile, post.id, {
        status: "pending",
        error: prepared.reason,
        postedAt: ""
      });
      logEvent("error", "moomoo compose preparation failed safely; no post was submitted.", {
        ...prepared,
        trace
      });
      keepOpen = shouldKeepOpenOnFailure(args);
      return 2;
    }

    if (mode === "dry-run") {
      const screenshot = shouldSaveDryRunScreenshot()
        ? await saveScreenshot(browser.page, `dry-run-${post.ticker}-${post.id}`)
        : null;
      const trace = await stopRunTrace();
      writeJsonFileAtomic(LAST_DRY_RUN_FILE, {
        ts: new Date().toISOString(),
        id: post.id,
        ticker: post.ticker,
        messageHash: post.messageHash,
        messageLength: post.message.length,
        composerMessageLength: post.composerMessage.length,
        composerTitleLength: prepared.composerTitle.length,
        composerBodyLength: prepared.composerBody.length,
        titleSelector: prepared.titleSelector,
        composeSelector: prepared.composeSelector,
        triggerSelector: prepared.triggerSelector,
        submitSelector: prepared.submitSelector,
        stockCodeTag: prepared.stockCodeTag || null,
        stockCodeTags: prepared.stockCodeTags || [],
        screenshot,
        trace
      });
      patchPostStatus(queueFile, post.id, {
        status: "pending",
        error: "",
        postedAt: ""
      });
      logEvent("info", "Dry-run completed. The compose box was filled, and the final post button was not clicked.", {
        id: post.id,
        ticker: post.ticker,
        titleSelector: prepared.titleSelector,
        composeSelector: prepared.composeSelector,
        triggerSelector: prepared.triggerSelector,
        submitSelector: prepared.submitSelector,
        stockCodeTag: prepared.stockCodeTag || null,
        stockCodeTags: prepared.stockCodeTags || [],
        screenshot,
        trace
      });
      return 0;
    }

    post.composerTitle = prepared.composerTitle;
    post.profileUrl = await findCurrentUserProfileUrl(browser.page);
    const reviewDelayMs = postReviewDelayMs();
    if (reviewDelayMs > 0) {
      logEvent("info", "Moomoo post is ready for review before final submit.", {
        id: post.id,
        ticker: post.ticker,
        reviewDelaySeconds: reviewDelayMs / 1000
      });
      await browser.page.waitForTimeout(reviewDelayMs);
    }
    if (isKillSwitchActive() || !isQueuedPostPending(queueFile, post.id)) {
      logEvent("info", "Moomoo post was stopped during the review window; no submit click was made.", {
        id: post.id,
        ticker: post.ticker
      });
      return 3;
    }
    const submitted = await clickSubmitButton(browser.page, prepared.composeLocator);
    if (!submitted.ok) {
      const screenshot = await saveScreenshot(browser.page, "submit-click-failed");
      const trace = await stopRunTrace();
      const stopped = isKillSwitchActive() || !isQueuedPostPending(queueFile, post.id);
      patchPostStatus(queueFile, post.id, {
        status: stopped ? "skipped" : "pending",
        error: stopped
          ? "Stopped by a Moomoo desktop control before posting."
          : submitted.reason,
        postedAt: ""
      });
      logEvent("error", "MOOMOO submit click failed safely; no confirmed post was submitted.", {
        id: post.id,
        ticker: post.ticker,
        reason: submitted.reason,
        screenshot,
        trace
      });
      keepOpen = shouldKeepOpenOnFailure(args);
      return 3;
    }

    const accepted = await waitForPostAccepted(browser.page, prepared.composeLocator, prepared.composerBody || post.composerMessage);
    if (!accepted.ok) {
      const trace = await stopRunTrace();
      patchPostStatus(queueFile, post.id, {
        status: "unconfirmed",
        error: accepted.reason,
        postedAt: ""
      });
      logEvent("error", "MOOMOO submit was not confirmed; local queue was not marked posted.", {
        id: post.id,
        ticker: post.ticker,
        reason: accepted.reason,
        trace
      });
      return 3;
    }

    const postedAt = new Date().toISOString();
    patchPostStatus(queueFile, post.id, {
      status: "posted",
      postedAt,
      error: ""
    });
    const commentEnabled = shouldPostFollowupComment();
    const commentResult = commentEnabled
      ? await publishPostComment(browser.page, post)
      : { ok: true, skipped: true, reason: "follow-up comments are disabled" };
    const commentedAt = commentEnabled && commentResult.ok ? new Date().toISOString() : "";
    const commentStatus = commentEnabled ? (commentResult.ok ? "posted" : "failed") : "disabled";
    patchPostStatus(queueFile, post.id, {
      commentStatus,
      commentedAt,
      commentPostUrl: commentResult.postUrl || "",
      commentError: commentEnabled && !commentResult.ok ? commentResult.reason : ""
    });
    appendHistory({
      id: post.id,
      ticker: post.ticker,
      messageHash: post.messageHash,
      messageLength: post.message.length,
      postedAt,
      commentStatus,
      commentedAt,
      commentPostUrl: commentResult.postUrl || "",
      commentError: commentEnabled && !commentResult.ok ? commentResult.reason : "",
      mode
    });
    if (!commentEnabled) {
      logEvent("info", "MOOMOO follow-up comments are disabled; no comment was added.", {
        id: post.id,
        ticker: post.ticker
      });
    } else if (commentResult.ok) {
      logEvent("info", "Posted the standard MOOMOO follow-up comment on the published post.", {
        id: post.id,
        ticker: post.ticker,
        postUrl: commentResult.postUrl,
        alreadyPresent: Boolean(commentResult.alreadyPresent),
        commentedAt,
        commentSelector: commentResult.commentSelector || null
      });
    } else {
      logEvent("warn", "MOOMOO post was published, but its follow-up comment was not submitted.", {
        id: post.id,
        ticker: post.ticker,
        reason: commentResult.reason,
        postUrl: commentResult.postUrl || null
      });
    }
    const trace = await stopRunTrace();
    logEvent("info", "Submitted one MOOMOO post and updated queue status.", {
      id: post.id,
      ticker: post.ticker,
      postedAt,
      trace
    });
    return 0;
  } finally {
    await stopRunTrace();
    if (options.browser) {
      // Caller owns the shared browser lifecycle.
    } else if (!keepOpen) {
      await browser.close();
    } else {
      logEvent("info", "Leaving the browser open for manual review/login. Close it when finished.");
    }
  }
}

async function commentExistingPost(args) {
  const ticker = cleanText(args.commentTicker || "").replace(/^\$/, "").toUpperCase();
  if (!ticker) throw new Error("comment-post requires --ticker SYMBOL");

  const queueFile = resolveQueueFile();
  const target = loadQueue(queueFile)
    .filter(row => cleanText(row?.ticker || "").toUpperCase() === ticker && cleanText(row?.status || "").toLowerCase() === "posted")
    .sort((left, right) => new Date(right?.postedAt || 0).getTime() - new Date(left?.postedAt || 0).getTime())[0];
  if (!target) throw new Error(`No posted MOOMOO queue item was found for $${ticker}.`);

  const post = {
    id: cleanText(target.id || ""),
    ticker,
    title: cleanText(target.title || ""),
    composerTitle: buildComposerTitle(target)
  };
  const browser = await openBrowser();
  try {
    await browser.page.goto(MOOMOO_COMMUNITY_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await browser.page.waitForTimeout(1500);
    post.profileUrl = await findCurrentUserProfileUrl(browser.page);
    const commentResult = await publishPostComment(browser.page, post);
    const commentedAt = commentResult.ok ? new Date().toISOString() : "";
    patchPostStatus(queueFile, post.id, {
      commentStatus: commentResult.ok ? "posted" : "failed",
      commentedAt,
      commentPostUrl: commentResult.postUrl || "",
      commentError: commentResult.ok ? "" : commentResult.reason
    });
    if (!commentResult.ok) throw new Error(commentResult.reason);

    logEvent("info", "Posted the standard MOOMOO follow-up comment on an existing post.", {
      id: post.id,
      ticker,
      postUrl: commentResult.postUrl,
      alreadyPresent: Boolean(commentResult.alreadyPresent),
      commentedAt,
      commentSelector: commentResult.commentSelector || null
    });
    return 0;
  } finally {
    await browser.close();
  }
}

async function main() {
  const mode = process.argv[2] || "dry-run";
  if (!["dry-run", "post-next", "run-once", "session-check", "comment-post"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  if (mode === "session-check") {
    const exitCode = await runSessionCheck();
    process.exitCode = exitCode;
    return;
  }
  const args = parseArgs(process.argv);
  if (mode === "comment-post") {
    const exitCode = await commentExistingPost(args);
    process.exitCode = exitCode;
    return;
  }
  const exitCode = await run(mode, args);
  process.exitCode = exitCode;
}

if (require.main === module) {
  main()
    .then(() => {
      process.exit(process.exitCode || 0);
    })
    .catch(err => {
      logEvent("error", err.message, { stack: err.stack });
      process.exit(1);
    });
}

module.exports = {
  buildComposerBody,
  buildComposerTitle,
  commentExistingPost,
  openBrowser,
  run,
  runSessionCheck
};
