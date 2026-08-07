const { chromium } = require("playwright");

const {
  DISCORD_EMAIL,
  DISCORD_PASSWORD,
  HOST_CHANNEL_URL,
  DISCORD_WEBHOOK_URL,
  WEBHOOK_OVERRIDE_URL,
  MARKET_CAP_HOST_CHANNEL_URL,
  MARKET_CAP_UNDER_30M_WEBHOOK_URL,
  MARKET_CAP_UNDER_30M_LIMIT,
  MARKET_CAP_30M_TO_50M_WEBHOOK_URL,
  MARKET_CAP_30M_TO_50M_MIN,
  MARKET_CAP_30M_TO_50M_LIMIT,
  MARKET_CAP_50M_TO_100M_WEBHOOK_URL,
  MARKET_CAP_50M_TO_100M_MIN,
  MARKET_CAP_50M_TO_100M_LIMIT,
  OPENAI_API_KEY,
  HEADLESS,
  MAX_SEEN_SNOWFLAKES,
  HOST_STARTUP_BACKFILL_HOURS,
  HOST_STARTUP_BACKFILL_MAX_MESSAGES,
  LIVE_BOT_IDLE_RESTART_MS
} = require("./config");
const { cleanText, rememberSnowflake } = require("./utils");
const {
  updateRunnerHealth,
  updateWatcherHealth,
  markWatcherError,
  getRuntimeHealthSnapshot
} = require("./runtimeHealth");

const seenSnowflakes = new Set();
const recentMessageKeys = new Map();
const RECENT_MESSAGE_WINDOW_MS = 120000;
const MARKET_CAP_ROUTE_TAG_UNDER_30M = "market_cap_under_30m";
const MARKET_CAP_ROUTE_TAG_30M_TO_50M = "market_cap_30m_to_50m";
const MARKET_CAP_ROUTE_TAG_50M_TO_100M = "market_cap_50m_to_100m";
const PR_HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const PR_HEARTBEAT_RECOVERY_MS = 10 * 60 * 1000;
const MARKET_CAP_HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const MARKET_CAP_HEARTBEAT_RECOVERY_MS = 5 * 60 * 1000;
const DISCORD_PAGE_RESPONSIVE_TIMEOUT_MS = 10000;
const DISCORD_WATCHER_ATTACH_TIMEOUT_MS = 3 * 60 * 1000;

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function normalizeDiscordChannelUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.hostname !== "discord.com" || !parsed.pathname.startsWith("/channels/")) {
      return "";
    }

    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch (_) {
    return "";
  }
}

async function closeDuplicateDiscordChannelPages(context, targetUrl, keepPage = null, logPrefix = "[BOT]", ownerTag = null) {
  const normalizedTarget = normalizeDiscordChannelUrl(targetUrl);
  if (!context || !normalizedTarget) return;

  const pages = context.pages ? context.pages() : [];
  for (const candidatePage of pages) {
    if (candidatePage === keepPage || candidatePage.isClosed()) continue;
    if (ownerTag && candidatePage.__traderLinkBotOwner !== ownerTag) continue;

    const pageUrl = normalizeDiscordChannelUrl(candidatePage.url());
    if (pageUrl !== normalizedTarget) continue;

    console.warn(`${logPrefix} Closing duplicate Discord host tab: ${normalizedTarget}`);
    await candidatePage.close().catch(() => {});
  }
}

function canonicalizeMessageId(value) {
  const normalized = cleanText(value || "");
  if (!normalized) return "";
  return normalized.replace(/^_+/, "");
}

function buildRecentMessageKey(data) {
  const canonicalId = canonicalizeMessageId(data?.id);
  if (canonicalId) {
    return canonicalId;
  }

  return [
    String(data?.ticker || "").trim().toUpperCase(),
    String(data?.messageTimestamp || "").trim(),
    cleanText(data?.articleLink || "")
  ].join("|");
}

function rememberRecentMessage(data) {
  const now = Date.now();

  for (const [key, seenAt] of recentMessageKeys.entries()) {
    if (now - seenAt > RECENT_MESSAGE_WINDOW_MS) {
      recentMessageKeys.delete(key);
    }
  }

  const key = buildRecentMessageKey(data);
  if (!key || key.endsWith("|")) {
    return false;
  }

  const priorSeenAt = recentMessageKeys.get(key);
  if (priorSeenAt && now - priorSeenAt <= RECENT_MESSAGE_WINDOW_MS) {
    return true;
  }

  recentMessageKeys.set(key, now);
  return false;
}

