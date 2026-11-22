import { describe, expect, test } from 'bun:test';
import { cliStaleBudgetMs, promptForStaleEmbed, staleEmbedDelegable, staleEmbedOptionsFromArgs } from '../src/commands/embed-stale-delegate.ts';
import { staleEmbedArgs, validateStaleEmbedOptions } from '../src/core/persistence/embed-stale-administration.ts';
import { isPersistenceAdminExtension, PERSISTENCE_ADMIN_OPERATIONS } from '../src/core/persistence/admin-contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { ConfirmationPayload } from '../src/core/consent.ts';

/** The agent envelope of the refusal `fn` throws. */
const refusalOf = (fn: () => unknown): Record<string, unknown> => {
  try {
    fn();
  } catch (error) {
    if (error instanceof OperationError) return error.toJSON() as Record<string, unknown>;
    throw error;
  }
  throw new Error('no refusal');
};

// `gbrain embed --stale` while a resident serve holds the PGLite brain: the
// CLI hands the drain to that owner (`writer_embed_stale`) instead of failing
// `pglite_busy`, with the CLI's consent and budget. The owner side is tested
// against a real resident owner in test/embed-stale-resident.serial.test.ts.

describe('which embed forms the owner runs', () => {
  test('a stale drain, scoped, previewed or approved, is delegated', () => {
    for (const args of [
      ['--stale'],
      ['--stale', '--json'],
      ['--stale', '--dry-run', '--json'],
      ['--stale', '--source', 'notes', '--quiet'],
      ['--stale', '--yes'],
      ['--stale', '--max-usd', '2', '--json'],
      ['--stale', '--max-cost', '2'],
    ]) expect(staleEmbedDelegable(args)).toBe(true);
  });

  test('every other embed form keeps its own path', () => {
    for (const args of [
      ['--all'],
      ['some-slug'],
      ['--stale', '--facts', '--source', 'notes'],
      ['--stale', '--images'],
      ['--stale', '--held'],
      ['--stale', '--background'],
      ['--stale', '--catch-up'],
      ['--stale', '--include-null-signature'],
      ['--stale', '--batch-size', '10'],
      ['--stale', '--pace'],
      ['--stale', '--help'],
    ]) expect(staleEmbedDelegable(args)).toBe(false);
  });
});

describe('the CLI sends its own budget, always', () => {
  test('unset, the 30-minute default of the CLI\'s own run; set, its value', () => {
    expect(cliStaleBudgetMs({})).toBe(30 * 60 * 1000);
    expect(cliStaleBudgetMs({ GBRAIN_EMBED_TIME_BUDGET_MS: '' })).toBe(30 * 60 * 1000);
    expect(cliStaleBudgetMs({ GBRAIN_EMBED_TIME_BUDGET_MS: '60000' })).toBe(60_000);
    expect(staleEmbedOptionsFromArgs(['--stale'], {})).toEqual({ budgetMs: 30 * 60 * 1000 });
  });

  test('the options carry the source, the preview and the approval', () => {
    expect(staleEmbedOptionsFromArgs(['--stale', '--source', 'notes', '--dry-run'], { GBRAIN_EMBED_TIME_BUDGET_MS: '60000' }))
      .toEqual({ budgetMs: 60_000, sourceId: 'notes', dryRun: true });
    expect(staleEmbedOptionsFromArgs(['--stale', '--yes', '--max-usd', '1.5'], {})).toMatchObject({ yes: true, maxUsd: 1.5 });
    expect(staleEmbedOptionsFromArgs(['--stale', '--max-cost', '3'], {})).toMatchObject({ maxUsd: 3 });
    expect(staleEmbedOptionsFromArgs(['--stale', '--quiet'], {})).toMatchObject({ quiet: true });
    expect(refusalOf(() => staleEmbedOptionsFromArgs(['--stale', '--max-usd', 'lots'], {})).code).toBe('invalid_params');
    expect(refusalOf(() => staleEmbedOptionsFromArgs(['--stale'], { GBRAIN_EMBED_TIME_BUDGET_MS: 'soon' })).code).toBe('invalid_params');
  });

  test('the arguments the owner\'s consent and resume command read are the CLI\'s', () => {
    expect(staleEmbedArgs({ budgetMs: 60_000, sourceId: 'notes', yes: true, maxUsd: 2 }))
      .toEqual(['--stale', '--source', 'notes', '--yes', '--max-usd', '2']);
    expect(staleEmbedArgs({ budgetMs: 60_000, dryRun: true })).toEqual(['--stale', '--dry-run']);
  });
});

