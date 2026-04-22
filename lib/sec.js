const crypto = require("crypto");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const path = require("path");
const {
  readCachedArticleText: readSharedCachedArticleText,
  writeCachedArticleText: writeSharedCachedArticleText,
  waitForCachedArticleText
} = require("./sharedArticleCache");

const {
  ARTICLE_CACHE_DIR,
  ARTICLE_FETCH_LOG_FILE,
  ARTICLE_SHARED_CACHE_POLL_MS,
  ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS,
  ARTICLE_SHARED_CACHE_WAIT_MS,
  HTTP_TIMEOUT_MS,
  NUNTIO_COOLDOWN_MS,
  NUNTIO_MAX_RETRIES,
  NUNTIO_MIN_INTERVAL_MS,
  SEC_TEXT_MODE,
  SEC_USER_AGENT
} = require("./config");
const { fetchTextWithTimeout } = require("./http");
const { cleanText, sleep, stripHtmlToText } = require("./utils");

function normalizeFetchedArticleText(text, sourceUrl) {
  const normalized = stripHtmlToText(text).slice(0, 160000);
  if (!normalized) {
    throw new Error(`No readable article text found for ${sourceUrl}`);
  }

  return normalized;
}

const articleRequestStateByHost = new Map();
const articleSelectionMetaByUrl = new Map();
const articleFetchTelemetry = {
  totalRequests: 0,
  totalCacheHits: 0,
  totalCacheMisses: 0,
  totalNuntioRequests: 0,
  totalNuntioCacheHits: 0,
  totalNuntioCacheMisses: 0,
  totalNuntioCooldowns: 0,
  uniqueNuntioUrls: new Set(),
  nuntioEvents: [],
  byDomain: {}
};

function ensureDomainTelemetry(hostname) {
  const key = hostname || "unknown";
  if (!articleFetchTelemetry.byDomain[key]) {
    articleFetchTelemetry.byDomain[key] = {
      requests: 0,
      successes: 0,
      failures: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statusCodes: {},
      lastError: null,
      lastEventAt: null
    };
  }

  return articleFetchTelemetry.byDomain[key];
}

function appendArticleFetchLog(event) {
  try {
    fs.mkdirSync(path.dirname(ARTICLE_FETCH_LOG_FILE), { recursive: true });
    fs.appendFileSync(
      ARTICLE_FETCH_LOG_FILE,
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      "utf8"
    );
  } catch (err) {
    console.warn(`[WARN] Failed to write article fetch log: ${err.message}`);
  }
}

function recordArticleFetchEvent(url, event) {
  const hostname = getHostname(url) || "unknown";
  const domain = ensureDomainTelemetry(hostname);

  if (event.kind === "request") {
    domain.requests += 1;
  }
  if (event.kind === "cache_hit") {
    domain.cacheHits += 1;
  }
  if (event.kind === "cache_miss") {
    domain.cacheMisses += 1;
  }
  if (event.kind === "success") {
    domain.successes += 1;
  }
  if (event.kind === "failure" || event.kind === "cooldown_terminal") {
    domain.failures += 1;
    domain.lastError = cleanText(event.error || `status ${event.status || "unknown"}`);
  }
  if (Number.isFinite(event.status)) {
    const statusKey = String(event.status);
    domain.statusCodes[statusKey] = Number(domain.statusCodes[statusKey] || 0) + 1;
  }

  domain.lastEventAt = new Date().toISOString();
  appendArticleFetchLog({
    scope: "article_fetch",
    hostname,
    url: String(url || ""),
    ...event
  });
}

function resetArticleFetchTelemetry() {
  articleFetchTelemetry.totalRequests = 0;
  articleFetchTelemetry.totalCacheHits = 0;
  articleFetchTelemetry.totalCacheMisses = 0;
  articleFetchTelemetry.totalNuntioRequests = 0;
  articleFetchTelemetry.totalNuntioCacheHits = 0;
  articleFetchTelemetry.totalNuntioCacheMisses = 0;
  articleFetchTelemetry.totalNuntioCooldowns = 0;
  articleFetchTelemetry.uniqueNuntioUrls = new Set();
  articleFetchTelemetry.nuntioEvents = [];
  articleFetchTelemetry.byDomain = {};
}

function recordNuntioEvent(url, kind, extra = {}) {
  const normalizedUrl = String(url || "");
  articleFetchTelemetry.nuntioEvents.push({
    at: new Date().toISOString(),
    kind,
    url: normalizedUrl,
    ...extra
  });
  articleFetchTelemetry.uniqueNuntioUrls.add(normalizedUrl);
}

function getArticleFetchTelemetry() {
  return {
    totalRequests: articleFetchTelemetry.totalRequests,
    totalCacheHits: articleFetchTelemetry.totalCacheHits,
    totalCacheMisses: articleFetchTelemetry.totalCacheMisses,
    totalNuntioRequests: articleFetchTelemetry.totalNuntioRequests,
    totalNuntioCacheHits: articleFetchTelemetry.totalNuntioCacheHits,
    totalNuntioCacheMisses: articleFetchTelemetry.totalNuntioCacheMisses,
    totalNuntioCooldowns: articleFetchTelemetry.totalNuntioCooldowns,
    uniqueNuntioUrlCount: articleFetchTelemetry.uniqueNuntioUrls.size,
    nuntioEvents: articleFetchTelemetry.nuntioEvents.slice(),
    byDomain: JSON.parse(JSON.stringify(articleFetchTelemetry.byDomain))
  };
}

