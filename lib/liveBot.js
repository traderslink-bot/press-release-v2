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
const { rememberSnowflake } = require("./utils");
const { isLikelyArticleLink } = require("./sec");

const seenSnowflakes = new Set();

async function runLiveDiscordBot(onMessage) {
  if (!DISCORD_EMAIL || !DISCORD_PASSWORD || !HOST_CHANNEL_URL || !DISCORD_WEBHOOK_URL || !OPENAI_API_KEY) {
    throw new Error(
      "Missing required environment variables. Set DISCORD_EMAIL, DISCORD_PASSWORD, HOST_CHANNEL_URL (or HOST_CHANNEL_URL_1), DISCORD_WEBHOOK_URL (or DISCORD_WEBHOOK_URL_1), and OPENAI_API_KEY."
    );
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://discord.com/login");
  await page.fill('input[name="email"]', DISCORD_EMAIL);
  await page.fill('input[name="password"]', DISCORD_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('[aria-label="Servers"]', { timeout: 60000 });
  console.log("Logged in");

  await page.goto(HOST_CHANNEL_URL);
  await page.waitForTimeout(8000);
  console.log("Host channel loaded");

  await page.exposeFunction("handleMessageFromPage", async data => {
    try {
      if (seenSnowflakes.has(data.id)) return;
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

        if (isLikelyArticleLink(href)) {
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
    }

    attachObserver();
  }, MAX_SEEN_SNOWFLAKES);

  console.log("Listening for messages...");
}

module.exports = {
  runLiveDiscordBot
};
