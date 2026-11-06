/**
 * Shared contracts between core/, platform/ and tools/. JSDoc only: nothing here runs.
 *
 * @typedef {{id: string, title: string, url: string}} BookmarkItem url already sanitized
 * @typedef {{name: string, description?: string}} Folder
 * @typedef {{id: string, folder: string, confidence: 'high' | 'low', servedModel: string, requestId: string | null}} Assignment
 * @typedef {{id: string, reason: 'refusal' | 'truncated' | 'missing', refusalCategory: string | null}} Unclassified
 * @typedef {{system: string, user: string, schema: object, maxTokens: number}} CompletionRequest
 * @typedef {{model: string, inputTokens: number, outputTokens: number, thinkingTokens: number, kind: 'message' | 'fallback_message'}} UsageAttempt
 * @typedef {{
 *   data: unknown,
 *   stopReason: string,
 *   refusalCategory: string | null,
 *   servedModel: string,
 *   requestId: string | null,
 *   latencyMs: number,
 *   usage: {attempts: UsageAttempt[], inputTokens: number, outputTokens: number, thinkingTokens: number, usedFallback: boolean},
 * }} CompletionResult
 * @typedef {(request: CompletionRequest) => Promise<CompletionResult>} Complete
 * @typedef {{
 *   inputTokens: number, outputTokens: number, thinkingTokens: number, maxThinkingTokens: number,
 *   latencies: number[], fallbacks: number, waits: number, failedCalls: number, spentUsd: number, lostUsd: number,
 *   servedModels: Record<string, number>,
 * }} ModelMetrics
 * @typedef {{
 *   model: string,
 *   status: 'running' | 'complete' | 'stopped',
 *   effort: string | null,
 *   folders: Folder[],
 *   dropped: {name: string, reason: string}[],
 *   taxonomyAttempts: number,
 *   taxonomyBuiltFrom: number,
 *   taxonomyRefusals: number,
 *   taxonomyTruncations: number,
 *   taxonomySpentUsd?: number,
 *   fixedTaxonomy?: boolean,
 *   assignments: Assignment[],
 *   unclassified: Unclassified[],
 *   totals: {calls: number, retries: number, splits: number, refusals: number, truncations: number, invalidEntries: number},
 *   metrics: ModelMetrics,
 * }} ModelResult what `renderReport` and `summarizeModel` take; `model` is `provider/model`
 */

export {};
