const { HTTP_TIMEOUT_MS } = require("./config");

const fetch = (...args) => import("node-fetch").then(({ default: fetchImpl }) => fetchImpl(...args));

async function fetchAndReadWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS, readResponse) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const body = await readResponse(response);
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  return fetchAndReadWithTimeout(url, options, timeoutMs, res => res.text());
}

module.exports = {
  fetchAndReadWithTimeout,
  fetchTextWithTimeout
};
