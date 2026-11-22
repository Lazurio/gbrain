import type { BrainEngine } from '../engine.ts';
import type { EmbedResult } from '../../commands/embed.ts';
import type { ConfirmationPayload } from '../consent.ts';
import { opError } from '../ops/contract.ts';
import { assertValidSourceId } from '../source-id.ts';
import { currentVerifiedLocalWriter } from './identity.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { withHumanLineSink } from '../console-prefix.ts';
import { EmbeddingDisabledError } from '../embedding-dim-check.ts';

/**
 * `gbrain embed --stale` while a resident owner holds the brain (PGLite): the
 * owner runs the stale drain itself, so a CLI no longer has to stop the
 * server to compute the vectors still missing. The run is the CLI's own, as
 * src/cli/commands/embed.ts and runEmbed make it:
 * - consent first: the CLI's --yes / --max-usd, spend.posture=tokenmax or the
 *   user's preapproval; never a prompt in the owner's terminal. Without one, a
 *   paid run returns the consent refusal (`refusal`), which the CLI prints
 *   with exit 3 or turns into its own terminal prompt;
 * - the approved cap meters the run (the image sweep and the text drain);
 * - the multimodal image sweep before the text drain;
 * - the CLI's wall-clock budget (`budgetMs`, always sent), never the server's
 *   process setting;
 * - the human lines the run prints come back in `lines` for the CLI to print.
 * Like fact repair, only a current trusted local CLI may ask.
 */
export interface StaleEmbedOptions {
  sourceId?: string;
  dryRun?: boolean;
  budgetMs: number;
  yes?: boolean;
  maxUsd?: number;
  /** The CLI's --quiet: the drain's own summary lines (healed pages, the totals) are dropped, as on the direct path. */
  quiet?: boolean;
}

/** `err`: what the CLI's run writes to stderr; `out`: its stdout verdicts (stderr under --json). */
export interface StaleEmbedLine { to: 'out' | 'err'; text: string }
export interface StaleEmbedOutcome { result?: EmbedResult; refusal?: ConfirmationPayload; lines: StaleEmbedLine[] }

