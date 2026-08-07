const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const DEFAULT_ENV_FILE = ".env";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, "..", "..");

function resolveEnvFile(configuredEnvFile) {
  if (configuredEnvFile) {
    const explicitPath = path.isAbsolute(configuredEnvFile)
      ? configuredEnvFile
      : path.resolve(process.cwd(), configuredEnvFile);

    if (!fs.existsSync(explicitPath)) {
      throw new Error(`Configured ENV_FILE was not found: ${explicitPath}`);
    }

    return explicitPath;
  }

  const candidates = [
    path.join(PROJECT_ROOT, ".env.press_release_v2"),
    path.join(PROJECT_ROOT, ".env.press_release_v2.example"),
    path.join(WORKSPACE_ROOT, ".env.press_release_v2"),
    path.join(WORKSPACE_ROOT, ".env.press_release_v2.example"),
    path.join(process.cwd(), DEFAULT_ENV_FILE)
  ];

  return candidates.find(candidate => fs.existsSync(candidate)) || path.join(process.cwd(), DEFAULT_ENV_FILE);
}

const resolvedEnvFile = resolveEnvFile(process.env.ENV_FILE);
dotenv.config({ path: resolvedEnvFile, quiet: true });

function normalizeTickerDisplayVariant(value) {
  return String(value || "standalone_dollar")
    .trim()
    .toLowerCase()
    .replace(/[^a-z_]/g, "");
}

