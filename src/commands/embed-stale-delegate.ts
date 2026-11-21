import type { GBrainConfig } from '../core/config.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { maybeDelegateLocalAdministration, persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { PersistenceIpcTransportError } from '../core/persistence/ipc.ts';
import { staleEmbedArgs, validateStaleEmbedOptions, type StaleEmbedOptions, type StaleEmbedOutcome } from '../core/persistence/embed-stale-administration.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { BUDGET_STOP_EXIT_CODE } from '../core/exit-codes.ts';
import { jsonRequested, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { isConsentRefusal, printConsentRefusal, requireConsent, type ConfirmationPayload, type ConsentEnv, type ConsentRefusal } from '../core/consent.ts';
import { isInteractive } from '../core/interaction.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';

/**
 * `gbrain embed --stale [--source S] [--dry-run] [--yes | --max-usd N] [--json]`
 * while a running `gbrain serve` holds the PGLite brain: instead of failing
 * `pglite_busy`, the CLI hands the drain to that owner (`writer_embed_stale`),
 * which runs it as the CLI would (core/persistence/embed-stale-administration.ts):
 * consent and the approved cap, the image sweep, the CLI's budget. The CLI
 * keeps what only it can do: the keyless clean refusal (file plane), the
 * terminal prompt for a paid run, the output and the exit code (the result
 * JSON under --json, 3 for a consent refusal, 11 for a budget or cost-cap
 * stop, 1 for failures or a stall). Any other `embed` form keeps its path (no
 * delegation): facts, images, a slug, --all, --catch-up, pacing flags.
 */
const OWN_FLAGS = new Set(['--stale', '--dry-run', '--json', '--quiet', '--yes']);
const VALUE_FLAGS = new Set(['--source', '--max-usd', '--max-cost']);
/** embedAllStale's default wall-clock budget when GBRAIN_EMBED_TIME_BUDGET_MS is unset (commands/embed.ts). */
const DEFAULT_BUDGET_MS = 30 * 60 * 1000;

export function staleEmbedDelegable(args: string[]): boolean {
  if (!args.includes('--stale') || args.includes('--facts')) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (OWN_FLAGS.has(arg)) continue;
    if (VALUE_FLAGS.has(arg)) { i++; continue; }
    return false;
  }
  return true;
}

/** The budget the CLI's own run would take: its GBRAIN_EMBED_TIME_BUDGET_MS, or the 30-minute default. */
export function cliStaleBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GBRAIN_EMBED_TIME_BUDGET_MS;
  return raw === undefined || raw === '' ? DEFAULT_BUDGET_MS : Number(raw);
}

export function staleEmbedOptionsFromArgs(args: string[], env: Record<string, string | undefined> = process.env): StaleEmbedOptions {
  const value = (flags: string[]) => {
    const at = args.findIndex(a => flags.includes(a));
    return at >= 0 ? args[at + 1] : undefined;
  };
  const usd = value(['--max-usd', '--max-cost']);
  if (usd !== undefined && !(Number(usd) > 0)) {
    throw opError('invalid_params', `--max-usd needs a positive number of dollars, not ${JSON.stringify(usd)}`, 'Pass --max-usd with the cap the user approved, e.g. --max-usd 1.');
  }
  const source = value(['--source']);
  return validateStaleEmbedOptions({
    budgetMs: cliStaleBudgetMs(env),
    ...(source !== undefined ? { sourceId: source } : {}),
    ...(args.includes('--dry-run') ? { dryRun: true } : {}),
    ...(args.includes('--yes') ? { yes: true } : {}),
    ...(usd !== undefined ? { maxUsd: Number(usd) } : {}),
    ...(args.includes('--quiet') ? { quiet: true } : {}),
  });
}

/**
 * The CLI's terminal prompt for a paid run the owner refused for want of
 * consent: the same question requireConsent asks a direct run. True when the
 * user agreed: the CLI then sends the run again with --yes, whose cap is the
 * one a terminal approval gets (the estimate x1.5). False when there is no
 * terminal, the run already carried an approval, or the user declines (the
 * refusal then stands).
 */
