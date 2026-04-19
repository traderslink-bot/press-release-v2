const {
  OPENAI_PRICE_INPUT_PER_1M,
  OPENAI_PRICE_CACHED_INPUT_PER_1M,
  OPENAI_PRICE_OUTPUT_PER_1M
} = require("./config");

const MODEL_PRICING_PER_1M = {
  "gpt-5.4": {
    input: 2.5,
    cachedInput: 0.25,
    output: 15
  },
  "gpt-5.4-mini": {
    input: 0.75,
    cachedInput: 0.075,
    output: 4.5
  },
  "gpt-5-mini": {
    input: 0.75,
    cachedInput: 0.075,
    output: 4.5,
    assumption: "Assumed GPT-5.4 mini pricing for gpt-5-mini alias."
  },
  "gpt-5.4-nano": {
    input: 0.2,
    cachedInput: 0.02,
    output: 1.25
  }
};

function roundUsd(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function normalizeModelPricing(model) {
  const normalizedModel = String(model || "").trim().toLowerCase();
  const envConfigured =
    Number.isFinite(OPENAI_PRICE_INPUT_PER_1M) &&
    Number.isFinite(OPENAI_PRICE_OUTPUT_PER_1M);

  if (envConfigured) {
    return {
      source: "env_override",
      model: normalizedModel,
      input: OPENAI_PRICE_INPUT_PER_1M,
      cachedInput: Number.isFinite(OPENAI_PRICE_CACHED_INPUT_PER_1M)
        ? OPENAI_PRICE_CACHED_INPUT_PER_1M
        : OPENAI_PRICE_INPUT_PER_1M,
      output: OPENAI_PRICE_OUTPUT_PER_1M,
      assumption: null
    };
  }

  const matched = MODEL_PRICING_PER_1M[normalizedModel];
  if (!matched) {
    return null;
  }

  return {
    source: "built_in_estimate",
    model: normalizedModel,
    input: matched.input,
    cachedInput: matched.cachedInput ?? matched.input,
    output: matched.output,
    assumption: matched.assumption || null
  };
}

function extractUsage(data) {
  const usage = data?.usage || {};
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens || 0);
  const cachedInputTokens = Number(usage?.prompt_tokens_details?.cached_tokens || 0);
  const uncachedInputTokens = Math.max(promptTokens - cachedInputTokens, 0);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedInputTokens,
    uncachedInputTokens
  };
}

function buildOpenAIUsageMetrics({ model, data, operation, attempts }) {
  const usage = extractUsage(data);
  const pricing = normalizeModelPricing(model);

  let estimatedCostUsd = null;
  if (pricing) {
    estimatedCostUsd =
      ((usage.uncachedInputTokens / 1_000_000) * pricing.input) +
      ((usage.cachedInputTokens / 1_000_000) * pricing.cachedInput) +
      ((usage.completionTokens / 1_000_000) * pricing.output);
  }

  return {
    operation,
    model,
    attempts: Number.isFinite(attempts) ? attempts : 1,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens,
    uncachedInputTokens: usage.uncachedInputTokens,
    estimatedCostUsd: roundUsd(estimatedCostUsd),
    pricingSource: pricing?.source || "unknown",
    pricingAssumption: pricing?.assumption || null,
    pricingPer1M: pricing
      ? {
          input: pricing.input,
          cachedInput: pricing.cachedInput,
          output: pricing.output
        }
      : null
  };
}

function summarizeOpenAIUsage(items) {
  const normalizedItems = Array.isArray(items) ? items.filter(Boolean) : [];
  const costValues = normalizedItems
    .map(item => item.estimatedCostUsd)
    .filter(value => Number.isFinite(value));

  return {
    callCount: normalizedItems.length,
    promptTokens: normalizedItems.reduce((sum, item) => sum + Number(item.promptTokens || 0), 0),
    completionTokens: normalizedItems.reduce((sum, item) => sum + Number(item.completionTokens || 0), 0),
    totalTokens: normalizedItems.reduce((sum, item) => sum + Number(item.totalTokens || 0), 0),
    cachedInputTokens: normalizedItems.reduce((sum, item) => sum + Number(item.cachedInputTokens || 0), 0),
    uncachedInputTokens: normalizedItems.reduce((sum, item) => sum + Number(item.uncachedInputTokens || 0), 0),
    estimatedCostUsd: costValues.length
      ? roundUsd(costValues.reduce((sum, value) => sum + value, 0))
      : null
  };
}

module.exports = {
  buildOpenAIUsageMetrics,
  summarizeOpenAIUsage
};
