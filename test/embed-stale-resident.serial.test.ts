/**
 * `gbrain embed --stale` handed to a resident PGLite owner (writer_embed_stale)
 * keeps the CLI's contract: consent and the approved cap, the CLI's budget
 * (never the owner's process setting), and the keyless clean refusal.
 *
 * Serial: installs the process-global gateway transport seam, sets the
 * owner's GBRAIN_EMBED_TIME_BUDGET_MS and spawns the real CLI against an
 * in-process owner.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as embedModule from '../src/commands/embed.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { saveConfig } from '../src/core/config.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { startPersistenceIpcServer, requestPersistenceAdministration, persistenceSocketPathForConfig, type PersistenceIpcBinding } from '../src/core/persistence/ipc.ts';
import type { StaleEmbedOutcome } from '../src/core/persistence/embed-stale-administration.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const MODEL = 'openai:text-embedding-3-small';
const DIMS = 1536;
const SLUGS = ['notes/stale-alpha', 'notes/stale-beta', 'notes/stale-gamma'];
let root: string;
let engine: PGLiteEngine;
let binding: PersistenceIpcBinding;
let registration: LocalRegistration;
let brainId: string;
let calls: number;
const config = (extra: Record<string, unknown> = {}) => ({ engine: 'pglite' as const, database_path: join(root, 'db'), embedding_disabled: false, ...extra });
const inHome = <T>(run: () => Promise<T>, env: Record<string, string | undefined> = {}) => withEnv({
  GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined,
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_EMBED_TIME_BUDGET_MS: undefined, ...env,
}, run);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-stale-resident-'));
  await inHome(async () => {
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: {} });
    engine = new PGLiteEngine();
    await engine.connect({ database_path: config().database_path });
    await engine.initSchema();
  });
}, 60_000);

beforeEach(async () => inHome(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  saveConfig(config());
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test-key' } });
  await engine.setConfig('embedding_model', MODEL);
  await engine.setConfig('embedding_dimensions', String(DIMS));
  await engine.setConfig('embedding_disabled', 'false');
  for (const slug of SLUGS) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `${slug} body`, chunk_source: 'compiled_truth', token_count: 4 }]);
  }
  registration = await registerLocalWriter(engine, 'cli', undefined, true);
  const provider = await createPersistenceIpcProvider(engine, config());
  brainId = provider.brainId;
  binding = (await startPersistenceIpcServer(persistenceSocketPathForConfig(config())!, provider))!;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  calls = 0;
  __setEmbedTransportForTests(async ({ values }) => {
    calls++;
    return { values, usage: { tokens: values.length * 4 }, warnings: [], embeddings: values.map(() => Array(DIMS).fill(0.25)) };
  });
}), 60_000);

afterEach(async () => inHome(async () => {
  const closed = once(binding.server, 'close');
  binding.close();
  await closed;
  await disposePersistenceConsumer(engine);
  __setEmbedTransportForTests(null);
  resetGateway();
}));

afterAll(async () => {
  await inHome(() => engine.disconnect());
  rmSync(root, { recursive: true, force: true });
});

const request = (options: Record<string, unknown>) => requestPersistenceAdministration(binding.socketPath, {
  version: 1, kind: 'administration', brain_id: brainId, operation: 'writer_embed_stale',
  params: { options }, registration,
}) as Promise<StaleEmbedOutcome>;
const stale = () => engine.countStaleChunks({ sourceId: 'default' });
const cli = async (args: string[], env: Record<string, string | undefined> = {}) => {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_EMBED_TIME_BUDGET_MS: undefined, ...env })) {
    if (value !== undefined) childEnv[key] = value;
  }
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'embed', '--stale', ...args], {
    cwd: root, env: childEnv, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, status };
};

describe('consent and the approved cap travel with the drain', () => {
  test('a paid run without an approval is refused before any provider call', () => inHome(async () => {
    expect(await stale()).toBe(SLUGS.length);
    const outcome = await request({ budgetMs: 60_000 });
    expect(outcome.result).toBeUndefined();
    expect(outcome.refusal).toMatchObject({ code: 'confirmation_required', effects: ['paid'] });
    expect(outcome.refusal!.fix.argv).toEqual(['gbrain', 'embed', '--stale', '--yes']);
    expect(calls).toBe(0);
    expect(await stale()).toBe(SLUGS.length);
  }));

  test('a preview needs no approval and spends nothing', () => inHome(async () => {
    const outcome = await request({ budgetMs: 60_000, dryRun: true });
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.result).toMatchObject({ dryRun: true, would_embed: SLUGS.length, embedded: 0 });
    expect(calls).toBe(0);
  }));

  test('--yes runs under the derived cap and says so', () => inHome(async () => {
    const outcome = await request({ budgetMs: 60_000, yes: true });
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.result).toMatchObject({ embedded: SLUGS.length, failures: 0 });
    expect(outcome.lines.some(line => line.to === 'err' && line.text.includes('[consent] embed: cost cap $0.25'))).toBe(true);
    expect(await stale()).toBe(0);
  }));

  test('spend.posture=tokenmax authorizes it, as on the direct path', () => inHome(async () => {
    await engine.setConfig('spend.posture', 'tokenmax');
    const outcome = await request({ budgetMs: 60_000 });
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.result).toMatchObject({ embedded: SLUGS.length });
  }));

  test('the real CLI without a terminal exits 3 with the consent payload, and runs with --yes', () => inHome(async () => {
    const refused = await cli(['--json']);
    expect(refused.status).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'confirmation_required', effects: ['paid'] });
    expect(calls).toBe(0);
    const ran = await cli(['--yes', '--json']);
    expect({ status: ran.status, stderr: ran.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(ran.stdout)).toMatchObject({ embedded: SLUGS.length, failures: 0 });
    expect(await stale()).toBe(0);
  }), 60_000);
});

describe('the budget is the CLI\'s', () => {
  test('the owner runs with the budget it is sent, not its own process setting', () => inHome(async () => {
    const core = spyOn(embedModule, 'runEmbedCore');
    try {
      await request({ budgetMs: 45_000, dryRun: true });
      expect(core.mock.calls.at(-1)?.[1]).toMatchObject({ stale: true, timeBudgetMs: 45_000 });
    } finally { core.mockRestore(); }
  }, { GBRAIN_EMBED_TIME_BUDGET_MS: '5000' }));

  test('a CLI without GBRAIN_EMBED_TIME_BUDGET_MS sends its 30-minute default to an owner with a shorter one', () => inHome(async () => {
    const core = spyOn(embedModule, 'runEmbedCore');
    try {
      const run = await cli(['--dry-run', '--json']);
      expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 });
      expect(core.mock.calls.at(-1)?.[1]).toMatchObject({ timeBudgetMs: 30 * 60 * 1000 });
      const set = await cli(['--dry-run', '--json'], { GBRAIN_EMBED_TIME_BUDGET_MS: '120000' });
      expect(set.status).toBe(0);
      expect(core.mock.calls.at(-1)?.[1]).toMatchObject({ timeBudgetMs: 120_000 });
    } finally { core.mockRestore(); }
  }, { GBRAIN_EMBED_TIME_BUDGET_MS: '5000' }), 60_000);
});

describe('the chunkless-page heal takes the CLI\'s budget too', () => {
  const chunkless = async (n: number) => {
    // Seeded directly, as beforeEach seeds its pages: the writer coordinator is off while the fixture is written.
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (let i = 0; i < n; i++) {
      await engine.putPage(`notes/chunkless-${i}`, { type: 'note', title: `chunkless ${i}`, compiled_truth: `# chunkless ${i}\n\nA page stored without its chunks, number ${i}.` });
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect(await engine.countChunklessPagesWithContent()).toBe(n);
  };

  // Pages written without chunks wait for their text projection: a live run's
  // bounded projection recovery builds some, the heal sweep the rest, both
  // within the CLI's budget. The sweep alone: test/embed-stale-heal-budget.serial.test.ts.
  test('a live run chunks and embeds every chunkless page within the CLI\'s budget, though the owner\'s own is 1 ms', () => inHome(async () => {
    await chunkless(5);
    const outcome = await request({ budgetMs: 60_000, yes: true });
    expect(outcome.result).toMatchObject({ embedded: SLUGS.length + 5, failures: 0 });
    expect(outcome.result?.reason).toBeUndefined();
    expect(await engine.countChunklessPagesWithContent()).toBe(0);
    expect(await stale()).toBe(0);
  }, { GBRAIN_EMBED_TIME_BUDGET_MS: '1' }), 60_000);

  test('the CLI\'s short budget stops the heal of an owner with the 30-minute default, as a direct run stops it', () => inHome(async () => {
    // About 6 ms a page here: 1,000 pages outlast the CLI's 1 s budget several times over.
    const pages = 1_000;
    await chunkless(pages);
    const run = await cli(['--yes', '--json'], { GBRAIN_EMBED_TIME_BUDGET_MS: '1000' });
    // The heal's stop is upstream's: no failure and no budget verdict, a line naming the budget, the rest for the next run.
    expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 });
    expect(run.stderr).toContain('chunkless-page sweep hit its time budget (1000ms) with more pages left');
    const result = JSON.parse(run.stdout);
    expect(result.failures).toBe(0);
    expect(result.chunkless_pages_healed).toBeGreaterThan(0);
    expect(result.chunkless_pages_healed).toBeLessThan(pages);
    const left = await engine.countChunklessPagesWithContent();
    expect(left).toBeGreaterThan(0);
    // The next run continues, within its own budget.
    const next = await cli(['--yes', '--json'], { GBRAIN_EMBED_TIME_BUDGET_MS: '1000' });
    expect(next.status).toBe(0);
    expect(await engine.countChunklessPagesWithContent()).toBeLessThan(left);
  }), 120_000);
});

describe('the multimodal image sweep runs first, as on the direct path', () => {
  test('a multimodal owner reports the sweep in the result; a text-only one has none', () => inHome(async () => {
    const multimodal = await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, () => request({ budgetMs: 60_000, dryRun: true }));
    expect(multimodal.result?.images).toMatchObject({ candidates: 0, failures: 0 });
    const textOnly = await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, () => request({ budgetMs: 60_000, dryRun: true }));
    expect(textOnly.result?.images).toBeUndefined();
    expect(calls).toBe(0);
  }));
});

describe('the keyless clean refusal stays the CLI\'s', () => {
  test('a keyless brain answers the clean no-op with exit 0 and never reaches the owner', () => inHome(async () => {
    saveConfig(config({ embedding_disabled: true }));
    const core = spyOn(embedModule, 'runEmbedCore');
    try {
      const run = await cli(['--json']);
      expect(run.status).toBe(0);
      expect(run.stderr).toContain('Embeddings are disabled on this brain (keyless install)');
      expect(JSON.parse(run.stdout)).toMatchObject({ embedded: 0, failures: 0, dryRun: false });
      expect(core).not.toHaveBeenCalled();
      expect(calls).toBe(0);
    } finally { core.mockRestore(); }
  }), 60_000);
});