export function validateStaleEmbedOptions(value: unknown): StaleEmbedOptions {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const allowed = ['sourceId', 'dryRun', 'budgetMs', 'yes', 'maxUsd', 'quiet'];
  const extra = Object.keys(raw).filter(key => !allowed.includes(key));
  if (extra.length > 0) {
    throw opError('invalid_params', `Unknown stale embedding option ${extra[0]}`,
      'Run gbrain embed --stale [--source S] [--dry-run] [--yes | --max-usd N]; it builds the options this owner lane accepts.');
  }
  if (typeof raw.budgetMs !== 'number' || !Number.isInteger(raw.budgetMs) || raw.budgetMs < 1_000) {
    throw opError('invalid_params', 'budgetMs must be a whole number of milliseconds, at least 1000',
      'Set GBRAIN_EMBED_TIME_BUDGET_MS to the run budget in milliseconds, or unset it for the 30-minute default.');
  }
  const options: StaleEmbedOptions = { budgetMs: raw.budgetMs };
  if (raw.sourceId !== undefined) {
    assertValidSourceId(raw.sourceId);
    options.sourceId = raw.sourceId as string;
  }
  for (const key of ['dryRun', 'yes', 'quiet'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') throw opError('invalid_params', `${key} must be a boolean`, `Pass --${key === 'dryRun' ? 'dry-run' : key} or nothing.`);
    options[key] = raw[key] as boolean;
  }
  if (raw.maxUsd !== undefined) {
    if (typeof raw.maxUsd !== 'number' || !Number.isFinite(raw.maxUsd) || raw.maxUsd <= 0) {
      throw opError('invalid_params', 'maxUsd must be a positive number of dollars', 'Pass --max-usd with the cap the user approved, e.g. --max-usd 1.');
    }
    options.maxUsd = raw.maxUsd;
  }
  return options;
}

/** The CLI arguments the options stand for: what consent reads and what a resume command repeats. */
export function staleEmbedArgs(options: StaleEmbedOptions): string[] {
  return ['--stale',
    ...(options.sourceId ? ['--source', options.sourceId] : []),
    ...(options.dryRun ? ['--dry-run'] : []),
    ...(options.yes ? ['--yes'] : []),
    ...(options.maxUsd !== undefined ? ['--max-usd', String(options.maxUsd)] : [])];
}

export async function runAuthenticatedStaleEmbedding(engine: BrainEngine, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const verified = currentVerifiedLocalWriter();
  if (!verified || verified.remote || verified.principal.kind !== 'local_cli') {
    throw trustedCliRequired('Stale embedding requires a current trusted CLI registration');
  }
  if (Object.keys(params).some(key => key !== 'options')) {
    throw opError('invalid_params', 'Stale embedding requires typed options',
      'Run the CLI command gbrain embed --stale; it builds the typed options this owner lane accepts.');
  }
  const options = validateStaleEmbedOptions(params.options);
  const args = staleEmbedArgs(options);
  const lines: StaleEmbedLine[] = [];
  const out = (text: string) => { lines.push({ to: 'out', text }); };
  const err = (text: string) => { lines.push({ to: 'err', text }); };

  // Consent, as the CLI's authorizeEmbed asks it for a stale run; a dry run spends nothing.
  let authorization: Awaited<ReturnType<typeof import('../embed-consent.ts').requireEmbedBackfillConsent>> = null;
  if (!options.dryRun) {
    const { requireEmbedBackfillConsent } = await import('../embed-consent.ts');
    const { isConsentRefusal } = await import('../consent.ts');
    const argv = ['gbrain', 'embed', ...args.filter(a => a !== '--yes')];
    try {
      authorization = await requireEmbedBackfillConsent(engine, {
        command: 'embed', argv, preview_argv: [...argv, '--dry-run'], args,
        scope: { all: false, ...(options.sourceId ? { sourceId: options.sourceId } : {}), unestimated: false },
        env: { interactive: false, note: err },
      });
    } catch (error) {
      if (isConsentRefusal(error)) return { refusal: error.consent, lines } satisfies StaleEmbedOutcome;
      throw error;
    }
  }

  const { runEmbedCore } = await import('../../commands/embed.ts');
  const { embedCostCap, noteEmbedCostStop, embedCostStopVerdict } = await import('../embed-cost-cap.ts');
  const { loadPricingOverrides } = await import('../budget/budget-tracker.ts');
  const { runStaleImageSweepFirst, foldImageSweep } = await import('../embed-stale-images.ts');
  const { embedBudgetStopVerdict } = await import('../embed-budget-stop.ts');
  const costCap = options.dryRun || authorization?.cap_usd == null ? null
    : embedCostCap(authorization.cap_usd, authorization.cap_source, await loadPricingOverrides(engine));
  const controller = new AbortController();
  let work: Promise<unknown> | undefined;
  // The owner's shutdown ends the drain between batches; what it computed stays.
  const unregister = engine.registerBeforeDisconnect(async () => {
    controller.abort();
    await work?.catch(() => {});
  });
  try {
    const run = withHumanLineSink(err, async (): Promise<EmbedResult> => {
      const images = await runStaleImageSweepFirst(engine, { sourceId: options.sourceId, dryRun: options.dryRun === true, costCap });
      const opts = {
        stale: true, quiet: options.quiet === true, singleFlight: true,
        signal: costCap ? AbortSignal.any([controller.signal, costCap.signal]) : controller.signal,
        timeBudgetMs: options.budgetMs,
        ...(options.sourceId ? { sourceId: options.sourceId } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
      };
      return foldImageSweep(costCap ? await costCap.metered(() => runEmbedCore(engine, opts)) : await runEmbedCore(engine, opts), images);
    });
    work = run;
    let result: EmbedResult;
    try {
      result = await run;
    } catch (error) {
      const capped = costCap?.hit();
      if (!capped) throw embeddingDisabledRefusal(error);
      result = { embedded: 0, skipped: 0, would_embed: 0, total_chunks: 0, pages_processed: 0, failures: 0, failure_samples: [], dryRun: false, chunkless_pages_healed: 0 };
    }
    // The CLI's own verdicts (runEmbed): a cost-cap stop, failed chunks, a stall, a budget stop.
    const capped = costCap?.hit();
    if (capped) {
      noteEmbedCostStop(result, capped, args);
      out(embedCostStopVerdict(result, capped));
    } else {
      if (result.failures > 0) err(`[embed] ${result.failures} chunk(s) failed to embed. First error: ${result.failure_samples[0] ?? 'unknown'}`);
      if (result.reason === 'stall_timeout') err('[embed] exiting non-zero: stall watchdog aborted the drain (reason: stall_timeout); partial progress banked — re-run to resume.');
      else if (result.reason === 'time_budget') out(embedBudgetStopVerdict(result));
    }
    // #6803 (src/cli/commands/embed.ts): large pages waiting for approval left the stale queue; say so.
    const { budgetLimitedReport } = await import('../held-embedding.ts');
    const { currentEmbeddingSignature } = await import('../embedding.ts');
    const { renderAction, cliRenderContext } = await import('../agent-output.ts');
    const found = await budgetLimitedReport(engine, { ...(options.sourceId ? { sourceId: options.sourceId } : {}), signature: currentEmbeddingSignature() });
    if (found) {
      Object.assign(result, { budget_limited: { ...found.report, fix: renderAction(found.fix, cliRenderContext()) } });
      out(`[embed] ${found.line}`);
    }
    return { result, lines } satisfies StaleEmbedOutcome;
  } finally {
    unregister();
  }
}

function embeddingDisabledRefusal(error: unknown): unknown {
  if (!(error instanceof EmbeddingDisabledError)) return error;
  return opError('embedding_disabled', error.message,
    'Embeddings are disabled for this brain, so there are no vectors to compute and nothing was spent. Enabling an embedding provider is the user\'s decision because it can cost money.',
    { fix: readFix('Reports the brain\'s embedding readiness, read-only.', { argv: ['gbrain', 'doctor', '--only', 'embeddings', '--json'] }) });
}
