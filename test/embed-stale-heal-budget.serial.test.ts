/**
 * The chunkless-page heal of `embed --stale` draws from the run's own
 * resolved budget: `timeBudgetMs` when the caller supplies one (a resident
 * owner running a CLI's drain, writer_embed_stale), else
 * GBRAIN_EMBED_TIME_BUDGET_MS. Before, the heal always read the process
 * setting, so an owner healed within its own window instead of the CLI's.
 *
 * Serial: sets GBRAIN_EMBED_TIME_BUDGET_MS and installs the process-global
 * gateway transport seam.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { runEmbedCore } from '../src/commands/embed.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withHumanLineSink } from '../src/core/console-prefix.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
let engine: PGLiteEngine;

async function chunkless(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await engine.putPage(`notes/chunkless-${i}`, { type: 'note', title: `chunkless ${i}`, compiled_truth: `# chunkless ${i}\n\nA page stored without its chunks, number ${i}.` });
  }
  expect(await engine.countChunklessPagesWithContent()).toBe(n);
}

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) => ({
    embeddings: input.values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: input.values.length * 4 },
  })) as never);
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: DIMS } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => { await resetPgliteState(engine); });

describe('the chunkless-page heal takes the supplied budget', () => {
  test('a process budget already spent does not stop the heal of a run given a longer one', () => withEnv({ GBRAIN_EMBED_TIME_BUDGET_MS: '1' }, async () => {
    await chunkless(5);
    const preview = await runEmbedCore(engine, { stale: true, quiet: true, dryRun: true, timeBudgetMs: 60_000 });
    expect(preview.chunkless_pages_healed).toBe(5);
    const run = await runEmbedCore(engine, { stale: true, quiet: true, timeBudgetMs: 60_000 });
    expect(run).toMatchObject({ chunkless_pages_healed: 5, embedded: 5, failures: 0 });
    expect(run.reason).toBeUndefined();
    expect(await engine.countChunklessPagesWithContent()).toBe(0);
  }), 60_000);

  test('a short supplied budget stops the heal of a process with the 30-minute default, and says which budget', () => withEnv({ GBRAIN_EMBED_TIME_BUDGET_MS: undefined }, async () => {
    // About 6 ms a page here: 1,000 pages outlast the 1 s budget several times over.
    const pages = 1_000;
    await chunkless(pages);
    const lines: string[] = [];
    const run = await withHumanLineSink(line => { lines.push(line); }, () => runEmbedCore(engine, { stale: true, timeBudgetMs: 1_000 }));
    expect(run.chunkless_pages_healed).toBeGreaterThan(0);
    expect(run.chunkless_pages_healed).toBeLessThan(pages);
    expect(run.failures).toBe(0);
    // The heal's own stop (upstream's semantics): what it healed is kept and embedded, the rest waits for the next run.
    expect(lines.some(line => line.includes('chunkless-page sweep hit its time budget (1000ms) with more pages left'))).toBe(true);
    expect(await engine.countChunklessPagesWithContent()).toBe(pages - run.chunkless_pages_healed!);
  }), 120_000);
});
