const {
  BUFFER_API_KEY,
  BUFFER_X_CHANNEL_ID,
  BUFFER_SHARE_MODE,
  BUFFER_POST_FOOTER,
  BUFFER_TIMEOUT_MS
} = require("./config");
const { fetchTextWithTimeout } = require("./http");
const { cleanText } = require("./utils");

const BUFFER_API_URL = "https://api.buffer.com";
const X_POST_MAX_LENGTH = 280;

function isBufferConfigured() {
  return Boolean(cleanText(BUFFER_API_KEY) && cleanText(BUFFER_X_CHANNEL_ID));
}

function truncateText(value, maxLength) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, Math.max(0, maxLength));
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function buildBufferPostText({ ticker, title, footer = BUFFER_POST_FOOTER, maxLength = X_POST_MAX_LENGTH }) {
  const tickerLine = cleanText(ticker || "").replace(/^\$+/, "").toUpperCase();
  const titleText = cleanText(title || "News alert");
  const footerText = cleanText(footer || "");
  const firstLine = tickerLine ? `$${tickerLine}` : "News alert";
  const fixedLength = firstLine.length + footerText.length + 3;
  const titleBudget = Math.max(0, maxLength - fixedLength);
  const clampedTitle = truncateText(titleText, titleBudget);

  return [firstLine, clampedTitle, "", footerText]
    .filter((line, index) => index === 2 || cleanText(line))
    .join("\n")
    .slice(0, maxLength);
}

async function bufferGraphqlRequest(query, variables = {}) {
  const result = await fetchTextWithTimeout(
    BUFFER_API_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BUFFER_API_KEY}`
      },
      body: JSON.stringify({ query, variables })
    },
    BUFFER_TIMEOUT_MS
  );

  let payload = null;
  try {
    payload = result.body ? JSON.parse(result.body) : null;
  } catch (err) {
    throw new Error(`Buffer returned non-JSON response (${result.response.status}): ${result.body.slice(0, 200)}`);
  }

  if (!result.response.ok) {
    throw new Error(`Buffer request failed ${result.response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error(`Buffer GraphQL error: ${payload.errors.map(error => error.message || "unknown").join(" | ")}`);
  }

  return payload;
}

async function publishBufferXPost({ ticker, title }) {
  if (!isBufferConfigured()) {
    return null;
  }

  const text = buildBufferPostText({ ticker, title });
  const query = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post {
            id
            text
            status
            shareMode
            sharedNow
            channelId
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `;

  const payload = await bufferGraphqlRequest(query, {
    input: {
      text,
      channelId: BUFFER_X_CHANNEL_ID,
      schedulingType: "automatic",
      mode: BUFFER_SHARE_MODE
    }
  });
  const result = payload?.data?.createPost;

  if (result?.message && !result?.post) {
    throw new Error(`Buffer createPost failed: ${result.message}`);
  }

  return {
    text,
    post: result?.post || null
  };
}

async function listBufferOrganizationsAndChannels() {
  if (!cleanText(BUFFER_API_KEY)) {
    throw new Error("BUFFER_API_KEY is required.");
  }

  const accountPayload = await bufferGraphqlRequest(`
    query BufferAccount {
      account {
        email
        organizations {
          id
          name
          channelCount
        }
      }
    }
  `);
  const account = accountPayload?.data?.account || {};
  const organizations = Array.isArray(account.organizations) ? account.organizations : [];

  const results = [];
  for (const organization of organizations) {
    const channelsPayload = await bufferGraphqlRequest(`
      query BufferChannels($input: ChannelsInput!) {
        channels(input: $input) {
          id
          name
          displayName
          descriptor
          service
          type
          isDisconnected
          isLocked
          organizationId
        }
      }
    `, {
      input: {
        organizationId: organization.id
      }
    });

    results.push({
      organization,
      channels: Array.isArray(channelsPayload?.data?.channels) ? channelsPayload.data.channels : []
    });
  }

  return {
    accountEmail: account.email || null,
    organizations: results
  };
}

module.exports = {
  BUFFER_API_URL,
  X_POST_MAX_LENGTH,
  isBufferConfigured,
  buildBufferPostText,
  publishBufferXPost,
  listBufferOrganizationsAndChannels
};
