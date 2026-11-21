import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `gbrain embeddings enable` on a brain made keyless records the model and
// width in the database plane too, as init does (#9451). Fact embedding
// compares the database's identity with the configured model, so a brain
// enabled later used to keep the new-install default there and refused every
// fact embedding ("Embedding configuration differs from the database").

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: home, GBRAIN_HOME: home },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

/** The database's own config value, read in a child with the brain closed. */
function dbConfig(home: string, key: string): string | null {
  const script = `
    const { loadConfigFileOnly, toEngineConfig } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'config.ts'))});
    const { createEngine } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'engine-factory.ts'))});
    const cfg = toEngineConfig(loadConfigFileOnly());
    const engine = await createEngine(cfg);
    await engine.connect(cfg);
    const value = await engine.getConfig(${JSON.stringify(key)});
    await engine.disconnect();
    process.stdout.write(JSON.stringify(value));
  `;
  const out = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, HOME: home, GBRAIN_HOME: home },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const line = out.stdout.trim().split('\n').at(-1) ?? 'null';
  return JSON.parse(line) as string | null;
}

describe('gbrain embeddings enable records the database plane', () => {
  test('a keyless brain enabled later carries the model and width in its database', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-enable-db-'));
    try {
      expect(run(home, ['init', '--pglite', '--no-embedding', '--non-interactive', '--json']).status).toBe(0);
      const enabled = run(home, ['embeddings', 'enable', '--embedding-model', 'llama-server:bge-m3', '--embedding-dimensions', '1024', '--json']);
      expect(enabled.status).toBe(0);
      expect(dbConfig(home, 'embedding_model')).toBe('llama-server:bge-m3');
      expect(dbConfig(home, 'embedding_dimensions')).toBe('1024');
      expect(dbConfig(home, 'embedding_disabled')).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