function getHostname(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function isNuntioArticleUrl(url) {
  return getHostname(url) === "news.nuntiobot.com";
}

function getArticleCachePath(url) {
  const digest = crypto.createHash("sha1").update(String(url || "")).digest("hex");
  return path.join(ARTICLE_CACHE_DIR, `${digest}.txt`);
}

function getSelectionMetaKey(url) {
  return normalizeSecDocumentUrl(url);
}

function setArticleSelectionMeta(url, patch) {
  const key = getSelectionMetaKey(url);
  const current = articleSelectionMetaByUrl.get(key) || {
    requestedUrl: key
  };

  articleSelectionMetaByUrl.set(key, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function clearArticleSelectionMeta(url) {
  articleSelectionMetaByUrl.delete(getSelectionMetaKey(url));
}

function getArticleSelectionMeta(url) {
  const meta = articleSelectionMetaByUrl.get(getSelectionMetaKey(url));
  return meta ? JSON.parse(JSON.stringify(meta)) : null;
}

function readCachedArticleText(url) {
  return readSharedCachedArticleText(url, ARTICLE_CACHE_DIR);
}

function writeCachedArticleText(url, text) {
  return writeSharedCachedArticleText(url, text, ARTICLE_CACHE_DIR);
}

function usesReadOnlySharedCache(url) {
  const hostname = getHostname(url);
  return ARTICLE_SHARED_CACHE_READ_ONLY_HOSTS.includes(hostname);
}

async function waitForPoliteArticleRequest(url) {
  const hostname = getHostname(url);
  if (!hostname) return;

  const minIntervalMs = isNuntioArticleUrl(url) ? NUNTIO_MIN_INTERVAL_MS : 0;
  if (minIntervalMs <= 0) return;

  const state = articleRequestStateByHost.get(hostname) || {};
  const now = Date.now();
  const waitUntil = Math.max(state.nextAllowedAt || 0, state.cooldownUntil || 0);
  const remainingMs = waitUntil - now;

  if (remainingMs > 0) {
    console.log(`[INFO] Waiting ${remainingMs}ms before fetching ${hostname}`);
    await sleep(remainingMs);
  }

  articleRequestStateByHost.set(hostname, {
    ...state,
    nextAllowedAt: Date.now() + minIntervalMs
  });
}

function recordNuntioCooldown(url, delayMs) {
  const hostname = getHostname(url);
  if (!hostname) return;

  const state = articleRequestStateByHost.get(hostname) || {};
  const cooldownUntil = Date.now() + Math.max(delayMs, NUNTIO_MIN_INTERVAL_MS);
  articleRequestStateByHost.set(hostname, {
    ...state,
    cooldownUntil,
    nextAllowedAt: cooldownUntil
  });
}

function isNuntioCooldownResponse(url, response, body) {
  if (!isNuntioArticleUrl(url) || Number(response?.status) !== 403) {
    return false;
  }

  return /access denied:\s*cool-off due to excessive requests/i.test(String(body || ""));
}

const SEC_SELECTION_PROFILES = {
  prospectus_supplement_atm: {
    coverChars: 3600,
    beforeChars: 500,
    afterChars: 1800,
    minSelectedChars: 2800,
    maxSelectedChars: 18000,
    keywords: [
      "at the market",
      "at-the-market",
      "sales agreement",
      "sales agent",
      "from time to time",
      "aggregate offering price",
      "aggregate gross sales price",
      "general instruction i.b.6",
      "commission rate",
      "commercially reasonable efforts",
      "not required to sell any specific",
      "through or to",
      "common stock",
      "common shares",
      "class a common"
    ]
  },
  current_report_dilution: {
    coverChars: 5500,
    beforeChars: 700,
    afterChars: 2800,
    minSelectedChars: 3200,
    maxSelectedChars: 34000,
    keywords: [
      "entry into a material definitive agreement",
      "unregistered sales of equity securities",
      "underwriting agreement",
      "securities purchase agreement",
      "purchase agreement",
      "subscription agreement",
      "registration rights agreement",
      "private placement",
      "pipe",
      "convertible note",
      "convertible promissory note",
      "warrant",
      "pre-funded warrant",
      "closing",
      "gross proceeds",
      "net proceeds",
      "shares of common stock",
      "common stock",
      "offering"
    ]
  },
  prospectus_supplement: {
    coverChars: 4200,
    beforeChars: 600,
    afterChars: 2200,
    minSelectedChars: 3500,
    maxSelectedChars: 26000,
    keywords: [
      "prospectus supplement",
      "summary",
      "the offering",
      "use of proceeds",
      "dilution",
      "underwriting",
      "plan of distribution",
      "selling stockholder",
      "selling stockholders",
      "placement agent",
      "over-allotment",
      "overallotment",
      "warrant",
      "convertible note"
    ]
  },
  shelf_registration: {
    coverChars: 5000,
    beforeChars: 700,
    afterChars: 2600,
    minSelectedChars: 3500,
    maxSelectedChars: 36000,
    keywords: [
      "prospectus summary",
      "recent financings",
      "registration rights",
      "registrable securities",
      "selling stockholder",
      "selling stockholders",
      "plan of distribution",
      "private placement",
      "convertible promissory note",
      "convertible note",
      "placement agent",
      "warrant",
      "use of proceeds",
      "securities we may offer"
    ]
  },
  registration_statement: {
    coverChars: 4200,
    beforeChars: 600,
    afterChars: 2200,
    minSelectedChars: 4000,
    maxSelectedChars: 28000,
    keywords: [
      "prospectus summary",
      "the offering",
      "use of proceeds",
      "dilution",
      "capitalization",
      "selling stockholder",
      "selling stockholders",
      "underwriting",
      "plan of distribution",
      "description of securities",
      "recent sales of unregistered securities",
      "private placement",
      "warrant"
    ]
  },
  exhibits_only_amendment: {
    coverChars: 4500,
    beforeChars: 500,
    afterChars: 2200,
    minSelectedChars: 2200,
    maxSelectedChars: 24000,
    keywords: [
      "explanatory note",
      "effective date",
      "delay effectiveness",
      "recent sales of unregistered securities",
      "item 7",
      "item 6",
      "exhibit index",
      "form of purchase agreement",
      "form of common warrant",
      "signatures"
    ]
  }
};

function hasDilutionStyleCurrentReportMarkers(text) {
  const upperText = String(text || "").toUpperCase();
  const keywordHits = [
    /ENTRY INTO A MATERIAL DEFINITIVE AGREEMENT/,
    /UNREGISTERED SALES OF EQUITY SECURITIES/,
    /UNDERWRITING AGREEMENT/,
    /SECURITIES PURCHASE AGREEMENT/,
    /REGISTRATION RIGHTS AGREEMENT/,
    /PRIVATE PLACEMENT/,
    /\bPIPE\b/,
    /CONVERTIBLE PROMISSORY NOTE/,
    /CONVERTIBLE NOTE/,
    /PRE-FUNDED WARRANT/,
    /WARRANT/,
    /GROSS PROCEEDS/,
    /NET PROCEEDS/,
    /SHARES OF COMMON STOCK/
  ].filter(pattern => pattern.test(upperText)).length;

  return keywordHits >= 2;
}

function detectSecSelectionProfile(expectedFilingType, normalizedText) {
  const filingType = normalizeSecFilingType(expectedFilingType);
  const upperText = String(normalizedText || "").toUpperCase();
  const looksLikeExhibitsOnlyAmendment =
    /EXPLANATORY NOTE/.test(upperText) &&
    /EXHIBIT INDEX/.test(upperText) &&
    /AMENDMENT NO\./.test(upperText);

  if (looksLikeExhibitsOnlyAmendment) {
    return "exhibits_only_amendment";
  }

  if (/^(?:8-K|6-K)$/i.test(filingType) && hasDilutionStyleCurrentReportMarkers(normalizedText)) {
    return "current_report_dilution";
  }

  if (
    /^(?:424B1|424B2|424B3|424B4|424B5|424B7)$/i.test(filingType) &&
    /(?:AT[\s-]+THE[\s-]+MARKET|SALES AGREEMENT|SALES AGENT|FROM TIME TO TIME)/i.test(upperText)
  ) {
    return "prospectus_supplement_atm";
  }

  if (/^(?:424B1|424B2|424B3|424B4|424B5|424B7)$/i.test(filingType)) {
    return "prospectus_supplement";
  }

  if (/^(?:S-3|S-3\/A|S-3A|S-3ASR|F-3|F-3\/A)$/i.test(filingType)) {
    return "shelf_registration";
  }

  if (/^(?:S-1|S-1\/A|S-1A|S-1MEF|F-1|F-1\/A)$/i.test(filingType)) {
    return "registration_statement";
  }

  return null;
}

function expandWindowToBoundary(text, start, end) {
  let left = Math.max(0, start);
  let right = Math.min(text.length, end);

  while (left > 0 && !/[.\n]/.test(text[left - 1])) {
    left--;
  }

  while (right < text.length && !/[.\n]/.test(text[right])) {
    right++;
  }

  if (right < text.length) {
    right++;
  }

  return { start: left, end: right };
}

function mergeTextWindows(windows) {
  if (!windows.length) return [];

  const sorted = windows
    .slice()
    .sort((left, right) => left.start - right.start);
  const merged = [sorted[0]];

  for (const current of sorted.slice(1)) {
    const previous = merged[merged.length - 1];
    if (current.start <= previous.end + 200) {
      previous.end = Math.max(previous.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

function buildKeywordWindows(text, keywords, beforeChars, afterChars) {
  const lowerText = String(text || "").toLowerCase();
  const windows = [];

  for (const keyword of keywords) {
    const needle = String(keyword || "").toLowerCase();
    if (!needle) continue;

    let startIndex = 0;
    let matchCount = 0;

    while (matchCount < 2) {
      const index = lowerText.indexOf(needle, startIndex);
      if (index === -1) break;

      windows.push(
        expandWindowToBoundary(
          text,
          Math.max(0, index - beforeChars),
          Math.min(text.length, index + needle.length + afterChars)
        )
      );

      startIndex = index + needle.length;
      matchCount++;
    }
  }

  return windows;
}

function selectRelevantSecText(normalizedText, expectedFilingType, sourceUrl) {
  if (SEC_TEXT_MODE !== "targeted") {
    return normalizedText;
  }

  const profileName = detectSecSelectionProfile(expectedFilingType, normalizedText);
  if (!profileName) {
    return normalizedText;
  }

  const profile = SEC_SELECTION_PROFILES[profileName];
  const windows = [
    { start: 0, end: Math.min(normalizedText.length, profile.coverChars) },
    ...buildKeywordWindows(
      normalizedText,
      profile.keywords,
      profile.beforeChars,
      profile.afterChars
    )
  ];

  const mergedWindows = mergeTextWindows(windows);
  const selected = mergedWindows
    .map(window => cleanText(normalizedText.slice(window.start, window.end)))
    .filter(Boolean)
    .join("\n\n")
    .slice(0, profile.maxSelectedChars);

  if (!selected || selected.length < profile.minSelectedChars) {
    return normalizedText;
  }

  if (selected.length >= normalizedText.length) {
    return normalizedText;
  }

  console.log(
    `[INFO] SEC filing text reduced for ${expectedFilingType || "unknown filing"} at ${sourceUrl}: ${normalizedText.length} -> ${selected.length} chars`
  );

  return selected;
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

function normalizeSecDocumentUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!parsed.hostname.endsWith("sec.gov")) {
      return parsed.toString();
    }

    if (parsed.pathname === "/ix") {
      const docPath = parsed.searchParams.get("doc");
      if (docPath) {
        return new URL(docPath, "https://www.sec.gov").toString();
      }
    }

    return parsed.toString();
  } catch (_) {
    return String(url || "");
  }
}

function buildAbsoluteSecUrl(baseUrl, href) {
  return normalizeSecDocumentUrl(new URL(String(href || ""), baseUrl).toString());
}

function isSecIndexUrl(url) {
  const normalized = normalizeSecDocumentUrl(url);
  return normalized.includes("sec.gov") && normalized.includes("-index.htm");
}

function normalizeSecFilingType(value) {
  return cleanText(value)
    .toUpperCase()
    .replace(/^FORM\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSecFilingTypeAliases(value) {
  const normalized = normalizeSecFilingType(value);
  if (!normalized) return [];

  const aliases = new Set([normalized, normalized.replace(/\s+/g, "")]);

  const scheduleMatch = normalized.match(/^SCHEDULE\s+(.+)$/);
  if (scheduleMatch) {
    const suffix = scheduleMatch[1].trim();
    aliases.add(suffix);
    aliases.add(`SC ${suffix}`);
    aliases.add(`SC${suffix.replace(/\s+/g, "")}`);
  }

  const scMatch = normalized.match(/^SC\s*(.+)$/);
  if (scMatch) {
    const suffix = scMatch[1].trim();
    aliases.add(suffix);
    aliases.add(`SCHEDULE ${suffix}`);
  }

  return Array.from(aliases).map(alias => alias.toUpperCase());
}

function secTextMatchesExpectedType(text, expectedFilingType) {
  const normalizedText = normalizeSecFilingType(text);
  if (!normalizedText || !expectedFilingType) return false;

  const aliases = buildSecFilingTypeAliases(expectedFilingType);
  return aliases.some(alias => {
    const compactAlias = alias.replace(/\s+/g, "");
    return (
      normalizedText === alias ||
      normalizedText.includes(alias) ||
      normalizedText.replace(/\s+/g, "").includes(compactAlias)
    );
  });
}

function isUnderlyingRegistrationDocument(text) {
  const normalized = normalizeSecFilingType(text);
  if (!normalized) return false;

  return /^(?:S-1|S-1\/A|S-1A|S-1MEF|S-3|S-3\/A|S-3A|S-3ASR|F-1|F-1\/A|F-3|F-3\/A|424B1|424B2|424B3|424B4|424B5|424B7|POS AM|POSASR)$/.test(
    normalized
  );
}

function shouldPreferUnderlyingRegistration(expectedFilingType) {
  return /^EFFECT$/i.test(normalizeSecFilingType(expectedFilingType));
}

function getSecRowSequenceValue(documentRow) {
  const seq = parseInt(String(documentRow.seq || "").trim(), 10);
  return Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER;
}

function isHtmlLikeSecDocument(documentRow) {
  const href = String(documentRow.href || "").toLowerCase();
  return href.endsWith(".htm") || href.endsWith(".html");
}

function summarizeSecDocumentRow(documentRow) {
  if (!documentRow) return null;

  return {
    href: cleanText(documentRow.href || "") || null,
    seq: cleanText(documentRow.seq || "") || null,
    type: cleanText(documentRow.type || "") || null,
    description: cleanText(documentRow.description || "") || null,
    documentName: cleanText(documentRow.documentName || "") || null
  };
}

function extractSecIndexDocuments(indexHtml, indexUrl) {
  const dom = new JSDOM(indexHtml);
  const document = dom.window.document;
  const rows = [...document.querySelectorAll("table tr")];

  return rows.map(row => {
    const cells = [...row.querySelectorAll("th, td")].map(cell =>
      cleanText(cell.textContent)
    );
    const anchor = row.querySelector("a[href]");
    const href = anchor ? buildAbsoluteSecUrl(indexUrl, anchor.getAttribute("href")) : null;

    return {
      href,
      cells,
      seq: cells[0] || "",
      description: cells[1] || "",
      documentName: cells[2] || "",
      type: cells[3] || "",
      size: cells[4] || ""
    };
  }).filter(row => row.href);
}

function isLikelyPrimarySecDocument(documentRow) {
  const type = String(documentRow.type || "").toUpperCase();
  const description = String(documentRow.description || "").toUpperCase();
  const href = String(documentRow.href || "").toLowerCase();

  if (!href || href.endsWith(".jpg") || href.endsWith(".jpeg") || href.endsWith(".png") || href.endsWith(".gif")) {
    return false;
  }

  if (description.includes("COMPLETE SUBMISSION TEXT FILE")) {
    return false;
  }

  if (
    type.startsWith("EX-101") ||
    type === "XML" ||
    type === "GRAPHIC" ||
    type === "ZIP" ||
    type === "JSON" ||
    type === "PDF"
  ) {
    return false;
  }

  return Boolean(type || description);
}

function isLikelyPressReleaseExhibit(documentRow) {
  if (!isLikelyCurrentReportExhibit(documentRow)) {
    return false;
  }

  const combined = [
    documentRow.description,
    documentRow.documentName,
    documentRow.type
  ]
    .map(value => cleanText(value))
    .join(" ");

  return /(press release|news release|press[- ]?release|furnished herewith|attached hereto)/i.test(combined);
}

function isCurrentReportWrapperRow(documentRow) {
  const combined = [
    documentRow.type,
    documentRow.description,
    documentRow.documentName
  ]
    .map(value => cleanText(value))
    .join(" ");

  return /(?:^|\s)(?:8-K|6-K)(?:\s|$)/i.test(combined);
}

function shouldPreferCurrentReportExhibitFromIndex(documentRows, expectedFilingType = null) {
  const filingType = normalizeSecFilingType(expectedFilingType);
  const hasCurrentReportWrapper = /^(?:8-K|6-K)$/i.test(filingType) || documentRows.some(isCurrentReportWrapperRow);

  return hasCurrentReportWrapper && documentRows.some(isLikelyPressReleaseExhibit);
}

function selectSecPrimaryDocument(documentRows, expectedFilingType = null) {
  const completeSubmissionText = documentRows.find(row =>
    String(row.description || "").toLowerCase().includes("complete submission text file") ||
    String(row.href || "").toLowerCase().endsWith(".txt")
  );
  const preferUnderlyingRegistration = shouldPreferUnderlyingRegistration(expectedFilingType);
  const preferCurrentReportExhibit = shouldPreferCurrentReportExhibitFromIndex(
    documentRows,
    expectedFilingType
  );

  const primaryCandidates = documentRows
    .filter(isLikelyPrimarySecDocument)
    .sort((left, right) => {
      if (preferUnderlyingRegistration) {
        const leftUnderlying =
          isUnderlyingRegistrationDocument(left.type) ||
          isUnderlyingRegistrationDocument(left.description) ||
          isUnderlyingRegistrationDocument(left.documentName);
        const rightUnderlying =
          isUnderlyingRegistrationDocument(right.type) ||
          isUnderlyingRegistrationDocument(right.description) ||
          isUnderlyingRegistrationDocument(right.documentName);

        if (leftUnderlying !== rightUnderlying) {
          return leftUnderlying ? -1 : 1;
        }
      }

      if (preferCurrentReportExhibit) {
        const leftPressReleaseExhibit = isLikelyPressReleaseExhibit(left);
        const rightPressReleaseExhibit = isLikelyPressReleaseExhibit(right);

        if (leftPressReleaseExhibit !== rightPressReleaseExhibit) {
          return leftPressReleaseExhibit ? -1 : 1;
        }
      }

      const leftExpectedMatch =
        secTextMatchesExpectedType(left.type, expectedFilingType) ||
        secTextMatchesExpectedType(left.description, expectedFilingType);
      const rightExpectedMatch =
        secTextMatchesExpectedType(right.type, expectedFilingType) ||
        secTextMatchesExpectedType(right.description, expectedFilingType);

      if (leftExpectedMatch !== rightExpectedMatch) {
        return leftExpectedMatch ? -1 : 1;
      }

      const leftHtmlLike = isHtmlLikeSecDocument(left);
      const rightHtmlLike = isHtmlLikeSecDocument(right);
      if (leftHtmlLike !== rightHtmlLike) {
        return leftHtmlLike ? -1 : 1;
      }

      return getSecRowSequenceValue(left) - getSecRowSequenceValue(right);
    });

  const primaryDocument = primaryCandidates[0] || null;

  return {
    primaryDocument,
    primaryCandidates,
    completeSubmissionText
  };
}

function extractEffectFileNumber(text) {
  const normalized = cleanText(text || "");
  if (!normalized) return null;

  const explicitMatch = normalized.match(/file number[:\s]+(333-\d{3,})/i);
  if (explicitMatch) {
    return explicitMatch[1];
  }

  const genericMatch = normalized.match(/\b(333-\d{3,})\b/);
  return genericMatch ? genericMatch[1] : null;
}

function extractBrowseEdgarRows(resultsHtml) {
  const dom = new JSDOM(resultsHtml);
  const document = dom.window.document;
  const rows = [...document.querySelectorAll("table.tableFile2 tr")].slice(1);

  return rows
    .map(row => {
      const cells = [...row.querySelectorAll("td")].map(cell => cleanText(cell.textContent));
      const anchor = row.querySelector('a[href*="-index.htm"]');
      const href = anchor ? buildAbsoluteSecUrl("https://www.sec.gov", anchor.getAttribute("href")) : null;

      return {
        href,
        type: cells[0] || "",
        description: cells[2] || "",
        filedAt: cells[3] || "",
        fileNumber: cells[4] || ""
      };
    })
    .filter(row => row.href);
}

function selectUnderlyingRegistrationBrowseRow(rows) {
  const candidates = rows.filter(row =>
    isUnderlyingRegistrationDocument(row.type) ||
    isUnderlyingRegistrationDocument(row.description)
  );

  return candidates[0] || null;
}

async function fetchUnderlyingRegistrationFromEffect(indexHtml, effectText, requestOptions, indexUrl) {
  const fileNumber = extractEffectFileNumber(effectText) || extractEffectFileNumber(indexHtml);
  if (!fileNumber) {
    return null;
  }

  const browseUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=${encodeURIComponent(
    fileNumber
  )}&owner=exclude&count=40`;

  const { response, body } = await fetchTextWithTimeout(browseUrl, requestOptions, HTTP_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Failed to fetch SEC file-number results ${browseUrl}: ${response.status}`);
  }

  const filingRows = extractBrowseEdgarRows(body);
  const underlyingRow = selectUnderlyingRegistrationBrowseRow(filingRows);
  if (!underlyingRow) {
    return null;
  }

  const normalizedUnderlyingUrl = normalizeSecDocumentUrl(underlyingRow.href);
  if (normalizedUnderlyingUrl === normalizeSecDocumentUrl(indexUrl)) {
    return null;
  }

  console.log(
    `[INFO] EFFECT filing fallback selected underlying registration document: ${underlyingRow.type} -> ${normalizedUnderlyingUrl}`
  );

  return {
    text: await fetchSecArticleText(
      normalizedUnderlyingUrl,
      requestOptions,
      underlyingRow.type || underlyingRow.description || null
    ),
    selectedDocumentUrl: normalizedUnderlyingUrl,
    selectedDocumentType: cleanText(underlyingRow.type || underlyingRow.description || "") || null
  };
}

function shouldPreferCurrentReportExhibit(expectedFilingType, currentReportText) {
  const filingType = normalizeSecFilingType(expectedFilingType);
  const normalized = cleanText(currentReportText || "");
  const inferredCurrentReport =
    /^(?:8-K|6-K)$/i.test(filingType) ||
    /\bform\s+(?:8-k|6-k)\b/i.test(normalized) ||
    /report of foreign private issuer/i.test(normalized) ||
    /\bcurrent report\b/i.test(normalized);

  if (!inferredCurrentReport) {
    return false;
  }

  if (!normalized) {
    return false;
  }

  return (
    /(item\s+7\.01|regulation fd disclosure|item\s+8\.01)/i.test(normalized) &&
    /(press release|furnished herewith|attached as exhibit|filed as exhibit)/i.test(normalized) &&
    /(?:exhibit|ex-)\s*99\.1/i.test(normalized) &&
    !hasDilutionStyleCurrentReportMarkers(normalized)
  );
}

function isLikelyCurrentReportExhibit(documentRow) {
  const combined = [
    documentRow.type,
    documentRow.description,
    documentRow.documentName
  ]
    .map(value => normalizeSecFilingType(value))
    .join(" ");

  return /(?:^|\s)(?:EX-)?99\.1(?:\s|$)/i.test(combined);
}

function getCurrentReportExhibitNumber(documentRow) {
  const combined = [
    documentRow.type,
    documentRow.description,
    documentRow.documentName
  ]
    .map(value => cleanText(value))
    .join(" ");

  const match = combined.match(/(?:EX-?)?99\.(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function scoreCurrentReportExhibit(documentRow) {
  const combined = [
    documentRow.type,
    documentRow.description,
    documentRow.documentName
  ]
    .map(value => cleanText(value))
    .join(" ")
    .toLowerCase();

  let score = 0;

  if (/(press release|news release|shareholder letter|earnings release|results release)/i.test(combined)) {
    score += 120;
  }

  if (/(dated [a-z]+ \d{1,2}, \d{4}|issued on [a-z]+ \d{1,2}, \d{4}|announcing)/i.test(combined)) {
    score += 30;
  }

  if (/(financial statements|presentation|slides|investor presentation|letter agreement|resignation letter|termination letter|agreement|credit agreement|purchase agreement|employment agreement|consent|opinion|certificate|order)\b/i.test(combined)) {
    score -= 100;
  }

  const exhibitNumber = getCurrentReportExhibitNumber(documentRow);
  if (Number.isFinite(exhibitNumber)) {
    score += Math.max(0, 20 - exhibitNumber);
  }

  if (isHtmlLikeSecDocument(documentRow)) {
    score += 10;
  }

  return score;
}

function selectCurrentReportExhibit(documentRows) {
  const exhibits = documentRows
    .filter(row => {
      const combined = [
        row.type,
        row.description,
        row.documentName
      ]
        .map(value => cleanText(value))
        .join(" ");

      return /(?:^|\s)(?:EX-?)?99\.\d+(?:\s|$)/i.test(combined);
    })
    .sort((left, right) => {
      const scoreDiff = scoreCurrentReportExhibit(right) - scoreCurrentReportExhibit(left);
      if (scoreDiff !== 0) return scoreDiff;

      return getSecRowSequenceValue(left) - getSecRowSequenceValue(right);
    });

  return exhibits[0] || null;
}

function isSubstantiveSecText(text) {
  const normalized = cleanText(text);
  if (!normalized) return false;
  if (/^xbrl viewer$/i.test(normalized)) return false;
  if (normalized.length < 200) return false;
  return true;
}

async function fetchSecDocumentText(secUrl, requestOptions) {
  const normalizedUrl = normalizeSecDocumentUrl(secUrl);
  const { response, body } = await fetchTextWithTimeout(normalizedUrl, requestOptions, HTTP_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`Failed to fetch SEC document ${normalizedUrl}: ${response.status}`);
  }

  return {
    url: normalizedUrl,
    text: normalizeFetchedArticleText(body, normalizedUrl)
  };
}

function extractSecSubmissionDocuments(submissionText) {
  const sections = String(submissionText || "").split(/<DOCUMENT>/i).slice(1);

  return sections.map(section => {
    const type = cleanText(section.match(/<TYPE>([^\r\n<]+)/i)?.[1] || "");
    const filename = cleanText(section.match(/<FILENAME>([^\r\n<]+)/i)?.[1] || "");
    const description = cleanText(section.match(/<DESCRIPTION>([^\r\n<]+)/i)?.[1] || "");
    const textBlock = section.match(/<TEXT>([\s\S]*?)(?:<\/TEXT>|$)/i)?.[1] || section;

    return {
      type,
      filename,
      description,
      textBlock
    };
  }).filter(document => document.type || document.filename || document.description);
}

function selectSecSubmissionDocument(documents, expectedFilingType = null) {
  const rankedDocuments = documents.slice().sort((left, right) => {
    const leftExpectedMatch =
      secTextMatchesExpectedType(left.type, expectedFilingType) ||
      secTextMatchesExpectedType(left.description, expectedFilingType);
    const rightExpectedMatch =
      secTextMatchesExpectedType(right.type, expectedFilingType) ||
      secTextMatchesExpectedType(right.description, expectedFilingType);

    if (leftExpectedMatch !== rightExpectedMatch) {
      return leftExpectedMatch ? -1 : 1;
    }

    const leftIsExhibit = /^EX-/i.test(left.type);
    const rightIsExhibit = /^EX-/i.test(right.type);
    if (leftIsExhibit !== rightIsExhibit) {
      return leftIsExhibit ? 1 : -1;
    }

    return 0;
  });

  return rankedDocuments[0] || null;
}

async function fetchSecSubmissionText(submissionUrl, requestOptions, expectedFilingType = null) {
  const normalizedUrl = normalizeSecDocumentUrl(submissionUrl);
  const { response, body } = await fetchTextWithTimeout(normalizedUrl, requestOptions, HTTP_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`Failed to fetch SEC document ${normalizedUrl}: ${response.status}`);
  }

  const documents = extractSecSubmissionDocuments(body);
  if (documents.length) {
    const selectedDocument = selectSecSubmissionDocument(documents, expectedFilingType);
    if (selectedDocument) {
      const selectedText = normalizeFetchedArticleText(
        selectedDocument.textBlock,
        `${normalizedUrl}#${selectedDocument.type || selectedDocument.filename || "document"}`
      );

      if (isSubstantiveSecText(selectedText)) {
        return {
          url: normalizedUrl,
          text: selectRelevantSecText(selectedText, expectedFilingType, normalizedUrl)
        };
      }
    }
  }

  return {
    url: normalizedUrl,
    text: selectRelevantSecText(
      normalizeFetchedArticleText(body, normalizedUrl),
      expectedFilingType,
      normalizedUrl
    )
  };
}

async function fetchSecArticleText(indexUrl, requestOptions, expectedFilingType = null) {
  const normalizedIndexUrl = normalizeSecDocumentUrl(indexUrl);
  setArticleSelectionMeta(normalizedIndexUrl, {
    sourceType: "sec",
    expectedFilingType: normalizeSecFilingType(expectedFilingType) || cleanText(expectedFilingType || "") || null
  });
  const { response, body: indexHtml } = await fetchTextWithTimeout(
    normalizedIndexUrl,
    requestOptions,
    HTTP_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch URL ${normalizedIndexUrl}: ${response.status}`);
  }

  if (!isSecIndexUrl(normalizedIndexUrl)) {
    if (normalizedIndexUrl.toLowerCase().endsWith(".txt")) {
      const directSubmission = await fetchSecSubmissionText(
        normalizedIndexUrl,
        requestOptions,
        expectedFilingType
      );
      setArticleSelectionMeta(normalizedIndexUrl, {
        selectionKind: "direct_submission_text",
        selectedDocumentUrl: normalizedIndexUrl,
        selectedDocumentType: normalizeSecFilingType(expectedFilingType) || null
      });
      return directSubmission.text;
    }

    const directDocument = await fetchSecDocumentText(normalizedIndexUrl, requestOptions);
    setArticleSelectionMeta(normalizedIndexUrl, {
      selectionKind: "direct_document",
      selectedDocumentUrl: directDocument.url,
      selectedDocumentType: normalizeSecFilingType(expectedFilingType) || null
    });
    return directDocument.text;
  }

  const documentRows = extractSecIndexDocuments(indexHtml, normalizedIndexUrl);
  if (!documentRows.length) {
    throw new Error("SEC index document links not found");
  }

  const { primaryCandidates, completeSubmissionText } = selectSecPrimaryDocument(
    documentRows,
    expectedFilingType
  );
  const topPrimaryCandidates = primaryCandidates.slice(0, 5).map(summarizeSecDocumentRow);
  setArticleSelectionMeta(normalizedIndexUrl, {
    candidateDocuments: topPrimaryCandidates,
    currentReportExhibitAvailable: documentRows.some(isLikelyPressReleaseExhibit),
    currentReportWrapperPresent: documentRows.some(isCurrentReportWrapperRow),
    completeSubmissionTextUrl: cleanText(completeSubmissionText?.href || "") || null
  });
  const shouldChaseUnderlyingEffect =
    shouldPreferUnderlyingRegistration(expectedFilingType) &&
    !primaryCandidates.some(candidate =>
      isUnderlyingRegistrationDocument(candidate.type) ||
      isUnderlyingRegistrationDocument(candidate.description) ||
      isUnderlyingRegistrationDocument(candidate.documentName)
    );
  let prefetchedPrimaryTextByHref = null;

  if (shouldChaseUnderlyingEffect && primaryCandidates.length) {
    const effectCandidate = primaryCandidates[0];
    try {
      console.log(`[INFO] SEC EFFECT notice selected for file-number follow-through: ${effectCandidate.href}`);
      prefetchedPrimaryTextByHref = await fetchSecDocumentText(effectCandidate.href, requestOptions);
      const underlyingResult = await fetchUnderlyingRegistrationFromEffect(
        indexHtml,
        prefetchedPrimaryTextByHref.text,
        requestOptions,
        normalizedIndexUrl
      );

      if (underlyingResult?.text) {
        setArticleSelectionMeta(normalizedIndexUrl, {
          selectionKind: "effect_underlying_registration",
          selectedDocumentUrl: underlyingResult.selectedDocumentUrl || null,
          selectedDocumentType: underlyingResult.selectedDocumentType || null
        });
        return underlyingResult.text;
      }
    } catch (err) {
      console.warn(`[WARN] SEC EFFECT underlying-registration follow-through failed: ${err.message}`);
    }
  }

  for (const primaryDocument of primaryCandidates) {
    try {
      console.log(`[INFO] SEC index primary document selected: ${primaryDocument.href}`);
      const primaryText =
        prefetchedPrimaryTextByHref && prefetchedPrimaryTextByHref.url === normalizeSecDocumentUrl(primaryDocument.href)
          ? prefetchedPrimaryTextByHref
          : await fetchSecDocumentText(primaryDocument.href, requestOptions);

      if (shouldPreferCurrentReportExhibit(expectedFilingType, primaryText.text)) {
        const exhibitDocument = selectCurrentReportExhibit(documentRows);
        if (exhibitDocument?.href && exhibitDocument.href !== primaryDocument.href) {
          try {
            console.log(
              `[INFO] Current report wrapper selected exhibit follow-through: ${exhibitDocument.type || exhibitDocument.documentName} -> ${exhibitDocument.href}`
            );
            const exhibitText = await fetchSecDocumentText(exhibitDocument.href, requestOptions);
            if (isSubstantiveSecText(exhibitText.text)) {
              setArticleSelectionMeta(normalizedIndexUrl, {
                selectionKind: "current_report_exhibit",
                selectedDocumentUrl: exhibitDocument.href,
                selectedDocumentType: cleanText(exhibitDocument.type || exhibitDocument.documentName || "") || null,
                wrapperDocumentUrl: primaryDocument.href,
                wrapperDocumentType: cleanText(primaryDocument.type || primaryDocument.documentName || "") || null
              });
              return selectRelevantSecText(exhibitText.text, expectedFilingType, exhibitDocument.href);
            }
          } catch (err) {
            console.warn(`[WARN] Current report exhibit follow-through failed: ${err.message}`);
          }
        }
      }

      if (isSubstantiveSecText(primaryText.text)) {
        setArticleSelectionMeta(normalizedIndexUrl, {
          selectionKind: "index_primary",
          selectedDocumentUrl: primaryDocument.href,
          selectedDocumentType: cleanText(primaryDocument.type || primaryDocument.documentName || "") || null
        });
        return selectRelevantSecText(primaryText.text, expectedFilingType, primaryDocument.href);
      }
    } catch (err) {
      console.warn(`[WARN] SEC primary document fetch failed: ${err.message}`);
    }
  }

  if (completeSubmissionText?.href) {
    try {
      console.log(`[INFO] SEC index fallback submission text selected: ${completeSubmissionText.href}`);
      const fallbackText = await fetchSecSubmissionText(
        completeSubmissionText.href,
        requestOptions,
        expectedFilingType
      );
      if (isSubstantiveSecText(fallbackText.text)) {
        setArticleSelectionMeta(normalizedIndexUrl, {
          selectionKind: "complete_submission_text",
          selectedDocumentUrl: completeSubmissionText.href,
          selectedDocumentType: "COMPLETE SUBMISSION TEXT FILE"
        });
        return fallbackText.text;
      }
    } catch (err) {
      console.warn(`[WARN] SEC submission text fetch failed: ${err.message}`);
    }
  }

  throw new Error("Unable to extract substantive SEC filing text");
}

function buildArticleFetchFallback(data, err) {
  const routeTag = data.routeTag || "default";
  return [
    "ARTICLE BODY UNAVAILABLE.",
    "Use only the raw Discord metadata below.",
    "Do not infer unavailable filing specifics or article details.",
    `Fetch error: ${cleanText(err?.message || "Unknown fetch error")}`,
    `Route: ${routeTag}`,
    `Source URL: ${data.articleLink}`,
    `Raw Discord Message: ${data.rawText}`
  ].join("\n");
}

function extractSecFormTypeFromRawText(rawText) {
  const text = String(rawText || "");
  const patterns = [
    /\bSEC\b(?:\s+[A-Z]{1,5}(?:\.[A-Z]{1,2})?\s+-)?\s+Form\s+(.+?)(?:\s+-\s+Link|\s*$|,)/i,
    /\bSEC\b\s*-\s*Form\s+(.+?)(?:\s*-\s*Link|\s*$|,)/i,
    /\bForm\s+([A-Z0-9./ -]+?)(?:\s*-\s*Link|\s*$|,)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return cleanText(match[1]);
    }
  }

  return null;
}

function buildUnreadableSecFallbackAI(data, err) {
  const filingType = extractSecFormTypeFromRawText(data.rawText);
  const ticker = cleanText(data.ticker || "SEC");
  const headline = filingType
    ? `${ticker} SEC Form ${filingType}`
    : `${ticker} SEC Filing`;

  const summary = filingType
    ? `AI could not read the full SEC Form ${filingType} filing text for this post. Review the SEC filing directly using the link below.`
    : "AI could not read the full SEC filing text for this post. Review the SEC filing directly using the link below.";

  return {
    headline,
    summary,
    positives: [],
    negatives: [],
    tickers: ticker ? [ticker] : [],
    filingType,
    eventType: "sec_unreadable",
    confidence: 0,
    isFallback: true,
    fallbackReason: cleanText(err?.message || "SEC filing text unavailable")
  };
}

function isSecSource(articleLink) {
  return normalizeSecDocumentUrl(articleLink).includes("sec.gov");
}

async function fetchArticleText(url, rawDiscordMessage = "") {
  const requestOptions = {
    redirect: "follow",
    headers: { "User-Agent": SEC_USER_AGENT }
  };

  try {
    const normalizedUrl = normalizeSecDocumentUrl(url);
    const expectedFilingType = extractSecFormTypeFromRawText(rawDiscordMessage);
    const isNuntio = isNuntioArticleUrl(normalizedUrl);
    clearArticleSelectionMeta(normalizedUrl);
    setArticleSelectionMeta(normalizedUrl, {
      requestedUrl: normalizedUrl,
      expectedFilingType: normalizeSecFilingType(expectedFilingType) || cleanText(expectedFilingType || "") || null,
      sourceType: normalizedUrl.includes("sec.gov") ? "sec" : "article"
    });

    articleFetchTelemetry.totalRequests += 1;
    if (isNuntio) {
      articleFetchTelemetry.totalNuntioRequests += 1;
      articleFetchTelemetry.uniqueNuntioUrls.add(normalizedUrl);
    }

    if (normalizedUrl.includes("sec.gov")) {
      return await fetchSecArticleText(normalizedUrl, requestOptions, expectedFilingType);
    }

    recordArticleFetchEvent(normalizedUrl, { kind: "request" });
    const cachedText = readCachedArticleText(normalizedUrl);
    if (cachedText) {
      setArticleSelectionMeta(normalizedUrl, {
        selectionKind: "cache_hit",
        selectedDocumentUrl: normalizedUrl
      });
      articleFetchTelemetry.totalCacheHits += 1;
      recordArticleFetchEvent(normalizedUrl, { kind: "cache_hit" });
      if (isNuntio) {
        articleFetchTelemetry.totalNuntioCacheHits += 1;
        recordNuntioEvent(normalizedUrl, "cache_hit");
      }
      console.log(`[INFO] Using cached article text for ${normalizedUrl}`);
      return cachedText;
    }

    articleFetchTelemetry.totalCacheMisses += 1;
    recordArticleFetchEvent(normalizedUrl, { kind: "cache_miss" });
    if (isNuntio) {
      articleFetchTelemetry.totalNuntioCacheMisses += 1;
      recordNuntioEvent(normalizedUrl, "cache_miss");
    }

    if (usesReadOnlySharedCache(normalizedUrl)) {
      console.log(
        `[INFO] Waiting up to ${ARTICLE_SHARED_CACHE_WAIT_MS}ms for shared article cache: ${normalizedUrl}`
      );
      const waitedCacheText = await waitForCachedArticleText(normalizedUrl, ARTICLE_CACHE_DIR, {
        timeoutMs: ARTICLE_SHARED_CACHE_WAIT_MS,
        pollMs: ARTICLE_SHARED_CACHE_POLL_MS
      });

      if (waitedCacheText) {
        setArticleSelectionMeta(normalizedUrl, {
          selectionKind: "shared_cache_wait_hit",
          selectedDocumentUrl: normalizedUrl
        });
        articleFetchTelemetry.totalCacheHits += 1;
        recordArticleFetchEvent(normalizedUrl, {
          kind: "cache_hit",
          source: "shared_wait"
        });
        if (isNuntio) {
          articleFetchTelemetry.totalNuntioCacheHits += 1;
          recordNuntioEvent(normalizedUrl, "cache_wait_hit");
        }
        console.log(`[INFO] Using shared cached article text after wait for ${normalizedUrl}`);
        return waitedCacheText;
      }

      recordArticleFetchEvent(normalizedUrl, {
        kind: "failure",
        source: "shared_wait_timeout",
        error: `Shared article cache miss after waiting ${ARTICLE_SHARED_CACHE_WAIT_MS}ms`
      });
      if (isNuntio) {
        recordNuntioEvent(normalizedUrl, "shared_cache_timeout", {
          waitMs: ARTICLE_SHARED_CACHE_WAIT_MS
        });
      }
      throw new Error(
        `Shared article cache miss after waiting ${ARTICLE_SHARED_CACHE_WAIT_MS}ms for ${normalizedUrl}`
      );
    }

    const maxAttempts = isNuntio ? Math.max(1, NUNTIO_MAX_RETRIES) : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await waitForPoliteArticleRequest(normalizedUrl);

      const { response, body: html } = await fetchTextWithTimeout(
        normalizedUrl,
        requestOptions,
        HTTP_TIMEOUT_MS
      );

      if (response.ok) {
        const normalizedText = normalizeFetchedArticleText(html, normalizedUrl);
        writeCachedArticleText(normalizedUrl, normalizedText);
        setArticleSelectionMeta(normalizedUrl, {
          selectionKind: "direct_fetch",
          selectedDocumentUrl: normalizedUrl
        });
        recordArticleFetchEvent(normalizedUrl, {
          kind: "success",
          attempt,
          status: response.status
        });
        if (isNuntio) {
          recordNuntioEvent(normalizedUrl, "success", { attempt });
        }
        return normalizedText;
      }

      if (isNuntioCooldownResponse(normalizedUrl, response, html) && attempt < maxAttempts) {
        const backoffMs = NUNTIO_COOLDOWN_MS * attempt;
        articleFetchTelemetry.totalNuntioCooldowns += 1;
        recordArticleFetchEvent(normalizedUrl, {
          kind: "cooldown",
          attempt,
          backoffMs,
          status: response.status
        });
        recordNuntioEvent(normalizedUrl, "cooldown", { attempt, backoffMs, status: response.status });
        console.warn(
          `[WARN] Nuntio cooldown hit for ${normalizedUrl}; backing off ${backoffMs}ms before retry ${attempt + 1}/${maxAttempts}`
        );
        recordNuntioCooldown(normalizedUrl, backoffMs);
        await sleep(backoffMs);
        continue;
      }

      lastError = new Error(`Failed to fetch URL ${normalizedUrl}: ${response.status}`);
      if (isNuntioCooldownResponse(normalizedUrl, response, html)) {
        articleFetchTelemetry.totalNuntioCooldowns += 1;
        recordArticleFetchEvent(normalizedUrl, {
          kind: "cooldown_terminal",
          attempt,
          status: response.status,
          error: `Failed to fetch URL ${normalizedUrl}: ${response.status} (Nuntio cooldown)`
        });
        recordNuntioEvent(normalizedUrl, "cooldown_terminal", { attempt, status: response.status });
        lastError.message = `Failed to fetch URL ${normalizedUrl}: ${response.status} (Nuntio cooldown)`;
      } else if (isNuntio) {
        recordNuntioEvent(normalizedUrl, "error", { attempt, status: response.status });
      }
      if (!isNuntioCooldownResponse(normalizedUrl, response, html)) {
        recordArticleFetchEvent(normalizedUrl, {
          kind: "failure",
          attempt,
          status: response.status,
          error: `Failed to fetch URL ${normalizedUrl}: ${response.status}`
        });
      }
      break;
    }

    throw lastError || new Error(`Failed to fetch URL ${normalizedUrl}`);
  } catch (err) {
    console.error(`[ERROR] fetchArticleText failed for ${url}: ${err.message}`);
    throw err;
  }
}

module.exports = {
  getArticleFetchTelemetry,
  resetArticleFetchTelemetry,
  recordArticleFetchEvent,
  isLikelyArticleLink,
  normalizeSecDocumentUrl,
  normalizeSecFilingType,
  buildSecFilingTypeAliases,
  extractSecFormTypeFromRawText,
  buildUnreadableSecFallbackAI,
  buildArticleFetchFallback,
  isSecSource,
  fetchArticleText,
  getArticleSelectionMeta
};
