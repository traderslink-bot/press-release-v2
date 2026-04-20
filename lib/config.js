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
dotenv.config({ path: resolvedEnvFile });

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

const OPENAI_TEMPERATURE = (() => {
  const rawValue = process.env.PRESS_RELEASE_OPENAI_TEMPERATURE;
  return parseOptionalNumber(rawValue);
})();

module.exports = {
  DISCORD_EMAIL: process.env.DISCORD_EMAIL,
  DISCORD_PASSWORD: process.env.DISCORD_PASSWORD,
  HOST_CHANNEL_URL: process.env.HOST_CHANNEL_URL || process.env.HOST_CHANNEL_URL_1,
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL_1,
  SPIKE_WEBHOOK_URL: process.env.SPIKE_WEBHOOK_URL,
  DROP_WEBHOOK_URL: process.env.DROP_WEBHOOK_URL,
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
  PYTHON_EXECUTABLE: process.env.PYTHON_EXECUTABLE || "py",
  LEVELS_SCRIPT_PATH:
    process.env.LEVELS_SCRIPT_PATH ||
    "C:\\Users\\jerac\\Documents\\TraderLink\\playwright\\levels\\levels_clean_output.py",
  LEVELS_TIMEOUT_MS: Number(process.env.LEVELS_TIMEOUT_MS || 120000),
  HTTP_TIMEOUT_MS: Number(process.env.HTTP_TIMEOUT_MS || 20000),
  ARTICLE_CACHE_DIR:
    (process.env.ARTICLE_CACHE_DIR || process.env.SHARED_ARTICLE_CACHE_DIR) &&
    String(process.env.ARTICLE_CACHE_DIR || process.env.SHARED_ARTICLE_CACHE_DIR).trim()
      ? path.resolve(process.cwd(), process.env.ARTICLE_CACHE_DIR || process.env.SHARED_ARTICLE_CACHE_DIR)
      : path.join(PROJECT_ROOT, "cache", "article_fetch"),
  ARTICLE_SHARED_CACHE_WAIT_MS: Number(process.env.ARTICLE_SHARED_CACHE_WAIT_MS || 15000),
  ARTICLE_SHARED_CACHE_POLL_MS: Number(process.env.ARTICLE_SHARED_CACHE_POLL_MS || 1000),
  ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS: String(
    process.env.ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS || "news.nuntiobot.com"
  )
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean),
  ARTICLE_FETCH_LOG_FILE:
    process.env.ARTICLE_FETCH_LOG_FILE && String(process.env.ARTICLE_FETCH_LOG_FILE).trim()
      ? path.resolve(process.cwd(), process.env.ARTICLE_FETCH_LOG_FILE)
      : path.join(PROJECT_ROOT, "docs", "live_fetch_tracking", "live_events.jsonl"),
  NUNTIO_MIN_INTERVAL_MS: Number(process.env.NUNTIO_MIN_INTERVAL_MS || 15000),
  NUNTIO_COOLDOWN_MS: Number(process.env.NUNTIO_COOLDOWN_MS || 60000),
  NUNTIO_MAX_RETRIES: Number(process.env.NUNTIO_MAX_RETRIES || 3),
  OPENAI_TIMEOUT_MS: Number(process.env.OPENAI_TIMEOUT_MS || 45000),
  OPENAI_URL_FALLBACK_ENABLED: /^true$/i.test(process.env.OPENAI_URL_FALLBACK_ENABLED || "true"),
  OPENAI_URL_FALLBACK_TIMEOUT_MS: Number(
    process.env.OPENAI_URL_FALLBACK_TIMEOUT_MS || process.env.OPENAI_TIMEOUT_MS || 45000
  ),
  OPENAI_MAX_RETRIES: Number(process.env.OPENAI_MAX_RETRIES || 2),
  REVIEW_TIMEOUT_MS: Number(process.env.REVIEW_TIMEOUT_MS || 20000),
  REVIEW_MAX_RETRIES: Number(process.env.REVIEW_MAX_RETRIES || 2),
  DISCORD_TIMEOUT_MS: Number(process.env.DISCORD_TIMEOUT_MS || 15000),
  MAX_SEEN_SNOWFLAKES: Number(process.env.MAX_SEEN_SNOWFLAKES || 5000),
  REPLAY_FILE: process.env.REPLAY_FILE
    ? path.resolve(process.cwd(), process.env.REPLAY_FILE)
    : null,
  REPLAY_SKIP_WEBHOOKS: /^true$/i.test(process.env.REPLAY_SKIP_WEBHOOKS || "false"),
  REPLAY_OUTPUT_FILE: process.env.REPLAY_OUTPUT_FILE
    ? path.resolve(process.cwd(), process.env.REPLAY_OUTPUT_FILE)
    : null,
  REVIEW_ENABLED: /^true$/i.test(process.env.REVIEW_ENABLED || "false"),
  REVIEW_OUTPUT_FILE: process.env.REVIEW_OUTPUT_FILE
    ? path.resolve(process.cwd(), process.env.REVIEW_OUTPUT_FILE)
    : null,
  SEC_TEXT_MODE: normalizeSecTextMode(process.env.SEC_TEXT_MODE),
  TICKER_DISPLAY_VARIANT: normalizeTickerDisplayVariant(process.env.TICKER_DISPLAY_VARIANT),
  resolvedEnvFile
};