function normalizeSecTextMode(value) {
  const normalized = String(value || "targeted")
    .trim()
    .toLowerCase();

  return normalized === "full" ? "full" : "targeted";
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseList(value, fallback = []) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  return String(value)
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

const OPENAI_TEMPERATURE = (() => {
  const rawValue = process.env.PRESS_RELEASE_OPENAI_TEMPERATURE;
  return parseOptionalNumber(rawValue);
})();

const ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS = (() => {
  if (!Object.prototype.hasOwnProperty.call(process.env, "ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS")) {
    return [];
  }

  return String(process.env.ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
})();

const FREE_NEWS_BOT_DEFAULT_ROUTE_TAGS = [
  "default",
  "market_cap_under_30m",
  "market_cap_30m_to_50m",
  "market_cap_50m_to_100m"
];

module.exports = {
  DISCORD_EMAIL: process.env.DISCORD_EMAIL,
  DISCORD_PASSWORD: process.env.DISCORD_PASSWORD,
  HOST_CHANNEL_URL: process.env.HOST_CHANNEL_URL || process.env.HOST_CHANNEL_URL_1,
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL_1,
  NEWS_FILTERED_SECOND_WEBHOOK_URL: process.env.NEWS_FILTERED_SECOND_WEBHOOK_URL,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || "",
  DISCORD_BOT_APPLICATION_ID:
    process.env.DISCORD_BOT_APPLICATION_ID || process.env.DISCORD_BOT_CLIENT_ID || "",
  DISCORD_BOT_API_BASE_URL: process.env.DISCORD_BOT_API_BASE_URL || "https://discord.com/api/v10",
  DISCORD_BOT_PERMISSIONS: process.env.DISCORD_BOT_PERMISSIONS || "19456",
  DISCORD_FREE_NEWS_BOT_ENABLED: /^true$/i.test(process.env.DISCORD_FREE_NEWS_BOT_ENABLED || "false"),
  DISCORD_FREE_NEWS_BOT_SELF_SERVE_ENABLED: /^true$/i.test(
    process.env.DISCORD_FREE_NEWS_BOT_SELF_SERVE_ENABLED || "false"
  ),
  DISCORD_FREE_NEWS_BOT_SETUP_TEST_URL:
    process.env.DISCORD_FREE_NEWS_BOT_SETUP_TEST_URL ||
    "https://traderslink.pro/news/free/TEST/free-news-bot-permission-test",
  DISCORD_FREE_NEWS_BOT_ROUTE_TAGS: parseList(
    process.env.DISCORD_FREE_NEWS_BOT_ROUTE_TAGS,
    FREE_NEWS_BOT_DEFAULT_ROUTE_TAGS
  ).map(item => item.toLowerCase()),
  DISCORD_FREE_NEWS_SUBSCRIBERS_FILE:
    process.env.DISCORD_FREE_NEWS_SUBSCRIBERS_FILE &&
    String(process.env.DISCORD_FREE_NEWS_SUBSCRIBERS_FILE).trim()
      ? path.resolve(process.cwd(), process.env.DISCORD_FREE_NEWS_SUBSCRIBERS_FILE)
      : path.join(PROJECT_ROOT, "data", "free_news_discord_subscribers.json"),
  DROP_WEBHOOK_URL: process.env.DROP_WEBHOOK_URL,
  MARKET_CAP_HOST_CHANNEL_URL: process.env.MARKET_CAP_HOST_CHANNEL_URL,
  MARKET_CAP_UNDER_30M_WEBHOOK_URL: process.env.MARKET_CAP_UNDER_30M_WEBHOOK_URL,
  NEWS_UNDER_30M_MC_SECOND_WEBHOOK_URL: process.env.NEWS_UNDER_30M_MC_SECOND_WEBHOOK_URL,
  MARKET_CAP_UNDER_30M_LIMIT: Number(process.env.MARKET_CAP_UNDER_30M_LIMIT || 30000000),
  MARKET_CAP_30M_TO_50M_WEBHOOK_URL: process.env.MARKET_CAP_30M_TO_50M_WEBHOOK_URL,
  NEWS_UNDER_50M_MC_SECOND_WEBHOOK_URL: process.env.NEWS_UNDER_50M_MC_SECOND_WEBHOOK_URL,
  MARKET_CAP_30M_TO_50M_MIN: Number(
    process.env.MARKET_CAP_30M_TO_50M_MIN ||
    process.env.MARKET_CAP_UNDER_30M_LIMIT ||
    30000000
  ),
  MARKET_CAP_30M_TO_50M_LIMIT: Number(process.env.MARKET_CAP_30M_TO_50M_LIMIT || 50000000),
  MARKET_CAP_50M_TO_100M_WEBHOOK_URL: process.env.MARKET_CAP_50M_TO_100M_WEBHOOK_URL,
  NEWS_UNDER_100M_MC_SECOND_WEBHOOK_URL: process.env.NEWS_UNDER_100M_MC_SECOND_WEBHOOK_URL,
  MARKET_CAP_50M_TO_100M_MIN: Number(
    process.env.MARKET_CAP_50M_TO_100M_MIN ||
    process.env.MARKET_CAP_30M_TO_50M_LIMIT ||
    50000000
  ),
  MARKET_CAP_50M_TO_100M_LIMIT: Number(process.env.MARKET_CAP_50M_TO_100M_LIMIT || 100000000),
  MARKET_CAP_MAX_EVENT_AGE_MS: Number(process.env.MARKET_CAP_MAX_EVENT_AGE_MS || 30000),
  HOST_DISCORD_MAX_EVENT_AGE_MS: Number(process.env.HOST_DISCORD_MAX_EVENT_AGE_MS || 2 * 60 * 60 * 1000),
  WEBHOOK_OVERRIDE_URL: process.env.WEBHOOK_OVERRIDE_URL,
  WEBHOOK_OVERRIDE_DILUTION_ONLY: /^true$/i.test(process.env.WEBHOOK_OVERRIDE_DILUTION_ONLY || "false"),
  SEC_USER_AGENT:
    process.env.SEC_USER_AGENT ||
    "TraderLinkBot/1.0 thisguytraderslink@gmail.com",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.PRESS_RELEASE_OPENAI_MODEL || "gpt-5-mini",
  OPENAI_TEMPERATURE,
  OPENAI_PRICE_INPUT_PER_1M: parseOptionalNumber(process.env.OPENAI_PRICE_INPUT_PER_1M),
  OPENAI_PRICE_CACHED_INPUT_PER_1M: parseOptionalNumber(process.env.OPENAI_PRICE_CACHED_INPUT_PER_1M),
  OPENAI_PRICE_OUTPUT_PER_1M: parseOptionalNumber(process.env.OPENAI_PRICE_OUTPUT_PER_1M),
  HEADLESS: /^true$/i.test(process.env.HEADLESS || "false"),
  PLAYWRIGHT_BLOCK_IMAGES: /^true$/i.test(process.env.PLAYWRIGHT_BLOCK_IMAGES || "false"),
  PYTHON_EXECUTABLE: process.env.PYTHON_EXECUTABLE || "py",
  LEVELS_SCRIPT_PATH:
    process.env.LEVELS_SCRIPT_PATH ||
    "C:\\Users\\jerac\\Documents\\TraderLink\\playwright\\levels\\levels_clean_output.py",
  LEVELS_TIMEOUT_MS: Number(process.env.LEVELS_TIMEOUT_MS || 120000),
  LEVELS_CACHE_MS: Number(process.env.LEVELS_CACHE_MS || 5 * 60 * 1000),
  LEVELS_MAX_CONCURRENT: Number(process.env.LEVELS_MAX_CONCURRENT || 2),
  INGEST_DATABASE_PATH:
    process.env.INGEST_DATABASE_PATH && String(process.env.INGEST_DATABASE_PATH).trim()
      ? path.resolve(process.cwd(), process.env.INGEST_DATABASE_PATH)
      : path.join(PROJECT_ROOT, "data", "press_release_ingest.sqlite"),
  HTTP_TIMEOUT_MS: Number(process.env.HTTP_TIMEOUT_MS || 20000),
  ARTICLE_CACHE_DIR:
    (process.env.ARTICLE_CACHE_DIR || process.env.SHARED_ARTICLE_CACHE_DIR) &&
    String(process.env.ARTICLE_CACHE_DIR || process.env.SHARED_ARTICLE_CACHE_DIR).trim()
      ? path.resolve(process.cwd(), process.env.ARTICLE_CACHE_DIR || process.env.SHARED_ARTICLE_CACHE_DIR)
      : path.join(PROJECT_ROOT, "cache", "article_fetch"),
  ARTICLE_SHARED_CACHE_WAIT_MS: Number(process.env.ARTICLE_SHARED_CACHE_WAIT_MS || 15000),
  ARTICLE_SHARED_CACHE_POLL_MS: Number(process.env.ARTICLE_SHARED_CACHE_POLL_MS || 1000),
  ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS,
  ARTICLE_FETCH_LOG_FILE:
    process.env.ARTICLE_FETCH_LOG_FILE && String(process.env.ARTICLE_FETCH_LOG_FILE).trim()
      ? path.resolve(process.cwd(), process.env.ARTICLE_FETCH_LOG_FILE)
      : path.join(PROJECT_ROOT, "docs", "live_fetch_tracking", "live_events.jsonl"),
  ARTICLE_FETCH_LOG_ENABLED: !/^false$/i.test(process.env.ARTICLE_FETCH_LOG_ENABLED || "true"),
  NUNTIO_MIN_INTERVAL_MS: Number(process.env.NUNTIO_MIN_INTERVAL_MS || 15000),
  NUNTIO_COOLDOWN_MS: Number(process.env.NUNTIO_COOLDOWN_MS || 60000),
  NUNTIO_MAX_RETRIES: Number(process.env.NUNTIO_MAX_RETRIES || 3),
  OPENAI_TIMEOUT_MS: Number(process.env.OPENAI_TIMEOUT_MS || 45000),
  OPENAI_URL_FALLBACK_ENABLED: /^true$/i.test(process.env.OPENAI_URL_FALLBACK_ENABLED || "true"),
  OPENAI_URL_FALLBACK_TIMEOUT_MS: Number(
    process.env.OPENAI_URL_FALLBACK_TIMEOUT_MS || process.env.OPENAI_TIMEOUT_MS || 45000
  ),
  OPENAI_URL_FALLBACK_MAX_RETRIES: Number(
    process.env.OPENAI_URL_FALLBACK_MAX_RETRIES || process.env.OPENAI_MAX_RETRIES || 1
  ),
  OPENAI_MAX_RETRIES: Number(process.env.OPENAI_MAX_RETRIES || 2),
  REVIEW_TIMEOUT_MS: Number(process.env.REVIEW_TIMEOUT_MS || 20000),
  REVIEW_MAX_RETRIES: Number(process.env.REVIEW_MAX_RETRIES || 2),
  DISCORD_TIMEOUT_MS: Number(process.env.DISCORD_TIMEOUT_MS || 15000),
  NEWS_ARTICLE_API_URL: process.env.NEWS_ARTICLE_API_URL || "",
  NEWS_PUBLISH_TOKEN: process.env.NEWS_PUBLISH_TOKEN || "",
  NEWS_PUBLISH_TIMEOUT_MS: Number(process.env.NEWS_PUBLISH_TIMEOUT_MS || 20000),
  DELAYED_MARKET_CAP_DUMP_WEBHOOK_URL:
    process.env.DELAYED_NEWS_DUMP_WEBHOOK_URL || process.env.DELAYED_MARKET_CAP_DUMP_WEBHOOK_URL || "",
  DELAYED_MARKET_CAP_DUMP_DELAY_MS: Number(
    process.env.DELAYED_NEWS_DUMP_DELAY_MS || process.env.DELAYED_MARKET_CAP_DUMP_DELAY_MS || 90000
  ),
  BUFFER_AUTOPOST_ENABLED: /^true$/i.test(process.env.BUFFER_AUTOPOST_ENABLED || "false"),
  BUFFER_API_KEY: process.env.BUFFER_API_KEY || "",
  BUFFER_X_CHANNEL_ID: process.env.BUFFER_X_CHANNEL_ID || "",
  BUFFER_SHARE_MODE: process.env.BUFFER_SHARE_MODE || "shareNow",
  BUFFER_POST_FOOTER:
    process.env.BUFFER_POST_FOOTER ||
    "Delayed here. Full AI summary + instant support/resistance in Discord.",
  BUFFER_TIMEOUT_MS: Number(process.env.BUFFER_TIMEOUT_MS || 20000),
  MAX_SEEN_SNOWFLAKES: Number(process.env.MAX_SEEN_SNOWFLAKES || 5000),
  HOST_STARTUP_BACKFILL_HOURS: Number(process.env.HOST_STARTUP_BACKFILL_HOURS || 2),
  HOST_STARTUP_BACKFILL_MAX_MESSAGES: Number(process.env.HOST_STARTUP_BACKFILL_MAX_MESSAGES || 100),
  LIVE_BOT_IDLE_RESTART_MS: Number(process.env.LIVE_BOT_IDLE_RESTART_MS || 90 * 60 * 1000),
  REPLAY_FILE: process.env.REPLAY_FILE
    ? path.resolve(process.cwd(), process.env.REPLAY_FILE)
    : null,
  REPLAY_SKIP_WEBHOOKS: /^true$/i.test(process.env.REPLAY_SKIP_WEBHOOKS || "false"),
  REPLAY_OUTPUT_FILE: process.env.REPLAY_OUTPUT_FILE
    ? path.resolve(process.cwd(), process.env.REPLAY_OUTPUT_FILE)
    : null,
  REVIEW_ENABLED: /^true$/i.test(process.env.REVIEW_ENABLED || "false"),
  REVIEW_QUEUE_APPEND_ENABLED: !/^false$/i.test(process.env.REVIEW_QUEUE_APPEND_ENABLED || "true"),
  REVIEW_OUTPUT_FILE: process.env.REVIEW_OUTPUT_FILE
    ? path.resolve(process.cwd(), process.env.REVIEW_OUTPUT_FILE)
    : null,
  SEC_TEXT_MODE: normalizeSecTextMode(process.env.SEC_TEXT_MODE),
  TICKER_DISPLAY_VARIANT: normalizeTickerDisplayVariant(process.env.TICKER_DISPLAY_VARIANT),
  resolvedEnvFile
};
