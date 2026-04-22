const { chromium } = require("playwright");

const {
  DISCORD_EMAIL,
  DISCORD_PASSWORD,
  HOST_CHANNEL_URL,
  DISCORD_WEBHOOK_URL,
  OPENAI_API_KEY,
  HEADLESS,
  MAX_SEEN_SNOWFLAKES
} = require("./config");
const { cleanText, rememberSnowflake } = require("./utils");

const seenSnowflakes = new Set();
const recentMessageKeys = new Map();
const RECENT_MESSAGE_WINDOW_MS = 120000;

function buildRecentMessageKey(data) {
  return [
    String(data?.routeTag || "default").trim().toLowerCase(),
    String(data?.ticker || "").trim().toUpperCase(),
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
}

async function runLiveDiscordBot(onMessage) {
  if (!DISCORD_EMAIL || !DISCORD_PASSWORD || !HOST_CHANNEL_URL || !DISCORD_WEBHOOK_URL || !OPENAI_API_KEY) {
    throw new Error(
      "Missing required environment variables. Set DISCORD_EMAIL, DISCORD_PASSWORD, HOST_CHANNEL_URL (or HOST_CHANNEL_URL_1), DISCORD_WEBHOOK_URL (or DISCORD_WEBHOOK_URL_1), and OPENAI_API_KEY."
    );
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();
  let lastHeartbeatAt = Date.now();
  let lastDetectedMessageAt = Date.now();
  let idleWarningStage = 0;

  page.on("console", msg => {
    const text = msg.text();
    if (text.includes("[PRBOT]")) {
      console.log(text);
    }
  });
  page.on("pageerror", err => {
    console.error("[PRBOT][PAGEERROR]", err.message);
  });

  await loginToDiscord(page);

  await page.goto(HOST_CHANNEL_URL);
  await page.waitForTimeout(8000);
  console.log("Host channel loaded");

  await page.exposeFunction("prbotHeartbeat", async timestamp => {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric) && numeric > 0) {
      lastHeartbeatAt = numeric;
    } else {
      lastHeartbeatAt = Date.now();
    }
  });

  await page.exposeFunction("handleMessageFromPage", async data => {
    try {
      lastDetectedMessageAt = Date.now();
      idleWarningStage = 0;
      if (seenSnowflakes.has(data.id)) return;
      if (rememberRecentMessage(data)) {
        console.log(`[PRBOT] Skipping duplicate recent message for ${data.ticker} -> ${data.articleLink}`);
        return;
      }
      rememberSnowflake(seenSnowflakes, data.id, MAX_SEEN_SNOWFLAKES);
      await onMessage(data);
    } catch (err) {
      console.error("[ERROR] handleMessageFromPage failed", err);
    }
  });

  await page.evaluate(maxSeenSnowflakes => {
    console.log("[PRBOT] Watcher injected");

    const seen = new Set();
    const startTime = Date.now();

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
      return (
        node?.getAttribute?.("data-list-item-id")?.replace("chat-messages__", "") ||
        node?.id ||
        null
      );
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
      if (tsAttr && new Date(tsAttr).getTime() < startTime) return null;

      const contentEl =
        node.querySelector('[id^="message-content"]') ||
        node.querySelector('[class*="messageContent"]') ||
        node;

      if (!contentEl) return null;

      const fullText = normalize(contentEl.textContent || "");
      if (!fullText) return null;

      const tickerEls = contentEl.querySelectorAll("strong > span");
      const tickers = [];
      tickerEls.forEach(el => {
        const ticker = (el.textContent || "").trim().toUpperCase();
        if (/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(ticker)) {
          tickers.push(ticker);
        }
      });

      if (!tickers.length) return null;
      const primaryTicker = tickers[0];
      const routeTag = extractRouteTag(node);

      const floatMatch = fullText.match(/Float\s*:\s*([\d.,]+ ?[MK]?)/i);
      const ioMatch = fullText.match(/IO\s*:\s*([\d.,%]+)/i);
      const mcMatch = fullText.match(/MC\s*:\s*([\d.,]+ ?[MK]?)/i);

      let articleLink = null;
      const anchors = contentEl.querySelectorAll("a[href]");
      anchors.forEach(anchor => {
        if (articleLink) return;
        const href = String(anchor.href || "");

        if (isLikelyArticleLinkInPage(href)) {
          articleLink = href;
        }
      });

      if (!articleLink) return null;

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
        routeTag
      };
    }

    function getCandidateNodes(root) {
      if (!(root instanceof HTMLElement)) return [];

      const nodes = [root];
      root
        .querySelectorAll?.('[data-list-item-id^="chat-messages__"]')
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
      const existingNodes = document.querySelectorAll('[data-list-item-id^="chat-messages__"]');
      let processedCount = 0;

      existingNodes.forEach(node => {
        const data = parseMessage(node);
        if (data) {
          processedCount += 1;
          window.handleMessageFromPage(data);
        }
      });

      console.log(`[PRBOT] Startup scan processed ${processedCount} recent visible message(s)`);
    }

    function attachObserver() {
      const scroller =
        document.querySelector('[class*="scrollerInner"]') ||
        document.querySelector('[data-list-id="chat-messages"]');

      if (!scroller) {
        setTimeout(attachObserver, 1000);
        return;
      }

      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            processAddedNode(node);
          }
        }
      });

      observer.observe(scroller, { childList: true, subtree: true });
      console.log("[PRBOT] Live monitoring active");
      processExistingVisibleMessages();

      setInterval(() => {
        try {
          processExistingVisibleMessages();
          window.prbotHeartbeat(Date.now());
        } catch (error) {
          console.log(`[PRBOT] Periodic rescan failed: ${error?.message || error}`);
        }
      }, 60000);

      setInterval(() => {
        window.prbotHeartbeat(Date.now());
      }, 30000);
    }

    attachObserver();
  }, MAX_SEEN_SNOWFLAKES);

  console.log("Listening for messages...");

  try {
    while (true) {
      await page.waitForTimeout(30000);

      if (page.isClosed()) {
        throw new Error("Discord page closed");
      }

      const heartbeatAgeMs = Date.now() - lastHeartbeatAt;
      if (heartbeatAgeMs > 120000) {
        throw new Error(`Discord watcher heartbeat stale (${heartbeatAgeMs}ms)`);
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
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  runLiveDiscordBot
};