export async function promptForStaleEmbed(refusal: ConfirmationPayload, options: StaleEmbedOptions,
  env: Pick<ConsentEnv, 'interactive' | 'readLine'> = {}): Promise<boolean> {
  if (options.yes || options.maxUsd !== undefined || !(env.interactive ?? isInteractive())) return false;
  const args = staleEmbedArgs(options);
  const argv = ['gbrain', 'embed', ...args];
  try {
    await requireConsent({
      command: 'embed', effects: refusal.effects, actor: refusal.actor, what: 'Embedding backfill',
      why: refusal.why, risk: refusal.risk, user_message: refusal.user_message,
      argv, preview_argv: [...argv, '--dry-run'], est_usd: refusal.est_usd, args,
    }, { interactive: true, preapprovals: {}, getConfig: async () => null, note: () => {}, ...(env.readLine ? { readLine: env.readLine } : {}) });
    return true;
  } catch (error) {
    if (isConsentRefusal(error)) return false;
    throw error;
  }
}

export async function maybeDelegateStaleEmbed(hostConfig: GBrainConfig | null, args: string[]): Promise<boolean> {
  if (!staleEmbedDelegable(args)) return false;
  const brainId = resolveBrainId(getCliOptions().brain, process.cwd());
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url || !inspectLockHolder(config.database_path).held) return false;
  const json = jsonRequested(args);
  try {
    // The keyless clean refusal reads the file plane, as runEmbed does: answer it here, nothing to hand over.
    const keyless = await (await import('./embed.ts')).keylessStaleRefusal(args);
    if (keyless) {
      if (json) await writeStdoutFinal(`${JSON.stringify(keyless, null, 2)}\n`);
      return true;
    }
    const quiet = getCliOptions().quiet || args.includes('--quiet');
    const options = { ...staleEmbedOptionsFromArgs(args), ...(quiet ? { quiet: true } : {}) };
    let outcome = await delegate(options, config);
    // An owner without this lane (older gbrain): the direct path, as before.
    if (!outcome) return false;
    if (outcome.refusal && await promptForStaleEmbed(outcome.refusal, options)) {
      outcome = await delegate({ ...options, yes: true }, config);
      if (!outcome) return false;
    }
    for (const line of outcome.lines ?? []) {
      if (line.to === 'err' || json) process.stderr.write(`${line.text}\n`);
      else if (!quiet) process.stdout.write(`${line.text}\n`);
    }
    if (outcome.refusal) {
      setCliExitVerdict(printConsentRefusal({ consent: outcome.refusal } as ConsentRefusal, { json }));
      return true;
    }
    const result = outcome.result!;
    if (json) await writeStdoutFinal(`${JSON.stringify(result, null, 2)}\n`);
    // The exit verdicts of src/cli/commands/embed.ts, plus runEmbed's hard exit on a stall.
    if (result.reason === 'cost_cap') setCliExitVerdict(BUDGET_STOP_EXIT_CODE);
    else if (result.failures > 0 || result.reason === 'stall_timeout') setCliExitVerdict(1);
    else if (result.reason === 'time_budget') setCliExitVerdict(BUDGET_STOP_EXIT_CODE);
    return true;
  } catch (error) {
    if (error instanceof PersistenceIpcTransportError && error.sent) {
      error = new OperationError('write_pending', 'The stale embedding acknowledgment was lost; the owner may still be finishing the bounded run.',
        'Wait for the owner to finish, then run gbrain embed --stale --dry-run to see what is left.');
    }
    if (await reportPersistenceCliError(error, json)) return true;
    throw error;
  }
}

async function delegate(options: StaleEmbedOptions, config: NonNullable<ReturnType<typeof persistenceConfigForBrain>>): Promise<StaleEmbedOutcome | null> {
  // The owner's run may take its budget, one batch to the model and the drain's own steps.
  const batchMs = Number.parseInt(process.env.GBRAIN_AI_EMBED_TIMEOUT_MS ?? '', 10);
  const timeoutMs = options.budgetMs + (Number.isFinite(batchMs) ? batchMs : 60_000) + 5 * 60_000;
  const delegated = await maybeDelegateLocalAdministration('writer_embed_stale', { options }, config, { timeoutMs });
  return delegated.handled ? delegated.result as StaleEmbedOutcome : null;
}
