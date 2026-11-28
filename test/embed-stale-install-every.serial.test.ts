/**
 * Lazurio: `embed --stale` keeps the vectors a budget-stopped run computed.
 *
 * Protects: with GBRAIN_EMBED_STALE_INSTALL_EVERY (or `installEvery`), an
 * unmetered page installs every N chunks, so a slow model and a page bigger
 * than the run's budget still converge over several runs to no stale chunk,
 * each run installing some. Without the setting, the page installs once at
 * its end (upstream), and the same runs install nothing: the case that left
 * a Personal Environment at 0 of 385 after four 3-minute windows.
 * Also protects the owner lane: the CLI's setting travels in the typed
 * options (writer_embed_stale) and is validated there.
 *
 * Serial: installs the process-global gateway transport seam and sets env.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { runEmbedCore } from '../src/commands/embed.ts';
import { staleEmbedOptionsFromArgs } from '../src/commands/embed-stale-delegate.ts';
import { staleInstallEvery, staleInstallSlices } from '../src/core/embed-install-every.ts';
import { validateStaleEmbedOptions } from '../src/core/persistence/embed-stale-administration.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
/** The slow model: this long per input, so one page of CHUNKS takes CHUNKS * MS_PER_INPUT. */
const MS_PER_INPUT = 25;
const CHUNKS = 40;
/** A run's budget: well under the page (1,000 ms), well over a slice of 4 (100 ms). */
const BUDGET_MS = 400;
const SLUG = 'notes/large-page';
let engine: PGLiteEngine;
let inputs = 0;

function slowModel(input: { values: string[]; abortSignal?: AbortSignal }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inputs += input.values.length;
      resolve({ embeddings: input.values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: input.values.length * 4 } });
    }, input.values.length * MS_PER_INPUT);
    input.abortSignal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(input.abortSignal!.reason ?? new Error('aborted'));
    }, { once: true });
  });
}

async function largeStalePage(): Promise<void> {
  const texts = Array.from({ length: CHUNKS }, (_, i) => `Paragraph ${i} of a large synthetic page.`);
  await engine.putPage(SLUG, { type: 'note', title: 'large page', compiled_truth: texts.join('\n\n') });
  await installFixtureChunks(engine, SLUG, texts.map((chunk_text, chunk_index) => ({ chunk_index, chunk_text, chunk_source: 'compiled_truth' })));
  expect(await staleChunks()).toBe(CHUNKS);
}

async function staleChunks(): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1 AND c.embedding IS NULL', [SLUG]);
  return row.n;
}

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests(slowModel as never);
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: DIMS } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  inputs = 0;
  await resetPgliteState(engine);
});

describe('a page bigger than the budget, a slow model, several runs', () => {
  test('without an install interval, every run computes and installs nothing (upstream)', () => withEnv({ GBRAIN_EMBED_STALE_INSTALL_EVERY: undefined }, async () => {
    await largeStalePage();
    for (let run = 0; run < 3; run++) {
      const result = await runEmbedCore(engine, { stale: true, quiet: true, timeBudgetMs: BUDGET_MS });
      expect(result).toMatchObject({ embedded: 0, failures: 0, reason: 'time_budget' });
    }
    expect(await staleChunks()).toBe(CHUNKS);
  }), 60_000);

  test('installing every 4 chunks, each run installs some and the runs end with none left', () => withEnv({ GBRAIN_EMBED_STALE_INSTALL_EVERY: undefined }, async () => {
    await largeStalePage();
    const perRun: number[] = [];
    for (let run = 0; run < 12 && (await staleChunks()) > 0; run++) {
      const result = await runEmbedCore(engine, { stale: true, quiet: true, timeBudgetMs: BUDGET_MS, installEvery: 4 });
      expect(result.failures).toBe(0);
      perRun.push(result.embedded);
    }
    expect(await staleChunks()).toBe(0);
    expect(perRun.length).toBeGreaterThan(1); // the page really outlasted one run
    expect(perRun.every(n => n > 0)).toBe(true);
    expect(perRun.reduce((a, b) => a + b, 0)).toBe(CHUNKS);
  }), 60_000);

  test('the interval also comes from GBRAIN_EMBED_STALE_INSTALL_EVERY', () => withEnv({ GBRAIN_EMBED_STALE_INSTALL_EVERY: '4' }, async () => {
    await largeStalePage();
    const result = await runEmbedCore(engine, { stale: true, quiet: true, timeBudgetMs: BUDGET_MS });
    expect(result.embedded).toBeGreaterThan(0);
    expect(result.embedded % 4).toBe(0); // whole slices only: the one the budget stopped is dropped
    expect(await staleChunks()).toBe(CHUNKS - result.embedded);
  }), 60_000);

  test('with a budget the page fits in, slices install it whole in one run', () => withEnv({ GBRAIN_EMBED_STALE_INSTALL_EVERY: undefined }, async () => {
    await largeStalePage();
    const result = await runEmbedCore(engine, { stale: true, quiet: true, timeBudgetMs: 60_000, installEvery: 7 });
    expect(result).toMatchObject({ embedded: CHUNKS, failures: 0 });
    expect(result.reason).toBeUndefined();
    expect(inputs).toBe(CHUNKS);
    expect(await staleChunks()).toBe(0);
  }), 60_000);
});

