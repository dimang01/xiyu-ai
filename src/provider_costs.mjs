/**
 * Provider Cost Estimation
 *
 * Reads optional config/provider_pricing.json (gitignored).
 * Falls back gracefully when no pricing file is present.
 * Never hardcodes current prices — they change too often.
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import fs from 'node:fs';
import path from 'node:path';

const PRICING_PATH = path.resolve(process.cwd(), 'config/provider_pricing.json');

let _pricingCache = null;

/**
 * Load provider pricing config from config/provider_pricing.json.
 * Returns null if the file doesn't exist or cannot be parsed.
 */
export function loadProviderPricing() {
  if (_pricingCache !== undefined && _pricingCache !== null) return _pricingCache;
  try {
    if (!fs.existsSync(PRICING_PATH)) return null;
    const raw = fs.readFileSync(PRICING_PATH, 'utf8');
    _pricingCache = JSON.parse(raw);
    return _pricingCache;
  } catch {
    return null;
  }
}

// Exported for testing — reset the in-memory cache
export function _resetPricingCache() {
  _pricingCache = null;
}

/**
 * Estimate cost for a usage record against a loaded pricing config.
 *
 * @param {{ provider: string, model_type?: string, prompt_tokens?: number, completion_tokens?: number, images?: number }} usage
 * @param {object|null} pricing  result of loadProviderPricing(), or null
 * @returns {{ estimated_cost: number|null, currency: string|null }}
 */
export function estimateProviderCost(usage, pricing) {
  if (!pricing || !usage) return { estimated_cost: null, currency: null };

  const providerKey = String(usage.provider ?? '').toLowerCase();
  const modelType = String(usage.model_type ?? 'chat').toLowerCase();
  const providerPricing = pricing[providerKey];
  if (!providerPricing) return { estimated_cost: null, currency: null };

  const typePricing = providerPricing[modelType];
  if (!typePricing) return { estimated_cost: null, currency: null };

  const currency = typePricing.currency ?? null;
  let cost = 0;

  if (modelType === 'image') {
    const perImage = parseFloat(typePricing.per_image ?? 0);
    cost = perImage * (parseInt(usage.images, 10) || 0);
  } else {
    const inputRate = parseFloat(typePricing.input_per_1m_tokens ?? 0);
    const outputRate = parseFloat(typePricing.output_per_1m_tokens ?? 0);
    cost = (inputRate * (parseInt(usage.prompt_tokens, 10) || 0)) / 1_000_000
         + (outputRate * (parseInt(usage.completion_tokens, 10) || 0)) / 1_000_000;
  }

  return { estimated_cost: parseFloat(cost.toFixed(8)), currency };
}