function parseMarketCapValue(value) {
  const normalized = cleanText(value || "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .toUpperCase();

  const match = normalized.match(/(?:MC|MARKET\s*CAP)?\s*:?\s*([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/i);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;

  const unit = match[2] || "";
  if (unit === "B") return base * 1000000000;
  if (unit === "M") return base * 1000000;
  if (unit === "K") return base * 1000;
  return base;
}

function isFinitePositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function formatMarketCapBandValue(value) {
  const millions = Number(value) / 1000000;
  if (!Number.isFinite(millions)) return "unknown";

  return `${Number.isInteger(millions) ? String(millions) : String(Number(millions.toFixed(1)))}M`;
}

function buildMarketCapRouteBands() {
  const under30Limit = Number(MARKET_CAP_UNDER_30M_LIMIT);
  const midMin = Number(MARKET_CAP_30M_TO_50M_MIN);
  const midLimit = Number(MARKET_CAP_30M_TO_50M_LIMIT);
  const upperMin = Number(MARKET_CAP_50M_TO_100M_MIN);
  const upperLimit = Number(MARKET_CAP_50M_TO_100M_LIMIT);
  const bands = [];

  if (MARKET_CAP_UNDER_30M_WEBHOOK_URL && isFinitePositiveNumber(under30Limit)) {
    bands.push({
      routeTag: MARKET_CAP_ROUTE_TAG_UNDER_30M,
      minExclusive: null,
      maxInclusive: under30Limit,
      label: `<= $${formatMarketCapBandValue(under30Limit)}`
    });
  }

  if (
    MARKET_CAP_30M_TO_50M_WEBHOOK_URL &&
    isFinitePositiveNumber(midMin) &&
    isFinitePositiveNumber(midLimit) &&
    midLimit > midMin
  ) {
    bands.push({
      routeTag: MARKET_CAP_ROUTE_TAG_30M_TO_50M,
      minExclusive: midMin,
      maxInclusive: midLimit,
      label: `> $${formatMarketCapBandValue(midMin)} and <= $${formatMarketCapBandValue(midLimit)}`
    });
  }

  if (
    MARKET_CAP_50M_TO_100M_WEBHOOK_URL &&
    isFinitePositiveNumber(upperMin) &&
    isFinitePositiveNumber(upperLimit) &&
    upperLimit > upperMin
  ) {
    bands.push({
      routeTag: MARKET_CAP_ROUTE_TAG_50M_TO_100M,
      minExclusive: upperMin,
      maxInclusive: upperLimit,
      label: `> $${formatMarketCapBandValue(upperMin)} and <= $${formatMarketCapBandValue(upperLimit)}`
    });
  }

  return bands;
}

function findMarketCapRouteBand(marketCapValue, marketCapRouteBands = buildMarketCapRouteBands()) {
  return (Array.isArray(marketCapRouteBands) ? marketCapRouteBands : []).find(band => {
    const minExclusive = Number(band?.minExclusive);
    const maxInclusive = Number(band?.maxInclusive);
    const minOk = !Number.isFinite(minExclusive) || marketCapValue > minExclusive;
    const maxOk = !Number.isFinite(maxInclusive) || marketCapValue <= maxInclusive;
    return minOk && maxOk && band?.routeTag;
  }) || null;
}

function normalizeArticleLinks(value) {
  const rawLinks = Array.isArray(value?.articleLinks)
    ? value.articleLinks
    : [value?.articleLink];

  return rawLinks
    .map(link => cleanText(link || ""))
    .filter(Boolean);
}

function buildMarketCapBundleItemId(baseId, sourceIndex, ticker, isBundle) {
  const normalizedBaseId = canonicalizeMessageId(baseId || "");
  const normalizedTicker = cleanText(ticker || "").toUpperCase();

  if (!normalizedBaseId) {
    return `market-cap-${Date.now()}-${sourceIndex}-${normalizedTicker || "UNKNOWN"}`;
  }

  if (!isBundle) {
    return normalizedBaseId;
  }

  return `${normalizedBaseId}:mc${sourceIndex}:${normalizedTicker || "UNKNOWN"}`;
}

function stripTrailingMarketCapLinkText(value) {
  return cleanText(value || "")
    .replace(/\s*[-~]?\s*Link(?:\s*,)?\s*$/i, "")
    .trim();
}

function expandMarketCapBundleData(data, marketCapRouteBands = buildMarketCapRouteBands()) {
  const rawText = cleanText(data?.rawText || "");
  if (!rawText) return [];

  const feedType = cleanText(data?.feedType || "") || "market_cap";

  const articleLinks = normalizeArticleLinks(data);
  if (!articleLinks.length) return [];

  const itemStartPattern = /(^|\s)([0-9][0-9,]*(?:\.[0-9]+)?)\s*([KMB])\s+([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\s*:/gi;
  const starts = Array.from(rawText.matchAll(itemStartPattern)).map(match => ({
    startIndex: Number(match.index || 0) + String(match[1] || "").length,
    marketCap: `${match[2]} ${String(match[3] || "").toUpperCase()}`,
    ticker: cleanText(match[4] || "").toUpperCase()
  }));

  if (!starts.length) {
    const marketCapValue = parseMarketCapValue(data?.marketCap || "");
    const marketCapRouteBand = Number.isFinite(marketCapValue)
      ? findMarketCapRouteBand(marketCapValue, marketCapRouteBands)
      : null;

    if (!marketCapRouteBand) return [];

    return [{
      ...data,
      id: canonicalizeMessageId(data?.id),
      ticker: cleanText(data?.ticker || "").toUpperCase(),
      tickers: Array.isArray(data?.tickers) ? data.tickers : [data?.ticker].filter(Boolean),
      routeTag: marketCapRouteBand.routeTag,
      marketCapValue,
      marketCapRouteLabel: marketCapRouteBand.label || marketCapRouteBand.routeTag,
      feedType,
      articleLink: articleLinks[0],
      articleLinks
    }];
  }

  const isBundle = starts.length > 1 || articleLinks.length > 1;
  const routedItems = [];

  starts.forEach((start, sourceIndex) => {
    const nextStart = starts[sourceIndex + 1]?.startIndex ?? rawText.length;
    const segment = rawText.slice(start.startIndex, nextStart).trim();
    const articleLink = articleLinks[sourceIndex] || null;
    if (!articleLink) return;

    const marketCapValue = parseMarketCapValue(start.marketCap);
    const marketCapRouteBand = Number.isFinite(marketCapValue)
      ? findMarketCapRouteBand(marketCapValue, marketCapRouteBands)
      : null;
    if (!marketCapRouteBand) return;

    const headline = stripTrailingMarketCapLinkText(
      segment.replace(
        new RegExp(`^${start.marketCap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${start.ticker.replace(".", "\\.")}\\s*:\\s*`, "i"),
        ""
      )
    );

    routedItems.push({
      ...data,
      id: buildMarketCapBundleItemId(data?.id, sourceIndex, start.ticker, isBundle),
      ticker: start.ticker,
      tickers: [start.ticker],
      routeTag: marketCapRouteBand.routeTag,
      feedType,
      float: null,
      io: null,
      marketCap: start.marketCap,
      marketCapValue,
      marketCapRouteLabel: marketCapRouteBand.label || marketCapRouteBand.routeTag,
      headline,
      extraInfo: Array.isArray(data?.extraInfo) ? data.extraInfo : [],
      articleLink,
      articleLinks,
      rawText: segment
    });
  });

  return routedItems;
}

async function isDiscordPageResponsive(page, timeoutMs = DISCORD_PAGE_RESPONSIVE_TIMEOUT_MS) {
  return Promise.race([
    page.evaluate(() => document.readyState).then(() => true).catch(() => false),
    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

async function loginToDiscord(page) {
  await page.goto("https://discord.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const serversLocator = page.locator('[aria-label="Servers"]');
  const emailLocator = page.locator('input[name="email"], input[autocomplete="username"]');
  const passwordLocator = page.locator('input[name="password"], input[autocomplete="current-password"]');

  const alreadyLoggedIn = await serversLocator.isVisible({ timeout: 5000 }).catch(() => false);
  if (alreadyLoggedIn) {
    console.log("Logged in");
    updateRunnerHealth({
      phase: "discord_login_ready",
      discordLoggedIn: true,
      discordLoggedInAt: new Date().toISOString()
    }, { immediate: true });
    return;
  }

  await emailLocator.first().waitFor({ state: "visible", timeout: 60000 });
  await emailLocator.first().fill(DISCORD_EMAIL);
  await passwordLocator.first().fill(DISCORD_PASSWORD);

  const submitButton = page.locator('button[type="submit"]');
  if (await submitButton.first().isVisible().catch(() => false)) {
    await submitButton.first().click();
  } else {
    await passwordLocator.first().press("Enter");
  }

  await serversLocator.waitFor({ state: "visible", timeout: 60000 });
  console.log("Logged in");
  updateRunnerHealth({
    phase: "discord_login_ready",
    discordLoggedIn: true,
    discordLoggedInAt: new Date().toISOString()
  }, { immediate: true });
}

async function runLiveDiscordBot(onMessage, options = {}) {
  if (
    !DISCORD_EMAIL ||
    !DISCORD_PASSWORD ||
    !HOST_CHANNEL_URL ||
    (!DISCORD_WEBHOOK_URL && !WEBHOOK_OVERRIDE_URL) ||
    !OPENAI_API_KEY
  ) {
    throw new Error(
      "Missing required environment variables. Set DISCORD_EMAIL, DISCORD_PASSWORD, HOST_CHANNEL_URL (or HOST_CHANNEL_URL_1), a webhook target via DISCORD_WEBHOOK_URL (or DISCORD_WEBHOOK_URL_1) or WEBHOOK_OVERRIDE_URL, and OPENAI_API_KEY."
    );
  }

  const shouldLogin = options.login !== false;
  const externalContext = options.context || null;
  let browser = null;
  const context = externalContext || await (async () => {
    browser = await chromium.launch({ headless: HEADLESS });
    return browser.newContext();
  })();
  updateWatcherHealth("press_release", {
    enabled: true,
    status: "starting",
    pageHealthy: false,
    startedAt: new Date().toISOString(),
    lastError: null,
    lastErrorAt: null
  }, { immediate: true });
  await closeDuplicateDiscordChannelPages(context, HOST_CHANNEL_URL, null, "[PRBOT]", "PRBOT");
  const page = await context.newPage();
  try {
    page.__traderLinkBotOwner = "PRBOT";
    let lastHeartbeatAt = Date.now();
    let lastDetectedMessageAt = Date.now();
    let idleWarningStage = 0;
    let unhealthyChecks = 0;
    let fatalPageError = null;

  page.on("console", msg => {
    const text = msg.text();
    if (text.includes("[PRBOT]")) {
      console.log(text);
    }
  });
  page.on("pageerror", err => {
    console.error("[PRBOT][PAGEERROR]", err.message);
  });
  page.on("crash", () => {
    fatalPageError = new Error("Discord page crashed");
  });
  page.on("close", () => {
    fatalPageError = fatalPageError || new Error("Discord page closed");
  });

  if (shouldLogin) {
    await loginToDiscord(page);
  }

  await page.goto(HOST_CHANNEL_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await closeDuplicateDiscordChannelPages(context, HOST_CHANNEL_URL, page, "[PRBOT]", "PRBOT");
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(8000);
  console.log("Host channel loaded");

  await withTimeout(page.exposeFunction("prbotHeartbeat", async timestamp => {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric) && numeric > 0) {
      lastHeartbeatAt = numeric;
    } else {
      lastHeartbeatAt = Date.now();
    }
  }), DISCORD_WATCHER_ATTACH_TIMEOUT_MS, "press-release heartbeat binding");

  await withTimeout(page.exposeFunction("handleMessageFromPage", async data => {
    try {
      lastDetectedMessageAt = Date.now();
      updateWatcherHealth("press_release", {
        lastDetectedAt: new Date(lastDetectedMessageAt).toISOString(),
        lastDetectedTicker: cleanText(data?.ticker || "").slice(0, 16)
      });
      idleWarningStage = 0;
      data.id = canonicalizeMessageId(data?.id);
      if (seenSnowflakes.has(data.id)) return;
      if (rememberRecentMessage(data)) {
        console.log(`[PRBOT] Skipping duplicate recent message for ${data.ticker} -> ${data.articleLink}`);
        return;
      }
      rememberSnowflake(seenSnowflakes, data.id, MAX_SEEN_SNOWFLAKES);
      await onMessage(data);
      updateWatcherHealth("press_release", {
        lastEnqueuedAt: new Date().toISOString()
      });
    } catch (err) {
      updateWatcherHealth("press_release", {
        lastCallbackErrorAt: new Date().toISOString(),
        lastCallbackError: String(err?.message || err || "").slice(0, 500)
      }, { immediate: true });
      console.error("[ERROR] handleMessageFromPage failed", err);
    }
  }), DISCORD_WATCHER_ATTACH_TIMEOUT_MS, "press-release message binding");

  const startupBackfillHours = Number.isFinite(HOST_STARTUP_BACKFILL_HOURS)
    ? Math.max(0, HOST_STARTUP_BACKFILL_HOURS)
    : 2;
  const startupBackfillMaxMessages = Number.isFinite(HOST_STARTUP_BACKFILL_MAX_MESSAGES)
    ? Math.max(1, Math.floor(HOST_STARTUP_BACKFILL_MAX_MESSAGES))
    : 100;

  await withTimeout(page.evaluate(async ({ maxSeenSnowflakes, startupBackfillHours, startupBackfillMaxMessages }) => {
    console.log("[PRBOT] Watcher injected");

    const seen = new Set();
    const watcherStartedAt = Date.now();
    const startupCutoffTime = watcherStartedAt - startupBackfillHours * 60 * 60 * 1000;
    const easternDateFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const startupEasternDate = easternDateFormatter.format(new Date(watcherStartedAt));
    window.prbotHeartbeat(Date.now());

    function normalize(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function isLikelyArticleLinkInPage(href) {
      try {
        const parsed = new URL(String(href || ""));
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();

        if (hostname.endsWith("sec.gov")) {
          return pathname.includes("-index.htm") || pathname.includes("/archives/");
        }

        if (hostname === "news.nuntiobot.com") {
          return pathname.startsWith("/article/");
        }
        if (hostname === "newsfilter.io" || hostname === "www.newsfilter.io") {
          return pathname.startsWith("/articles/");
        }

        if (hostname.endsWith("globenewswire.com")) {
          return pathname.includes("/news-release/") || pathname.includes("/article/");
        }

        if (hostname.endsWith("accesswire.com")) {
          return pathname.length > 1;
        }

        if (hostname.endsWith("businesswire.com")) {
          return pathname.includes("/news/");
        }

        if (hostname.endsWith("prnewswire.com")) {
          return pathname.includes("/news-releases/") || pathname.includes("/news-release/");
        }

        if (hostname.startsWith("news.") && pathname.length > 1) {
          return true;
        }

        return pathname.includes("/news/") || pathname.includes("/article/");
      } catch (_) {
        return false;
      }
    }

    function addTicker(tickers, value) {
      const ticker = String(value || "")
        .trim()
        .replace(/^\$/, "")
        .toUpperCase();

      const ignoredWords = new Set([
        "SEC",
        "FORM",
        "OPEN",
        "FLOAT",
        "NEWS",
        "PR",
        "CEO",
        "CFO",
        "IPO"
      ]);

      if (
        /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(ticker) &&
        !ignoredWords.has(ticker) &&
        !tickers.includes(ticker)
      ) {
        tickers.push(ticker);
      }
    }

    function extractTickers(contentEl, fullText) {
      const tickers = [];

      contentEl.querySelectorAll("strong > span, strong span, strong, b").forEach(el => {
        addTicker(tickers, el.textContent);
      });

      for (const match of fullText.matchAll(/\$([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b/g)) {
        addTicker(tickers, match[1]);
      }

      const leadingTicker = fullText.match(/^([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b/);
      if (leadingTicker && /(?:Float|IO|MC)\s*:/i.test(fullText)) {
        addTicker(tickers, leadingTicker[1]);
      }

      return tickers;
    }

    function rememberLocalSnowflake(snowflake) {
      if (!snowflake) return;
      seen.add(snowflake);

      while (seen.size > maxSeenSnowflakes) {
        const oldest = seen.values().next().value;
        if (!oldest) break;
        seen.delete(oldest);
      }
    }

    function extractSnowflake(node) {
      const rawValue = (
        node?.getAttribute?.("data-list-item-id")?.replace("chat-messages__", "") ||
        node?.id ||
        null
      );

      return rawValue ? String(rawValue).replace(/^_+/, "") : null;
    }

    function extractUsernameText(node) {
      const directUsername =
        node.querySelector('[id^="message-username-"]') ||
        node.querySelector('[class*="username_"]');

      if (directUsername) {
        return (
          directUsername.getAttribute("data-text") ||
          directUsername.textContent ||
          ""
        ).trim();
      }

      const labelledBy = node.getAttribute("aria-labelledby") || "";
      const usernameId = labelledBy
        .split(/\s+/)
        .find(value => value.startsWith("message-username-"));

      if (!usernameId) return "";

      const referencedUsername = document.getElementById(usernameId);
      if (!referencedUsername) return "";

      return (
        referencedUsername.getAttribute("data-text") ||
        referencedUsername.textContent ||
        ""
      ).trim();
    }

    function extractRouteTag(node) {
      const usernameText = extractUsernameText(node).toLowerCase();
      if (usernameText.includes("spike")) return "spike";
      if (usernameText.includes("drop")) return "drop";
      return "default";
    }

    function parseMessage(node) {
      if (!node) return null;

      const snowflake = extractSnowflake(node);
      if (!snowflake || seen.has(snowflake)) return null;

      const tsAttr = node.querySelector("time")?.getAttribute("datetime");
      const messageTime = tsAttr ? new Date(tsAttr).getTime() : null;
      if (Number.isFinite(messageTime) && messageTime < startupCutoffTime) return null;
      if (
        Number.isFinite(messageTime) &&
        messageTime < watcherStartedAt &&
        easternDateFormatter.format(new Date(messageTime)) !== startupEasternDate
      ) {
        return null;
      }

      const contentEl =
        node.querySelector('[id^="message-content"]') ||
        node.querySelector('[class*="messageContent"]') ||
        node;

      if (!contentEl) return null;

      const fullText = normalize(contentEl.textContent || node.textContent || "");
      if (!fullText) return null;

      let articleLink = null;
      const anchors = node.querySelectorAll("a[href]");
      anchors.forEach(anchor => {
        if (articleLink) return;
        const href = String(anchor.href || "");

        if (isLikelyArticleLinkInPage(href)) {
          articleLink = href;
        }
      });

      if (!articleLink) return null;

      let tickers = extractTickers(contentEl, fullText);
      if (!tickers.length && contentEl !== node) {
        tickers = extractTickers(node, normalize(node.textContent || fullText));
      }
      if (!tickers.length) {
        console.log(`[PRBOT][SKIP] Article link found but no ticker parsed: ${fullText.slice(0, 180)}`);
        return null;
      }

      const primaryTicker = tickers[0];
      const routeTag = extractRouteTag(node);

      const floatMatch = fullText.match(/Float\s*:\s*([\d.,]+ ?[MK]?)/i);
      const ioMatch = fullText.match(/IO\s*:\s*([\d.,%]+)/i);
      const mcMatch = fullText.match(/MC\s*:\s*([\d.,]+ ?[MK]?)/i);

      rememberLocalSnowflake(snowflake);
      console.log(`[PRBOT] Detected new ${primaryTicker} [${routeTag}] -> ${articleLink}`);

      return {
        id: snowflake,
        ticker: primaryTicker,
        tickers,
        messageTimestamp: tsAttr || null,
        observedAt: new Date().toISOString(),
        float: floatMatch ? floatMatch[1] : null,
        io: ioMatch ? ioMatch[1] : null,
        marketCap: mcMatch ? mcMatch[1] : null,
        extraInfo: [],
        articleLink,
        rawText: fullText,
        routeTag,
        feedType: Number.isFinite(messageTime) && messageTime < watcherStartedAt
          ? "host_startup_backfill"
          : null
      };
    }

    function getCandidateNodes(root) {
      if (!(root instanceof HTMLElement)) return [];

      const nodes = [root];
      const messageNodeSelector = [
        '[data-list-item-id^="chat-messages__"]',
        'li[id^="chat-messages-"]',
        'ol[role="list"] li',
        '[role="list"] li'
      ].join(", ");

      root
        .querySelectorAll?.(messageNodeSelector)
        .forEach(node => nodes.push(node));

      return Array.from(new Set(nodes));
    }

    function processAddedNode(root) {
      const candidates = getCandidateNodes(root);
      for (const node of candidates) {
        const data = parseMessage(node);
        if (data) {
          window.handleMessageFromPage(data);
        }
      }
    }

    function processExistingVisibleMessages() {
      const existingNodes = document.querySelectorAll(
        '[data-list-item-id^="chat-messages__"], li[id^="chat-messages-"], ol[role="list"] li, [role="list"] li'
      );
      let processedCount = 0;

      existingNodes.forEach(node => {
        const data = parseMessage(node);
        if (data) {
          processedCount += 1;
          window.handleMessageFromPage(data);
        }
      });

      return processedCount;
    }

    function findScrollableMessageContainer(messageRoot) {
      let candidate = messageRoot;

      for (let depth = 0; candidate && depth < 10; depth += 1) {
        if (
          Number(candidate.scrollHeight) > Number(candidate.clientHeight) + 10 &&
          typeof candidate.scrollTo === "function"
        ) {
          return candidate;
        }
        candidate = candidate.parentElement;
      }

      return messageRoot;
    }

    function getOldestVisibleMessageTime() {
      let oldest = null;
      document.querySelectorAll(
        '[data-list-item-id^="chat-messages__"] time[datetime], li[id^="chat-messages-"] time[datetime], ol[role="list"] li time[datetime], [role="list"] li time[datetime]'
      ).forEach(timeNode => {
        const value = new Date(timeNode.getAttribute("datetime") || "").getTime();
        if (Number.isFinite(value) && (oldest === null || value < oldest)) {
          oldest = value;
        }
      });
      return oldest;
    }

    async function processStartupHistory(messageRoot) {
      const scrollContainer = findScrollableMessageContainer(messageRoot);
      let dispatchedCount = 0;
      let unchangedPasses = 0;
      let previousOldest = null;
      let passes = 0;

      while (passes < 60 && dispatchedCount < startupBackfillMaxMessages) {
        passes += 1;
        dispatchedCount += processExistingVisibleMessages();
        const oldestVisibleTime = getOldestVisibleMessageTime();

        if (oldestVisibleTime !== null && oldestVisibleTime <= startupCutoffTime) {
          break;
        }

        if (oldestVisibleTime === previousOldest) {
          unchangedPasses += 1;
        } else {
          unchangedPasses = 0;
          previousOldest = oldestVisibleTime;
        }

        if (unchangedPasses >= 3) {
          break;
        }

        scrollContainer.scrollTo({ top: 0, behavior: "auto" });
        await new Promise(resolve => setTimeout(resolve, 750));
        window.prbotHeartbeat(Date.now());
      }

      scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" });
      await new Promise(resolve => setTimeout(resolve, 500));
      dispatchedCount += processExistingVisibleMessages();
      console.log(
        `[PRBOT] Startup backfill dispatched ${dispatchedCount} host message(s) from the last ${startupBackfillHours} hour(s) across ${passes} history pass(es)`
      );
    }

    function getMessageListElement() {
      return (
        document.querySelector('[data-list-id="chat-messages"]') ||
        document.querySelector('ol[role="list"]') ||
        document.querySelector('[role="list"][aria-label*="Messages" i]') ||
        document.querySelector('[data-jump-section="global"]')?.closest('[role="list"]') ||
        document.querySelector('main [role="list"]') ||
        document.querySelector('[class*="scrollerInner"]')
      );
    }

    let observedMessageRoot = null;
    let messageObserver = null;

    function connectObserver(messageRoot) {
      messageObserver?.disconnect();
      messageObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            processAddedNode(node);
          }
        }
      });
      messageObserver.observe(messageRoot, { childList: true, subtree: true });
      observedMessageRoot = messageRoot;
      window.__prbotMessageRoot = messageRoot;
      window.__prbotWatcherActive = true;
    }

    async function waitForMessageListElement() {
      let attempts = 0;

      while (true) {
        attempts += 1;
        const messageRoot = getMessageListElement();
        if (messageRoot) return messageRoot;

        if (attempts === 1 || attempts % 10 === 0) {
          console.warn(`[PRBOT] Waiting for message list container (${attempts})`);
        }
        window.__prbotWatcherActive = false;
        window.__prbotMessageRoot = null;
        window.prbotHeartbeat(Date.now());
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    async function attachObserver() {
      const messageRoot = await waitForMessageListElement();
      await processStartupHistory(messageRoot);
      window.__prbotRescan = processExistingVisibleMessages;
      connectObserver(getMessageListElement() || messageRoot);
      console.log("[PRBOT] Live monitoring active");

      setInterval(() => {
        try {
          const currentMessageRoot = getMessageListElement();
          if (!currentMessageRoot) {
            messageObserver?.disconnect();
            observedMessageRoot = null;
            window.__prbotMessageRoot = null;
            window.__prbotWatcherActive = false;
            return;
          }

          if (currentMessageRoot !== observedMessageRoot || !observedMessageRoot?.isConnected) {
            connectObserver(currentMessageRoot);
            console.log("[PRBOT] Reconnected watcher to replaced message list");
          }
          processExistingVisibleMessages();
        } catch (error) {
          console.log(`[PRBOT] Periodic rescan failed: ${error?.message || error}`);
        } finally {
          window.prbotHeartbeat(Date.now());
        }
      }, 10000);
    }

    await attachObserver();
  }, {
    maxSeenSnowflakes: MAX_SEEN_SNOWFLAKES,
    startupBackfillHours,
    startupBackfillMaxMessages
  }), DISCORD_WATCHER_ATTACH_TIMEOUT_MS, "press-release Discord watcher attachment");

  console.log("Listening for messages...");
  updateWatcherHealth("press_release", {
    status: "live",
    pageHealthy: true,
    discordLoggedIn: true,
    liveAt: new Date().toISOString(),
    lastHeartbeatAt: new Date(lastHeartbeatAt).toISOString(),
    lastHealthCheckAt: new Date().toISOString()
  }, { immediate: true });

    while (true) {
      await page.waitForTimeout(30000);

      if (fatalPageError) {
        throw fatalPageError;
      }

      if (page.isClosed()) {
        throw new Error("Discord page closed");
      }

      if (getRuntimeHealthSnapshot().runner?.phase !== "live") {
        continue;
      }

      if (HEADLESS) {
        await withTimeout(
          page.bringToFront(),
          DISCORD_PAGE_RESPONSIVE_TIMEOUT_MS,
          "press-release headless focus"
        ).catch(() => {});
      }

      const heartbeatAgeMs = Date.now() - lastHeartbeatAt;
      if (heartbeatAgeMs > PR_HEARTBEAT_STALE_MS) {
        const pageResponsive = await isDiscordPageResponsive(page);
        if (pageResponsive && heartbeatAgeMs <= PR_HEARTBEAT_RECOVERY_MS) {
          console.warn(`[PRBOT] Watcher heartbeat stale (${heartbeatAgeMs}ms), but Discord page is responsive; keeping tab open.`);
          lastHeartbeatAt = Date.now();
          await page.evaluate(() => {
            window.prbotHeartbeat?.(Date.now());
          }).catch(() => {});
        } else {
          throw new Error(`Discord watcher heartbeat stale (${heartbeatAgeMs}ms)`);
        }
      }

      const pageHealth = await withTimeout(page.evaluate(() => {
        window.__prbotRescan?.();
        const hasMessageList = Boolean(
          document.querySelector('ol[role="list"]') ||
          document.querySelector('[class*="scrollerInner"]') ||
          document.querySelector('[data-list-id="chat-messages"]') ||
          document.querySelector('[role="list"][aria-label*="Messages" i]') ||
          document.querySelector('[data-jump-section="global"]')?.closest('[role="list"]') ||
          document.querySelector('main [role="list"]')
        );
        const watcherActive =
          window.__prbotWatcherActive === true &&
          Boolean(window.__prbotMessageRoot?.isConnected);
        const onLoginPage = Boolean(
          document.querySelector('input[name="email"], input[autocomplete="username"]') ||
          document.querySelector('input[name="password"], input[autocomplete="current-password"]')
        );
        const visibleMessages = Array.from(
          document.querySelectorAll('li[id^="chat-messages-"] time[datetime], [data-list-item-id*="chat-messages"] time[datetime]')
        ).map(timeNode => {
          const messageNode = timeNode.closest('li[id^="chat-messages-"], [data-list-item-id*="chat-messages"]');
          const rawId = messageNode?.getAttribute?.("data-list-item-id") || messageNode?.id || "";
          return {
            at: Date.parse(timeNode.getAttribute("datetime") || ""),
            id: String(rawId).replace("chat-messages__", "").replace(/^_+/, "") || null,
            text: String(messageNode?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1000),
            links: Array.from(messageNode?.querySelectorAll?.("a[href]") || [])
              .map(anchor => String(anchor.href || "")).filter(Boolean).slice(0, 10)
          };
        }).filter(item => Number.isFinite(item.at));
        const latestVisibleMessage = visibleMessages.sort((a, b) => b.at - a.at)[0] || null;

        return {
          healthy: watcherActive && hasMessageList && !onLoginPage,
          onLoginPage,
          latestVisibleMessageAt: latestVisibleMessage?.at || null,
          latestVisibleMessageId: latestVisibleMessage?.id || null,
          latestVisibleMessageText: latestVisibleMessage?.text || null,
          latestVisibleMessageLinks: latestVisibleMessage?.links || []
        };
      }), DISCORD_PAGE_RESPONSIVE_TIMEOUT_MS, "press-release Discord health check").catch(error => {
        console.warn(`[PRBOT] Health check failed: ${error?.message || error}`);
        return { healthy: false, onLoginPage: false, latestVisibleMessageAt: null };
      });
      const healthy = pageHealth.healthy === true;

      unhealthyChecks = healthy ? 0 : unhealthyChecks + 1;
      updateWatcherHealth("press_release", {
        status: healthy ? "live" : "unhealthy",
        pageHealthy: healthy,
        discordLoggedIn: healthy,
        lastHeartbeatAt: new Date(lastHeartbeatAt).toISOString(),
        lastHealthCheckAt: new Date().toISOString(),
        lastVisibleMessageAt: Number.isFinite(pageHealth.latestVisibleMessageAt)
          ? new Date(pageHealth.latestVisibleMessageAt).toISOString()
          : undefined,
        lastVisibleMessageId: pageHealth.latestVisibleMessageId || undefined,
        lastVisibleMessageText: pageHealth.latestVisibleMessageText || undefined,
        lastVisibleMessageLinks: pageHealth.latestVisibleMessageLinks || undefined,
        lastVisibleCheckAt: new Date().toISOString(),
        unhealthyChecks
      });
      if (unhealthyChecks >= 3) {
        throw new Error("Discord page appears unhealthy; restarting watcher");
      }

      const idleAgeMs = Date.now() - lastDetectedMessageAt;
      if (idleAgeMs > 15 * 60 * 1000 && idleWarningStage < 1) {
        idleWarningStage = 1;
        console.warn(
          `[PRBOT] No host messages detected for ${Math.round(idleAgeMs / 60000)} minute(s).`
        );
      } else if (idleAgeMs > 60 * 60 * 1000 && idleWarningStage < 2) {
        idleWarningStage = 2;
        console.warn(
          `[PRBOT] No host messages detected for ${Math.round(idleAgeMs / 60000)} minute(s). Check host channel flow.`
        );
      }

      if (LIVE_BOT_IDLE_RESTART_MS > 0 && idleAgeMs > LIVE_BOT_IDLE_RESTART_MS) {
        throw new Error(
          `No host messages detected for ${Math.round(idleAgeMs / 60000)} minute(s); restarting Discord watcher`
        );
      }
    }
  } catch (error) {
    markWatcherError("press_release", error);
    throw error;
  } finally {
    await page.close().catch(() => {});
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function runMarketCapDiscordBot(onMessage, options = {}) {
  const marketCapRouteBands = buildMarketCapRouteBands();

  if (!MARKET_CAP_HOST_CHANNEL_URL || !marketCapRouteBands.length) {
    updateWatcherHealth("market_cap", {
      enabled: false,
      status: "disabled",
      pageHealthy: true,
      disabledAt: new Date().toISOString()
    }, { immediate: true });
    console.log(
      "[MCBOT] Market-cap feed disabled; set MARKET_CAP_HOST_CHANNEL_URL and at least one market-cap destination webhook to enable it."
    );
    return;
  }

  if (!DISCORD_EMAIL || !DISCORD_PASSWORD || !OPENAI_API_KEY) {
    throw new Error(
      "Missing required market-cap feed environment variables. Set DISCORD_EMAIL, DISCORD_PASSWORD, OPENAI_API_KEY, MARKET_CAP_HOST_CHANNEL_URL, and at least one market-cap destination webhook."
    );
  }

  const shouldLogin = options.login !== false;
  const externalContext = options.context || null;
  let browser = null;
  const context = externalContext || await (async () => {
    browser = await chromium.launch({ headless: HEADLESS });
    return browser.newContext();
  })();
  updateWatcherHealth("market_cap", {
    enabled: true,
    status: "starting",
    pageHealthy: false,
    startedAt: new Date().toISOString(),
    lastError: null,
    lastErrorAt: null
  }, { immediate: true });
  await closeDuplicateDiscordChannelPages(context, MARKET_CAP_HOST_CHANNEL_URL, null, "[MCBOT]", "MCBOT");
  const page = await context.newPage();
  try {
    page.__traderLinkBotOwner = "MCBOT";
    let fatalPageError = null;
    let lastHeartbeatAt = Date.now();
    let lastDetectedMessageAt = null;
    let unhealthyChecks = 0;

  page.on("console", msg => {
    const text = msg.text();
    if (text.includes("[MCBOT]")) {
      console.log(text);
    }
  });
  page.on("pageerror", err => {
    console.error("[MCBOT][PAGEERROR]", err.message);
  });
  page.on("crash", () => {
    fatalPageError = new Error("Market-cap Discord page crashed");
  });
  page.on("close", () => {
    fatalPageError = fatalPageError || new Error("Market-cap Discord page closed");
  });

  if (shouldLogin) {
    await loginToDiscord(page);
  }

  await page.goto(MARKET_CAP_HOST_CHANNEL_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await closeDuplicateDiscordChannelPages(context, MARKET_CAP_HOST_CHANNEL_URL, page, "[MCBOT]", "MCBOT");
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(8000);
  console.log("[MCBOT] Host channel loaded");

  await withTimeout(page.exposeFunction("mcbotHeartbeat", async timestamp => {
    const numeric = Number(timestamp);
    lastHeartbeatAt = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
  }), DISCORD_WATCHER_ATTACH_TIMEOUT_MS, "market-cap heartbeat binding");

  await withTimeout(page.exposeFunction("handleMarketCapMessageFromPage", async data => {
    try {
      lastDetectedMessageAt = Date.now();
      updateWatcherHealth("market_cap", {
        lastDetectedAt: new Date(lastDetectedMessageAt).toISOString(),
        lastDetectedTicker: cleanText(data?.ticker || "").slice(0, 16)
      });
      data.id = canonicalizeMessageId(data?.id);
      if (seenSnowflakes.has(data.id)) return;

      const expandedItems = expandMarketCapBundleData(data, marketCapRouteBands);
      if (!expandedItems.length) {
        rememberSnowflake(seenSnowflakes, data.id, MAX_SEEN_SNOWFLAKES);
        console.log(`[MCBOT] Skipping market-cap message with no configured routed item: ${cleanText(data?.rawText || "").slice(0, 140)}`);
        return;
      }

      if (expandedItems.length > 1) {
        console.log(
          `[MCBOT] Expanded market-cap bundle into ${expandedItems.length} routed item(s): ` +
            expandedItems.map(item => item.ticker).join(", ")
        );
      }

      for (const item of expandedItems) {
        item.id = canonicalizeMessageId(item?.id);
        if (seenSnowflakes.has(item.id)) continue;
        if (rememberRecentMessage(item)) {
          console.log(`[MCBOT] Skipping duplicate recent message for ${item.ticker} -> ${item.articleLink}`);
          continue;
        }

        console.log(`[MCBOT] Detected ${item.ticker} ${item.marketCapRouteLabel || item.routeTag} -> ${item.articleLink}`);
        rememberSnowflake(seenSnowflakes, item.id, MAX_SEEN_SNOWFLAKES);
        await onMessage(item);
        updateWatcherHealth("market_cap", {
          lastEnqueuedAt: new Date().toISOString(),
          lastDetectedTicker: cleanText(item?.ticker || "").slice(0, 16)
        });
      }

      rememberSnowflake(seenSnowflakes, data.id, MAX_SEEN_SNOWFLAKES);
    } catch (err) {
      updateWatcherHealth("market_cap", {
        lastCallbackErrorAt: new Date().toISOString(),
        lastCallbackError: String(err?.message || err || "").slice(0, 500)
      }, { immediate: true });
      console.error("[ERROR] handleMarketCapMessageFromPage failed", err);
    }
  }), DISCORD_WATCHER_ATTACH_TIMEOUT_MS, "market-cap message binding");

  const marketCapStartupBackfillHours = Number.isFinite(HOST_STARTUP_BACKFILL_HOURS)
    ? Math.max(0, HOST_STARTUP_BACKFILL_HOURS)
    : 2;

  await withTimeout(page.evaluate(async ({ maxSeenSnowflakes, marketCapRouteBands, startupBackfillHours }) => {
    console.log("[MCBOT] Watcher injected");

    const seen = new Set();
    const startTime = Date.now();
    const startupCutoffTime = startTime - startupBackfillHours * 60 * 60 * 1000;

    function normalize(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function parseMarketCapValue(value) {
      const normalized = normalize(value)
        .replace(/\$/g, "")
        .replace(/,/g, "")
        .toUpperCase();
      const match = normalized.match(/(?:MC|MARKET\s*CAP)?\s*:?\s*([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/i);
      if (!match) return null;
      const base = Number(match[1]);
      if (!Number.isFinite(base)) return null;
      const unit = match[2] || "";
      if (unit === "B") return base * 1000000000;
      if (unit === "M") return base * 1000000;
      if (unit === "K") return base * 1000;
      return base;
    }

    function findMarketCapRouteBand(marketCapValue) {
      return (Array.isArray(marketCapRouteBands) ? marketCapRouteBands : []).find(band => {
        const minExclusive = Number(band?.minExclusive);
        const maxInclusive = Number(band?.maxInclusive);
        const minOk = !Number.isFinite(minExclusive) || marketCapValue > minExclusive;
        const maxOk = !Number.isFinite(maxInclusive) || marketCapValue <= maxInclusive;
        return minOk && maxOk && band?.routeTag;
      }) || null;
    }

    function isLikelyArticleLink(href) {
      try {
        const parsed = new URL(String(href || ""));
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();

        if (hostname.endsWith("sec.gov")) {
          return pathname.includes("-index.htm") || pathname.includes("/archives/");
        }
        if (hostname === "news.nuntiobot.com") {
          return pathname.startsWith("/article/");
        }
        if (hostname === "newsfilter.io" || hostname === "www.newsfilter.io") {
          return pathname.startsWith("/articles/");
        }
        if (hostname.endsWith("businesswire.com")) {
          return pathname.includes("/news/");
        }
        if (hostname.endsWith("prnewswire.com")) {
          return pathname.includes("/news-releases/") || pathname.includes("/news-release/");
        }
        if (hostname.endsWith("globenewswire.com")) {
          return pathname.includes("/news-release/") || pathname.includes("/article/");
        }
        if (hostname.endsWith("accesswire.com")) {
          return pathname.length > 1;
        }

        return pathname.includes("/news/") || pathname.includes("/article/");
      } catch (_) {
        return false;
      }
    }

    function extractSnowflake(node) {
      const rawValue = (
        node?.getAttribute?.("data-list-item-id")?.replace("chat-messages__", "") ||
        node?.id ||
        null
      );

      return rawValue ? String(rawValue).replace(/^_+/, "") : null;
    }

    function addTicker(tickers, value) {
      const ticker = String(value || "")
        .trim()
        .replace(/^\$/, "")
        .toUpperCase();

      if (/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(ticker) && !tickers.includes(ticker)) {
        tickers.push(ticker);
      }
    }

    function rememberLocalSnowflake(snowflake) {
      if (!snowflake) return;
      seen.add(snowflake);

      while (seen.size > maxSeenSnowflakes) {
        const oldest = seen.values().next().value;
        if (!oldest) break;
        seen.delete(oldest);
      }
    }

    function getContentElement(node) {
      return (
        node.querySelector('[id^="message-content"]') ||
        node.querySelector('[class*="messageContent"]') ||
        node
      );
    }

    function getOrderedTextParts(contentEl) {
      const parts = [];
      const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let current;

      while ((current = walker.nextNode())) {
        if (current.nodeType === Node.TEXT_NODE) {
          const text = normalize(current.textContent);
          if (text) parts.push(text);
          continue;
        }

        if (!(current instanceof HTMLElement)) continue;
        const tagName = current.tagName.toLowerCase();
        if (["span", "strong", "b", "code", "a"].includes(tagName)) {
          const text = normalize(current.innerText || current.textContent);
          if (text && parts[parts.length - 1] !== text) {
            parts.push(text);
          }
        }
      }

      return parts;
    }

    function parseMessage(node) {
      if (!node) return null;

      const snowflake = extractSnowflake(node);
      if (!snowflake || seen.has(snowflake)) return null;

      const tsAttr = node.querySelector("time")?.getAttribute("datetime");
      const messageTime = tsAttr ? new Date(tsAttr).getTime() : null;
      if (Number.isFinite(messageTime) && messageTime < startupCutoffTime) {
        rememberLocalSnowflake(snowflake);
        return null;
      }

      const contentEl = getContentElement(node);
      const fullText = normalize(contentEl?.textContent || node.textContent || "");
      if (!fullText) return null;

      const articleLinks = Array.from(node.querySelectorAll("a[href]"))
        .map(anchor => String(anchor.href || ""))
        .filter(href => isLikelyArticleLink(href));
      if (!articleLinks.length) return null;

      const marketCapTickerPattern = /(^|\s)([0-9][0-9,]*(?:\.[0-9]+)?)\s*([KMB])\s+([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\s*:/i;
      if (!marketCapTickerPattern.test(fullText)) {
        console.log(`[MCBOT][SKIP] Article link found but no market-cap ticker item parsed: ${fullText.slice(0, 180)}`);
        return null;
      }

      rememberLocalSnowflake(snowflake);

      return {
        id: snowflake,
        ticker: "BUNDLE",
        tickers: [],
        messageTimestamp: tsAttr || null,
        observedAt: new Date().toISOString(),
        float: null,
        io: null,
        marketCap: null,
        marketCapValue: null,
        flag: null,
        headline: null,
        extraInfo: [],
        articleLink: articleLinks[0],
        articleLinks,
        rawText: fullText,
        routeTag: "market_cap_bundle",
        feedType: Number.isFinite(messageTime) && messageTime < startTime
          ? "market_cap_startup_backfill"
          : "market_cap"
      };
    }

    function getCandidateNodes(root) {
      if (!(root instanceof HTMLElement)) return [];
      const nodes = [];
      if (
        root.tagName === "LI" ||
        root.matches?.('[data-list-item-id^="chat-messages__"], li[id^="chat-messages-"]')
      ) {
        nodes.push(root);
      }
      root
        .querySelectorAll?.('li, [data-list-item-id^="chat-messages__"], li[id^="chat-messages-"]')
        .forEach(node => nodes.push(node));
      return Array.from(new Set(nodes));
    }

    function processAddedNode(root) {
      for (const node of getCandidateNodes(root)) {
        const data = parseMessage(node);
        if (data) {
          window.handleMarketCapMessageFromPage(data);
        }
      }
    }

    function processStartupVisibleMessages() {
      const nodes = document.querySelectorAll(
        '[data-list-item-id^="chat-messages__"], li[id^="chat-messages-"], ol[role="list"] li, [role="list"] li'
      );
      let dispatched = 0;
      let marked = 0;
      nodes.forEach(node => {
        const data = parseMessage(node);
        if (data) {
          dispatched += 1;
          window.handleMarketCapMessageFromPage(data);
          return;
        }
        const snowflake = extractSnowflake(node);
        if (snowflake && !seen.has(snowflake)) {
          rememberLocalSnowflake(snowflake);
          marked += 1;
        }
      });
      console.log(
        `[MCBOT] Startup backfill dispatched ${dispatched} recent visible message(s) from the last ` +
        `${startupBackfillHours} hour(s); marked ${marked} older/non-candidate message(s) as history`
      );
    }

    function processExistingVisibleMessages() {
      document.querySelectorAll(
        '[data-list-item-id^="chat-messages__"], li[id^="chat-messages-"], ol[role="list"] li, [role="list"] li'
      ).forEach(node => {
        const data = parseMessage(node);
        if (data) {
          window.handleMarketCapMessageFromPage(data);
        }
      });
    }

    function getMessageListElement() {
      return (
        document.querySelector('ol[role="list"]') ||
        document.querySelector('[data-list-id="chat-messages"]') ||
        document.querySelector('[role="list"][aria-label*="Messages" i]') ||
        document.querySelector('[data-jump-section="global"]')?.closest('[role="list"]') ||
        document.querySelector('main [role="list"]') ||
        document.querySelector('[class*="scrollerInner"]')
      );
    }

    window.mcbotHeartbeat(Date.now());
    setInterval(() => {
      window.mcbotHeartbeat(Date.now());
    }, 30000);

    let observedMessageRoot = null;
    let messageObserver = null;

    function connectObserver(messageRoot) {
      messageObserver?.disconnect();
      messageObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            processAddedNode(node);
          }
        }
      });
      messageObserver.observe(messageRoot, { childList: true, subtree: true });
      observedMessageRoot = messageRoot;
      window.__mcbotMessageRoot = messageRoot;
      window.__mcbotWatcherActive = true;
    }

    async function waitForMessageListElement() {
      let attempts = 0;

      while (true) {
        attempts += 1;
        const messageRoot = getMessageListElement();
        if (messageRoot) return messageRoot;

        if (attempts === 1 || attempts % 10 === 0) {
          console.warn(`[MCBOT] Waiting for message list container (${attempts})`);
        }
        window.__mcbotWatcherActive = false;
        window.__mcbotMessageRoot = null;
        window.mcbotHeartbeat(Date.now());
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    async function attachObserver() {
      const messageRoot = await waitForMessageListElement();
      processStartupVisibleMessages();
      window.__mcbotRescan = processExistingVisibleMessages;
      connectObserver(messageRoot);
      console.log("[MCBOT] Live monitoring active");

      setInterval(() => {
        try {
          const currentMessageRoot = getMessageListElement();
          if (!currentMessageRoot) {
            messageObserver?.disconnect();
            observedMessageRoot = null;
            window.__mcbotMessageRoot = null;
            window.__mcbotWatcherActive = false;
            return;
          }

          if (currentMessageRoot !== observedMessageRoot || !observedMessageRoot?.isConnected) {
            connectObserver(currentMessageRoot);
            console.log("[MCBOT] Reconnected watcher to replaced message list");
          }
          processExistingVisibleMessages();
        } catch (error) {
          console.log(`[MCBOT] Periodic rescan failed: ${error?.message || error}`);
        } finally {
          window.mcbotHeartbeat(Date.now());
        }
      }, 10000);
    }

    await attachObserver();
  }, {
    maxSeenSnowflakes: MAX_SEEN_SNOWFLAKES,
    marketCapRouteBands,
    startupBackfillHours: marketCapStartupBackfillHours
  }), DISCORD_WATCHER_ATTACH_TIMEOUT_MS, "market-cap Discord watcher attachment");

  console.log("[MCBOT] Listening for market-cap feed messages...");
  updateWatcherHealth("market_cap", {
    status: "live",
    pageHealthy: true,
    discordLoggedIn: true,
    liveAt: new Date().toISOString(),
    lastHeartbeatAt: new Date(lastHeartbeatAt).toISOString(),
    lastHealthCheckAt: new Date().toISOString()
  }, { immediate: true });

    while (true) {
      await page.waitForTimeout(30000);

      if (fatalPageError) {
        throw fatalPageError;
      }

      if (page.isClosed()) {
        throw new Error("Market-cap Discord page closed");
      }

      if (getRuntimeHealthSnapshot().runner?.phase !== "live") {
        continue;
      }

      if (HEADLESS) {
        await withTimeout(
          page.bringToFront(),
          DISCORD_PAGE_RESPONSIVE_TIMEOUT_MS,
          "market-cap headless focus"
        ).catch(() => {});
      }

      const heartbeatAgeMs = Date.now() - lastHeartbeatAt;
      if (heartbeatAgeMs > MARKET_CAP_HEARTBEAT_STALE_MS) {
        const pageResponsive = await isDiscordPageResponsive(page);

        if (pageResponsive && heartbeatAgeMs <= MARKET_CAP_HEARTBEAT_RECOVERY_MS) {
          console.warn(`[MCBOT] Watcher heartbeat stale (${heartbeatAgeMs}ms), but Discord page is responsive; keeping tab open.`);
          lastHeartbeatAt = Date.now();
        } else {
          throw new Error(`Market-cap watcher heartbeat stale (${heartbeatAgeMs}ms)`);
        }
      }

      const pageHealth = await withTimeout(page.evaluate(() => {
        window.__mcbotRescan?.();
        const hasMessageList = Boolean(
          document.querySelector('ol[role="list"]') ||
          document.querySelector('[data-list-id="chat-messages"]') ||
          document.querySelector('[role="list"][aria-label*="Messages" i]') ||
          document.querySelector('[data-jump-section="global"]')?.closest('[role="list"]') ||
          document.querySelector('main [role="list"]') ||
          document.querySelector('[class*="scrollerInner"]')
        );
        const watcherActive =
          window.__mcbotWatcherActive === true &&
          Boolean(window.__mcbotMessageRoot?.isConnected);
        const onLoginPage = Boolean(
          document.querySelector('input[name="email"], input[autocomplete="username"]') ||
          document.querySelector('input[name="password"], input[autocomplete="current-password"]')
        );
        const visibleMessages = Array.from(
          document.querySelectorAll('li[id^="chat-messages-"] time[datetime], [data-list-item-id*="chat-messages"] time[datetime]')
        ).map(timeNode => {
          const messageNode = timeNode.closest('li[id^="chat-messages-"], [data-list-item-id*="chat-messages"]');
          const rawId = messageNode?.getAttribute?.("data-list-item-id") || messageNode?.id || "";
          return {
            at: Date.parse(timeNode.getAttribute("datetime") || ""),
            id: String(rawId).replace("chat-messages__", "").replace(/^_+/, "") || null,
            text: String(messageNode?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1000),
            links: Array.from(messageNode?.querySelectorAll?.("a[href]") || [])
              .map(anchor => String(anchor.href || "")).filter(Boolean).slice(0, 10)
          };
        }).filter(item => Number.isFinite(item.at));
        const latestVisibleMessage = visibleMessages.sort((a, b) => b.at - a.at)[0] || null;

        return {
          healthy: watcherActive && hasMessageList && !onLoginPage,
          onLoginPage,
          latestVisibleMessageAt: latestVisibleMessage?.at || null,
          latestVisibleMessageId: latestVisibleMessage?.id || null,
          latestVisibleMessageText: latestVisibleMessage?.text || null,
          latestVisibleMessageLinks: latestVisibleMessage?.links || []
        };
      }), DISCORD_PAGE_RESPONSIVE_TIMEOUT_MS, "market-cap Discord health check").catch(error => {
        console.warn(`[MCBOT] Health check failed: ${error?.message || error}`);
        return { healthy: false, onLoginPage: false, latestVisibleMessageAt: null };
      });
      const healthy = pageHealth.healthy === true;

      unhealthyChecks = healthy ? 0 : unhealthyChecks + 1;
      updateWatcherHealth("market_cap", {
        status: healthy ? "live" : "unhealthy",
        pageHealthy: healthy,
        discordLoggedIn: healthy,
        lastHeartbeatAt: new Date(lastHeartbeatAt).toISOString(),
        lastHealthCheckAt: new Date().toISOString(),
        lastVisibleMessageAt: Number.isFinite(pageHealth.latestVisibleMessageAt)
          ? new Date(pageHealth.latestVisibleMessageAt).toISOString()
          : undefined,
        lastVisibleMessageId: pageHealth.latestVisibleMessageId || undefined,
        lastVisibleMessageText: pageHealth.latestVisibleMessageText || undefined,
        lastVisibleMessageLinks: pageHealth.latestVisibleMessageLinks || undefined,
        lastVisibleCheckAt: new Date().toISOString(),
        lastDetectedAt: lastDetectedMessageAt
          ? new Date(lastDetectedMessageAt).toISOString()
          : undefined,
        unhealthyChecks
      });
      if (unhealthyChecks >= 3) {
        throw new Error("Market-cap watcher did not become active; restarting watcher");
      }
    }
  } catch (error) {
    markWatcherError("market_cap", error);
    throw error;
  } finally {
    await page.close().catch(() => {});
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  runLiveDiscordBot,
  runMarketCapDiscordBot,
  loginToDiscord,
  closeDuplicateDiscordChannelPages,
  expandMarketCapBundleData
};