describe('a synopsis page installed in slices over several runs', () => {
  const mode = async () => (await engine.executeRaw<{ contextual_retrieval_mode: string }>(
    'SELECT contextual_retrieval_mode FROM pages WHERE slug = $1', [SLUG]))[0]?.contextual_retrieval_mode;

  // A plain re-embed wraps a synopsis page's chunks with the title prefix;
  // once every chunk holds such a vector the page's stamped mode must say so
  // (embed-stale.test.ts, the one-run case), also where a budget stopped
  // the page in the middle and a later run finished it.
  test('the run that finishes the page demotes it to the title tier', () => withEnv({ GBRAIN_EMBED_STALE_INSTALL_EVERY: undefined }, async () => {
    await largeStalePage();
    await engine.updatePageContextualRetrievalState(SLUG, 'default', 'per_chunk_synopsis', 'gen-synopsis');
    let runs = 0;
    while ((await staleChunks()) > 0 && runs < 12) {
      const result = await runEmbedCore(engine, { stale: true, quiet: true, timeBudgetMs: BUDGET_MS, installEvery: 4 });
      expect(result.failures).toBe(0);
      runs++;
      if ((await staleChunks()) > 0) expect(await mode()).toBe('per_chunk_synopsis');
    }
    expect(runs).toBeGreaterThan(1);
    expect(await staleChunks()).toBe(0);
    expect(await mode()).toBe('title');
  }), 60_000);

  test('a chunk that keeps a synopsis-tier vector keeps the page in that mode', () => withEnv({ GBRAIN_EMBED_STALE_INSTALL_EVERY: undefined }, async () => {
    await largeStalePage();
    await engine.updatePageContextualRetrievalState(SLUG, 'default', 'per_chunk_synopsis', 'gen-synopsis');
    // One chunk already embedded from its synopsis input: not stale, another provenance.
    const [first] = await engine.executeRaw<{ id: number }>(
      'SELECT c.id FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1 ORDER BY c.chunk_index LIMIT 1', [SLUG]);
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = $2::vector, embedded_at = now(), embedding_input_hash = 'synopsis-input', model = $3 WHERE id = $1`,
      [first!.id, `[${new Array(DIMS).fill(0.002).join(',')}]`, 'openai:text-embedding-3-small']);
    expect(await staleChunks()).toBe(CHUNKS - 1);
    for (let run = 0; run < 12 && (await staleChunks()) > 0; run++) {
      await runEmbedCore(engine, { stale: true, quiet: true, timeBudgetMs: BUDGET_MS, installEvery: 4 });
    }
    expect(await staleChunks()).toBe(0);
    expect(await mode()).toBe('per_chunk_synopsis');
  }), 60_000);
});

describe('the setting', () => {
  test('reads a whole number of chunks, else none', () => {
    expect(staleInstallEvery({ GBRAIN_EMBED_STALE_INSTALL_EVERY: '4' })).toBe(4);
    expect(staleInstallEvery({ GBRAIN_EMBED_STALE_INSTALL_EVERY: ' 12 ' })).toBe(12);
    for (const raw of [undefined, '', '0', '-3', '2.5', 'four', '1000000']) {
      expect(staleInstallEvery({ GBRAIN_EMBED_STALE_INSTALL_EVERY: raw })).toBeNull();
    }
  });

  test('slices keep order and cover every chunk once', () => {
    expect(staleInstallSlices([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(staleInstallSlices([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
    expect(staleInstallSlices([1, 2, 3], null)).toEqual([[1, 2, 3]]);
  });

  test('the CLI hands its setting to the owner, which validates it', () => {
    expect(staleEmbedOptionsFromArgs(['--stale', '--json'], { GBRAIN_EMBED_TIME_BUDGET_MS: '180000', GBRAIN_EMBED_STALE_INSTALL_EVERY: '4' }))
      .toEqual({ budgetMs: 180_000, installEvery: 4 });
    expect(staleEmbedOptionsFromArgs(['--stale'], { GBRAIN_EMBED_TIME_BUDGET_MS: '180000' })).toEqual({ budgetMs: 180_000 });
    expect(validateStaleEmbedOptions({ budgetMs: 1_000, installEvery: 4 })).toEqual({ budgetMs: 1_000, installEvery: 4 });
    for (const installEvery of [0, -1, 2.5, '4', 1_000_000]) {
      expect(() => validateStaleEmbedOptions({ budgetMs: 1_000, installEvery })).toThrow(/installEvery must be a whole number of chunks/);
    }
  });
});
