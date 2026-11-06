import { formatUsd } from '../../extension/core/budget.js';
import { UNSORTED } from '../../extension/core/classify.js';
import { findModel, isExpectedServedModel } from '../../extension/core/models.js';
import { assessCompleteness, MAX_UNCLASSIFIED_SHARE, summarizeModel } from './manifest.mjs';
import { safeInline } from './safe-text.mjs';

const REFERENCE_COLLECTION_SIZE = 2000;

/** @param {number} ratio */
export const formatPercent = (ratio) => `${(ratio * 100).toFixed(1)} %`;

/** @param {Record<string, number> | undefined} counts */
const formatCounts = (counts) => {
  const entries = Object.entries(counts ?? {});
  return entries.length === 0 ? 'none' : entries.map(([key, count]) => `${safeInline(key, 60)}: ${count}`).join(', ');
};

/**
 * Nearest-rank percentile, so that p95 of ten samples is the 10th and p50 of two is the first.
 *
 * @param {number[]} sorted ascending
 * @param {number} p
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/**
 * @param {any} result a ModelResult
 * @param {number} expected size of the classification sample
 * @param {string | null} fixedSha256 hash of the taxonomy file, when the folders were not proposed
 */
function renderModelSection(result, expected, fixedSha256) {
  const { model, status, effort, folders, dropped, assignments, unclassified, totals, metrics } = result;
  const isComplete = status === 'complete';
  const fixed = Boolean(result.fixedTaxonomy);
  const unsorted = assignments.filter((/** @type {any} */ a) => a.folder === UNSORTED).length;
  const inFolder = assignments.length - unsorted;
  const low = assignments.filter((/** @type {any} */ a) => a.confidence === 'low').length;
  const latencies = [...metrics.latencies].sort((a, b) => a - b);

  /** @type {Map<string, number>} */
  const perFolder = new Map();
  for (const { folder } of assignments) perFolder.set(folder, (perFolder.get(folder) ?? 0) + 1);
  /** @type {Record<string, number>} */
  const reasons = {};
  for (const { reason } of unclassified) reasons[reason] = (reasons[reason] ?? 0) + 1;
  /** @type {Record<string, number>} */
  const droppedReasons = {};
  for (const { reason } of dropped) droppedReasons[reason] = (droppedReasons[reason] ?? 0) + 1;

  const used = folders.filter((/** @type {any} */ folder) => (perFolder.get(folder.name) ?? 0) > 0).length;
  const largest = Math.max(0, ...folders.map((/** @type {any} */ folder) => perFolder.get(folder.name) ?? 0));
  const { missing, notAttempted, unclassifiedShare, complete } = assessCompleteness(/** @type {any} */ (summarizeModel(result)), expected);
  const passes = isComplete && complete;
  const attemptedItems = assignments.length + unclassified.length;
  const catalogEntry = findModel(model);
  const unexpected = Object.keys(metrics.servedModels ?? {}).filter((id) => catalogEntry && !isExpectedServedModel(model, id));

  // The one-off taxonomy call does not grow with the collection, so only the rest is scaled.
  // What was charged for calls that gave no usable answer is a one-off of that run, not a cost per bookmark.
  const lost = metrics.lostUsd ?? 0;
  const netSpent = metrics.spentUsd - lost;
  const taxonomyCost = Math.min(result.taxonomySpentUsd ?? 0, netSpent);
  const projected = attemptedItems > 0 ? taxonomyCost + ((netSpent - taxonomyCost) / attemptedItems) * REFERENCE_COLLECTION_SIZE : null;
  const lostNote = lost > 0 ? ` (${formatUsd(lost)} of it charged for calls that gave no usable answer)` : '';
  const refusedShare = attemptedItems > 0 ? (unclassified.length - missing) / attemptedItems : 0;
  const basis = isComplete ? 'the sample' : 'what was attempted';
  const note = catalogEntry?.note ? ` Note on this model: ${safeInline(catalogEntry.note, 300)}` : '';

  return [
    `## ${safeInline(model)}${isComplete ? '' : ' (INCOMPLETE: stopped before finishing)'}`,
    '',
    `**M0 completeness: ${passes ? 'PASS' : 'FAIL'}** (missing=${missing}, not attempted=${notAttempted})`,
    ...(unclassifiedShare > MAX_UNCLASSIFIED_SHARE
      ? ['', `**Over the limit:** ${formatPercent(unclassifiedShare)} of ${basis} stayed unclassified, and \`score\` tolerates ${formatPercent(MAX_UNCLASSIFIED_SHARE)}.`]
      : []),
    ...(unexpected.length > 0
      ? ['', `**Unexpected model answered:** ${unexpected.map((id) => safeInline(id, 80)).join(', ')} instead of ${safeInline(model)}. This is not a measurement of the model you asked for.`]
      : []),
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Status / effort | ${isComplete ? 'complete' : safeInline(String(status), 30)} / ${safeInline(String(effort ?? 'default'), 20)} |`,
    `| Placed in a folder | ${inFolder} of ${expected} |`,
    `| Sent to unsorted (model found no fit) | ${unsorted} |`,
    `| Missing after retries | ${missing} |`,
    `| Refused or truncated | ${unclassified.length - missing} (${formatPercent(refusedShare)} of ${basis}; ${formatCounts(reasons)}) |`,
    `| Low confidence | ${low} (${formatPercent(assignments.length ? low / assignments.length : 0)} of answered) |`,
    `| Folders used / ${fixed ? 'in the file' : 'proposed'} | ${used} / ${folders.length} |`,
    `| Largest folder share | ${formatPercent(assignments.length ? largest / assignments.length : 0)} |`,
    ...(fixed
      ? []
      : [
          `| Proposals discarded | ${dropped.length} (${formatCounts(droppedReasons)}) |`,
          `| Taxonomy built from | ${result.taxonomyBuiltFrom} bookmarks, ${result.taxonomyAttempts} attempt(s), ${result.taxonomyRefusals} refusals, ${result.taxonomyTruncations} truncations |`,
        ]),
    `| Invalid entries before retrying | ${totals.invalidEntries} |`,
    `| Retries / splits | ${totals.retries} / ${totals.splits} |`,
    `| Refusals / truncations (classification) | ${totals.refusals} / ${totals.truncations} |`,
    `| Responses served by a fallback model | ${metrics.fallbacks} |`,
    `| Models that answered (calls) | ${formatCounts(metrics.servedModels)} |`,
    `| API calls ok / failed / rate-limit waits | ${metrics.latencies.length} / ${metrics.failedCalls} / ${metrics.waits} |`,
    `| Latency per call p50 / p95 | ${Math.round(percentile(latencies, 0.5))} ms / ${Math.round(percentile(latencies, 0.95))} ms |`,
    `| Tokens in / out (out includes reasoning) | ${metrics.inputTokens} / ${metrics.outputTokens} |`,
    `| Reasoning tokens total / largest single call | ${metrics.thinkingTokens} / ${metrics.maxThinkingTokens} |`,
    `| Cost of this run | ${formatUsd(metrics.spentUsd)}${lostNote}${note} |`,
    `| Projected cost per ${REFERENCE_COLLECTION_SIZE} bookmarks${catalogEntry?.note ? ' (rough)' : ' (rough, about ±15 %)'} | ${projected === null ? 'n/a' : formatUsd(projected)} |`,
    '',
    fixed ? `Taxonomy: from file ${fixedSha256 ? fixedSha256.slice(0, 12) : 'unknown hash'}` : '### Proposed folders',
    '',
    ...folders.map((/** @type {any} */ folder) => `- **${safeInline(folder.name, 80)}** (${perFolder.get(folder.name) ?? 0}): ${safeInline(folder.description ?? '', 200)}`),
    ...(!fixed && dropped.length > 0
      ? ['', '### Discarded proposals', '', ...dropped.map((/** @type {any} */ d) => `- ${safeInline(d.name, 80)}: ${safeInline(d.reason, 40)}`)]
      : []),
    '',
  ].join('\n');
}

/**
 * @param {{manifest: any, results: any[]}} input
 */
export function renderReport({ manifest, results }) {
  const { input, params } = manifest;
  const sampleSize = manifest.sample_size ?? params.sample;
  const quality = manifest.quality;
  const stillBilling = /may still be billed/.test(String(manifest.stopped_by ?? ''));
  return [
    '# Bookmark classification evaluation',
    '',
    `Bookmarks in export: ${input.bookmarks}. Never sent: ${input.bookmarks - input.sendable} (${formatCounts(input.excluded)}). Classification sample: ${sampleSize}. Seed: ${params.seed}.`,
    '',
    `Total spent: ${formatUsd(manifest.spent_usd)} of a ${formatUsd(params.max_usd)} cap${(manifest.lost_usd ?? 0) > 0 ? ` (${formatUsd(manifest.lost_usd)} of it charged for calls that gave no usable answer)` : ''}.${stillBilling ? ' This total may be low: a call in flight may still be billed.' : ''}`,
    '',
    ...(manifest.spent_usd > params.max_usd
      ? [`**The spending cap was crossed** (${formatUsd(manifest.spent_usd)} of ${formatUsd(params.max_usd)}).`, '']
      : []),
    ...(manifest.cap_broken_by
      ? [
          `**The cap cannot be trusted with ${safeInline(manifest.cap_broken_by.model, 80)}:** it returned ${manifest.cap_broken_by.output_tokens} output tokens for a maximum of ${manifest.cap_broken_by.max_tokens}.`,
          '',
        ]
      : []),
    ...(manifest.stopped_by ? [`**Stopped early.** ${safeInline(String(manifest.stopped_by), 300)}`, ''] : []),
    ...(quality
      ? [
          `Data quality (counts only): exact duplicates ${quality.exactDuplicates}, duplicates after URL reduction ${quality.duplicatesAfterReduction}, empty titles ${quality.emptyTitles}, title equal to URL ${quality.titleIsUrl}, URL reduced to the host alone ${quality.hostOnlyUrls}.`,
          '',
        ]
      : []),
    ...results.map((result) => renderModelSection(result, sampleSize, manifest.taxonomy_sha256 ?? null)),
  ].join('\n');
}
