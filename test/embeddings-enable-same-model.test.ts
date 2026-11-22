import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A brain enabled before `embeddings enable` recorded the database plane: the
// config file names the model, the database keeps the new-install default, and
// the pages already have vectors written by that model (each chunk stamped with
// it), the facts none yet. That is a personal brain switched on by an earlier
// release (Lazurio's pin before v0.60.733.0-lazurio.3). Enabling it again with
// the same model refused (`embedding_model_mismatch`), so its facts could
// never be embedded. Now the stamps decide: every vector of this model passes
// and the plane is recorded; another model's or a mixed brain still refuses,
// and nothing is written.

const root = join(import.meta.dir, '..');
const cli = join(root, 'src', 'cli.ts');
const MODEL = 'llama-server:bge-m3';
const OTHER = 'openai:text-embedding-3-small';

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SWEEP: '0' },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

/** Runs `body` against the brain in a child with the CLI's engine, the brain closed around it; its last stdout line is JSON. */
function inBrain<T>(home: string, body: string): T {
  const script = `
    const { loadConfigFileOnly, toEngineConfig } = await import(${JSON.stringify(join(root, 'src', 'core', 'config.ts'))});
    const { createEngine } = await import(${JSON.stringify(join(root, 'src', 'core', 'engine-factory.ts'))});
    const cfg = toEngineConfig(loadConfigFileOnly());
    const engine = await createEngine(cfg);
    await engine.connect(cfg);
    const out = await (async () => { ${body} })();
    await engine.disconnect();
    process.stdout.write('\\n' + JSON.stringify(out ?? null));
  `;
  const out = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SWEEP: '0' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (out.status !== 0) throw new Error(`child failed: ${out.stderr}`);
  return JSON.parse(out.stdout.trim().split('\n').at(-1) ?? 'null') as T;
}

/**
 * A keyless brain as the earlier release left it after `embeddings enable`:
 * the file plane names MODEL at 1024, the database keeps its default; pages
 * whose chunks carry vectors stamped as `stamps` say, one fact without a
 * vector, and a cached query vector.
 */
function earlierBrain(stamps: string[], factVectorStamp?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-enable-same-'));
  expect(run(home, ['init', '--pglite', '--no-embedding', '--non-interactive', '--json']).status).toBe(0);
  const configPath = join(home, '.gbrain', 'config.json');
  const file = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  file.embedding_model = MODEL;
  file.embedding_dimensions = 1024;
  delete file.embedding_disabled;
  writeFileSync(configPath, JSON.stringify(file, null, 2));
  inBrain(home, `
    // Seeded directly, as the resident tests seed: the writer coordinator is off while the fixture is written.
    const managed = (await engine.executeRaw('SELECT enabled FROM persistence_brain WHERE singleton = 1'))[0]?.enabled === true;
    await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
    const vector = '[' + Array(1024).fill(0.01).join(',') + ']';
    const stamps = ${JSON.stringify(stamps)};
    for (let i = 0; i < stamps.length; i++) {
      const slug = 'notes/garden-' + i;
      await engine.putPage(slug, { type: 'note', title: 'garden ' + i, compiled_truth: '# garden ' + i });
      await engine.executeRaw(
        "INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, embedding, model) SELECT id, 0, $2, 'compiled_truth', $3::vector, $4 FROM pages WHERE slug = $1",
        [slug, 'garden ' + i + ' body', vector, stamps[i]]);
    }
    await engine.insertFact({ fact: 'The garden has a pear tree.', source: 'notes', visibility: 'private', kind: 'fact', confidence: 1 }, { source_id: 'default' });
    ${factVectorStamp === undefined ? '' : `await engine.executeRaw("UPDATE facts SET embedding = $1::vector, embedding_model = $2", [vector, ${JSON.stringify(factVectorStamp)}]);`}
    await engine.executeRaw("INSERT INTO query_cache (id, query_text, source_id, embedding) VALUES ('q1', 'pear', 'default', $1::vector)", [vector]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled = $1 WHERE singleton = 1', [managed]);
  `);
  return home;
}

type Snapshot = { model: string | null; chunks: number; facts: number; cached: number; file: string };
function snapshot(home: string): Snapshot {
  const db = inBrain<Omit<Snapshot, 'file'>>(home, `
    const count = async (sql) => Number((await engine.executeRaw(sql))[0].n);
    return {
      model: await engine.getConfig('embedding_model'),
      chunks: await count('SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL'),
      facts: await count('SELECT count(*)::int AS n FROM facts WHERE embedding IS NOT NULL'),
      cached: await count('SELECT count(*)::int AS n FROM query_cache WHERE embedding IS NOT NULL'),
    };
  `);
  return { ...db, file: readFileSync(join(home, '.gbrain', 'config.json'), 'utf8') };
}

const enable = (home: string) => run(home, ['embeddings', 'enable', '--embedding-model', MODEL, '--embedding-dimensions', '1024', '--json']);
const codeOf = (out: { stdout: string; stderr: string }) => /"code":\s*"([a-z_]+)"/.exec(out.stdout + out.stderr)?.[1];

describe('embeddings enable on a brain an earlier release enabled with the same model', () => {
  test('every vector stamped with the model: enabled, the database plane recorded, the vectors kept, the facts queued', () => {
    const home = earlierBrain([MODEL, MODEL]);
    try {
      const before = snapshot(home);
      expect(before).toMatchObject({ chunks: 2, facts: 0, cached: 1 });
      expect(before.model).not.toBe(MODEL);
      const enabled = enable(home);
      expect({ status: enabled.status, stderr: enabled.stderr }).toMatchObject({ status: 0 });
      expect(JSON.parse(enabled.stdout.slice(enabled.stdout.indexOf('{')))).toMatchObject({ status: 'enabled', embedding_model: MODEL, queued_facts: 1 });
      // The plane now names the model, so fact embedding no longer refuses; the page vectors stay; the
      // unstamped cache is dropped (it refills on the next query).
      expect(snapshot(home)).toMatchObject({ model: MODEL, chunks: 2, facts: 0, cached: 0 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);

  for (const [name, stamps, factStamp] of [
    ['another model\'s vectors', [OTHER, OTHER], undefined],
    ['vectors of two models', [MODEL, OTHER], undefined],
    ['a fact vector of another model', [MODEL], OTHER],
  ] as const) {
    test(`${name}: refused, and nothing is written`, () => {
      const home = earlierBrain([...stamps], factStamp);
      try {
        const before = snapshot(home);
        const refused = enable(home);
        expect(refused.status).not.toBe(0);
        expect(codeOf(refused)).toBe('embedding_model_mismatch');
        expect(snapshot(home)).toEqual(before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
