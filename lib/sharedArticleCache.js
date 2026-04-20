const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function normalizeCacheUrl(url) {
  return String(url || "").trim();
}

function cleanCachedText(text) {
  return String(text || "").trim();
}

function getArticleCachePath(url, cacheDir) {
  const digest = crypto.createHash("sha1").update(normalizeCacheUrl(url)).digest("hex");
  return path.join(String(cacheDir || ""), `${digest}.txt`);
}

function readCachedArticleText(url, cacheDir) {
  const cachePath = getArticleCachePath(url, cacheDir);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  const cached = fs.readFileSync(cachePath, "utf8");
  return cleanCachedText(cached) ? cached : null;
}

function writeCachedArticleText(url, text, cacheDir) {
  const normalizedText = cleanCachedText(text);
  if (!normalizedText) {
    return null;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = getArticleCachePath(url, cacheDir);
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, text, "utf8");
  fs.renameSync(tempPath, cachePath);
  return cachePath;
}

async function waitForCachedArticleText(url, cacheDir, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
  const pollMs = Math.max(50, Number(options.pollMs || 250));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const cached = readCachedArticleText(url, cacheDir);
    if (cached) {
      return cached;
    }

    if (Date.now() >= deadline) {
      break;
    }

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  return null;
}

module.exports = {
  getArticleCachePath,
  readCachedArticleText,
  waitForCachedArticleText,
  writeCachedArticleText
};