describe('the owner lane takes typed options only', () => {
  test('source, preview, approval and the CLI budget pass', () => {
    expect(validateStaleEmbedOptions({ sourceId: 'notes', dryRun: true, budgetMs: 60_000 }))
      .toEqual({ sourceId: 'notes', dryRun: true, budgetMs: 60_000 });
    expect(validateStaleEmbedOptions({ budgetMs: 60_000, yes: true, maxUsd: 0.5 }))
      .toEqual({ budgetMs: 60_000, yes: true, maxUsd: 0.5 });
  });

  test('anything else is refused with its own next step, and no value is echoed', () => {
    const unknown = refusalOf(() => validateStaleEmbedOptions({ budgetMs: 60_000, token: 'synthetic-credential-value' }));
    expect(unknown.code).toBe('invalid_params');
    expect(String(unknown.suggestion)).toContain('gbrain embed --stale');
    expect(JSON.stringify(unknown)).not.toContain('synthetic-credential-value');
    for (const budgetMs of [undefined, 0, 999, 1.5, '60000', -1]) {
      const env = refusalOf(() => validateStaleEmbedOptions({ budgetMs }));
      expect(env.code).toBe('invalid_params');
      expect(String(env.suggestion)).toContain('GBRAIN_EMBED_TIME_BUDGET_MS');
    }
    for (const bad of [{ dryRun: 'yes' }, { yes: 'true' }, { quiet: 1 }, { maxUsd: 0 }, { maxUsd: -1 }, { maxUsd: '1' }]) {
      expect(refusalOf(() => validateStaleEmbedOptions({ budgetMs: 60_000, ...bad })).code).toBe('invalid_params');
    }
  });
});

describe('the CLI\'s terminal prompt for a paid run the owner refused', () => {
  const refusal = {
    effects: ['paid'], actor: 'agent', why: 'Embedding sends page text to the provider.', risk: 'Spends money.',
    user_message: 'Generating the missing embeddings costs money (about $0.0001). OK to run it?', est_usd: 0.0001,
  } as unknown as ConfirmationPayload;
  const answer = (text: string) => async () => ({ kind: 'line' as const, text });

  test('a yes in the terminal sends the run again with --yes', async () => {
    expect(await promptForStaleEmbed(refusal, { budgetMs: 60_000 }, { interactive: true, readLine: answer('y') })).toBe(true);
  });

  test('a no, no terminal, or an approval already sent leaves the refusal standing', async () => {
    expect(await promptForStaleEmbed(refusal, { budgetMs: 60_000 }, { interactive: true, readLine: answer('n') })).toBe(false);
    expect(await promptForStaleEmbed(refusal, { budgetMs: 60_000 }, { interactive: false, readLine: answer('y') })).toBe(false);
    expect(await promptForStaleEmbed(refusal, { budgetMs: 60_000, yes: true }, { interactive: true, readLine: answer('y') })).toBe(false);
    expect(await promptForStaleEmbed(refusal, { budgetMs: 60_000, maxUsd: 1 }, { interactive: true, readLine: answer('y') })).toBe(false);
  });
});

describe('the operation is an extension older clients ignore', () => {
  test('writer_embed_stale is advertised as an extension, not in the frozen list', () => {
    expect(isPersistenceAdminExtension('writer_embed_stale')).toBe(true);
    expect((PERSISTENCE_ADMIN_OPERATIONS as readonly string[]).includes('writer_embed_stale')).toBe(false);
  });
});
