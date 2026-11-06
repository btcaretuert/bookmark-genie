/**
 * Picks the adapter for a `provider/model` reference. The caller passes the key; nothing here
 * reads the environment, so the credential and the destination are never someone else's default.
 */

import { effortFor, findModel, parseModelRef } from '../core/models.js';
import { createClaudeComplete } from './llm.js';
import { createOpenAiCompatibleComplete } from './openai-compatible.js';
import { getProvider, resolveBaseURL } from './providers.js';

/**
 * @param {{
 *   ref: string,
 *   apiKey: string,
 *   baseURL?: string,
 *   Anthropic?: any,
 *   timeoutMs?: number,
 *   effort?: string | null,
 *   fallback?: boolean,
 * }} options
 *   `baseURL`: only a loopback address, for tests. `Anthropic`: the SDK class, needed only for
 *   that provider. `effort`: a level a catalog model does not confirm is not sent; use `effortFor`
 *   to record what really went out. `fallback` only exists on Anthropic: asking for it elsewhere
 *   is an error rather than a measurement that quietly lacks it.
 * @returns {import('../core/types.js').Complete}
 */
export function createComplete({ ref, apiKey, baseURL, Anthropic, timeoutMs, effort, fallback = false }) {
  const { provider: providerId, model } = parseModelRef(ref);
  const provider = getProvider(providerId);
  if (fallback && provider.adapter !== 'anthropic-sdk') throw new Error(`--fallback is only available with Anthropic, not with ${provider.name}`);

  const entry = findModel(ref);
  const sentEffort = entry ? effortFor(entry, effort) : effort;

  if (provider.adapter !== 'anthropic-sdk') {
    return createOpenAiCompatibleComplete({ provider: providerId, model, apiKey, baseURL, timeoutMs, effort: sentEffort });
  }
  if (!apiKey) throw new Error(`${provider.keyEnv} is required for ${provider.name}`);
  if (!Anthropic) throw new Error('The Anthropic SDK class is required for an anthropic/ model');
  return createClaudeComplete({
    Anthropic,
    model,
    apiKey,
    // Always explicit: without it, the SDK would read ANTHROPIC_BASE_URL on its own.
    baseURL: resolveBaseURL(provider, baseURL),
    timeoutMs,
    effort: /** @type {'low' | 'medium' | 'high' | undefined} */ (sentEffort ?? undefined),
    fallback,
  });
}
