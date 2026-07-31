// Covers src/core/human-out.ts — the rule that keeps stdout clean while the
// MCP stdio transport owns it.
//
// The defect this pins, measured 2026-08-01 on a fresh host: `sync` wrote its
// progress line `  1 chunks created` to stdout while running as an MCP tool,
// the client's parser hit
//   Invalid JSON: trailing characters ... input_value='  1 chunks created'
// and the turn hung until the caller timed out. The tool call had SUCCEEDED —
// page written, committed, pushed — so the failure looked like a frozen agent
// rather than a broken stream. A success nobody can read is the worst shape a
// bug can take.

import { describe, expect, test, afterEach } from 'bun:test';
import { humanOut, humanLog, stdoutIsProtocol, claimStdoutForProtocol } from '../src/core/human-out.ts';

const KEYS = ['MCP_STDIO', 'GBRAIN_STDOUT_IS_PROTOCOL'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('stdout is only for humans when no protocol owns it', () => {
  test('plain CLI run writes human output to stdout', () => {
    for (const key of KEYS) setEnv(key, undefined);
    expect(stdoutIsProtocol()).toBe(false);
    expect(humanOut()).toBe(process.stdout);
  });

  test('MCP_STDIO=1 moves human output to stderr', () => {
    for (const key of KEYS) setEnv(key, undefined);
    setEnv('MCP_STDIO', '1');
    expect(stdoutIsProtocol()).toBe(true);
    expect(humanOut()).toBe(process.stderr);
  });

  test('the explicit escape hatch works too, for hosts that set neither', () => {
    for (const key of KEYS) setEnv(key, undefined);
    setEnv('GBRAIN_STDOUT_IS_PROTOCOL', '1');
    expect(humanOut()).toBe(process.stderr);
  });

  test('a value that is not exactly "1" does NOT reserve stdout', () => {
    // The false path. Without it this is a boolean that cannot be false: any
    // stray env var would silently move all CLI output to stderr and every
    // shell pipeline reading gbrain would go quiet.
    for (const key of KEYS) setEnv(key, undefined);
    setEnv('MCP_STDIO', '0');
    expect(stdoutIsProtocol()).toBe(false);
    setEnv('MCP_STDIO', 'true');
    expect(stdoutIsProtocol()).toBe(false);
    expect(humanOut()).toBe(process.stdout);
  });

  test('a command in --json mode keeps stdout clean even outside MCP', () => {
    // The behaviour sync.ts already had before this module existed; folding it
    // in here is what lets call sites ask one question instead of two.
    for (const key of KEYS) setEnv(key, undefined);
    expect(humanOut(true)).toBe(process.stderr);
  });

  test('humanLog routes by env and adds exactly one newline', () => {
    // Child process again: humanLog goes through console.log/console.error on
    // purpose (see its comment — process.stdout.write is buffered and drops
    // the tail on a prompt exit), and Bun's console writes straight to the fd,
    // so an in-process stub would observe nothing.
    const script = `
      const { humanLog } = await import('${import.meta.dir}/../src/core/human-out.ts');
      humanLog('  1 chunks created');
    `;
    const plain = Bun.spawnSync(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    expect(plain.stdout.toString()).toBe('  1 chunks created\n');
    expect(plain.stderr.toString()).toBe('');

    const mcp = Bun.spawnSync(['bun', '-e', script], {
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, MCP_STDIO: '1' },
    });
    expect(mcp.stdout.toString()).toBe('');
    expect(mcp.stderr.toString()).toBe('  1 chunks created\n');
  });

  test('humanLog survives a prompt process exit — the tail is not lost', () => {
    // The regression that process.stdout.write introduced and that
    // test/sync-cost-gate caught: a buffered write plus an immediate exit
    // silently drops the summary line a caller was scraping for.
    const r = Bun.spawnSync(['bun', '-e', `
      const { humanLog } = await import('${import.meta.dir}/../src/core/human-out.ts');
      humanLog('  7 pages imported');
      process.exit(0);
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(r.stdout.toString()).toContain('7 pages imported');
  });
});

describe('claimStdoutForProtocol covers the call sites nobody converted', () => {
  // These run in a REAL child process with separate pipes, not with a stubbed
  // process.stdout.write. Bun's console.log writes straight to the file
  // descriptor and never goes through that function, so an in-process stub
  // sees an empty stdout no matter what the code does — the assertion passes
  // while proving nothing. Only a child process can answer the question that
  // matters here: did a byte land on fd 1?
  function run(body: string): { stdout: string; stderr: string; code: number } {
    const r = Bun.spawnSync(['bun', '-e', `
      const { claimStdoutForProtocol } = await import('${import.meta.dir}/../src/core/human-out.ts');
      ${body}
    `], { stdout: 'pipe', stderr: 'pipe' });
    return {
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
      code: r.exitCode ?? -1,
    };
  }

  test('the exact line that killed the live session no longer reaches stdout', () => {
    // import.ts:453 / sync.ts:5748 — verbatim, via plain console.log, i.e. one
    // of the ~2000 call sites that were never converted by hand.
    const r = run(`
      claimStdoutForProtocol();
      console.log('  1 chunks created');
    `);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('1 chunks created');
  });

  test('without the claim, that same line DOES reach stdout', () => {
    // The control. Without it the test above would still pass if
    // claimStdoutForProtocol were an empty function and console.log were
    // broken for some unrelated reason.
    const r = run(`console.log('  1 chunks created');`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('1 chunks created');
  });

  test('info and debug are swept too; error was already safe', () => {
    const r = run(`
      claimStdoutForProtocol();
      console.info('info line');
      console.debug('debug line');
      console.error('error line');
    `);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('info line');
    expect(r.stderr).toContain('debug line');
    expect(r.stderr).toContain('error line');
  });

  test('it flips stdoutIsProtocol, so humanOut call sites follow along', () => {
    for (const key of KEYS) setEnv(key, undefined);
    expect(stdoutIsProtocol()).toBe(false);
    const restore = claimStdoutForProtocol();
    try {
      expect(stdoutIsProtocol()).toBe(true);
      expect(humanOut()).toBe(process.stderr);
    } finally { restore(); }
  });

  test('restore hands the real console back — no leak into the rest of the run', () => {
    const r = run(`
      const restore = claimStdoutForProtocol();
      restore();
      console.log('back on stdout');
    `);
    expect(r.stdout).toContain('back on stdout');
  });

  test('claiming twice then restoring in EITHER order leaves stdout working', () => {
    // A second claim must not capture the already-patched console as its
    // "original", or restoring in any order but the exact reverse hands
    // console.log back as console.error and every later CLI line silently
    // disappears from stdout. Reverse order (second, first) would pass even on
    // a naive implementation — forward order is the one that catches it.
    for (const order of ['second(); first();', 'first(); second();']) {
      const r = run(`
        const first = claimStdoutForProtocol();
        const second = claimStdoutForProtocol();
        ${order}
        console.log('still on stdout');
      `);
      expect(r.stdout).toContain('still on stdout');
    }
  });
});
