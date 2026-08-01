/**
 * Where output meant for a CLI caller is allowed to go.
 *
 * The distinction this module draws is about **who is reading**, not about how
 * human the text is. A CLI caller reads stdout; an MCP client does not — it
 * reads tool responses, and stdout is its transport. So everything a command
 * says to a CLI caller, prose and `--json` result alike, belongs here.
 *
 * WHY THIS EXISTS. Under `gbrain serve` (stdio MCP) **stdout carries the
 * JSON-RPC protocol**. Any human-readable line written there is spliced into
 * the framing and the client's parser dies — measured 2026-08-01 on a fresh
 * host, where the host agent asked its brain to record one fact:
 *
 *   ValidationError: 1 validation error for JSONRPCMessage
 *   Invalid JSON: trailing characters at line 1 column 5
 *   [type=json_invalid, input_value='  1 chunks created', input_type=str]
 *
 * `  1 chunks created` is `sync`'s own progress line. The tool call had in fact
 * SUCCEEDED — the page was written, committed and pushed — but the client saw a
 * broken stream, the turn hung until the caller's timeout, and from the outside
 * the whole agent looked frozen. That is the expensive shape of this bug: not a
 * failure, a success nobody can read.
 *
 * The codebase already had the right instinct for `--json` (see `cliSink` in
 * commands/sync.ts): when stdout belongs to a machine, chatter goes to stderr.
 * This module generalises that single rule so every command can ask the same
 * question, and so the MCP case is covered by construction rather than by each
 * caller remembering.
 *
 * stderr is never part of the protocol: the MCP server already writes its own
 * lifecycle messages there (`[gbrain-serve] shutdown: …`), and hosts surface it
 * as server logs.
 */

/** True when stdout is reserved for a machine protocol and must stay clean. */
export function stdoutIsProtocol(): boolean {
  return process.env.MCP_STDIO === '1' || process.env.GBRAIN_STDOUT_IS_PROTOCOL === '1';
}

/**
 * The stream a CLI caller's output may use right now.
 *
 * `machineOutput` is the caller's own `--json` mode: it keeps prose off stdout
 * so the JSON envelope pipes cleanly through `jq`. Pass it in rather than
 * writing `jsonOut || stdoutIsProtocol() ? process.stderr : cliOut()` at each
 * site — one question, asked one way.
 */
export function cliOut(machineOutput = false): NodeJS.WriteStream {
  return machineOutput || stdoutIsProtocol() ? process.stderr : process.stdout;
}

/** Convenience for the very common `console.log`-shaped call site. */
export function cliLog(line: string, machineOutput = false): void {
  // Deliberately console.*, NOT cliOut().write(). Measured while porting
  // import.ts: `process.stdout.write` is buffered, so a command that exits
  // promptly after its summary loses the tail — test/sync-cost-gate caught the
  // `N pages imported` line disappearing. console.log/console.error keep the
  // flush-on-exit behaviour every existing call site was written against, so
  // this stays a pure change of destination and not of delivery.
  if (machineOutput || stdoutIsProtocol()) console.error(line);
  else console.log(line);
}

/**
 * Hand stdout over to the protocol for the rest of the process.
 *
 * WHY A BLANKET REDIRECT AND NOT 2081 EDITS. `cliOut` above only helps at
 * call sites that ask it. `src/` holds ~2000 `console.log` calls, most of them
 * in command paths the MCP tools reach through, and any single one of them is
 * enough to kill a session — this bug reached a live host through exactly one.
 * Converting them individually is neither finishable nor stable: the 2001st,
 * written next month by someone who never heard of this file, breaks it again.
 * So the invariant is enforced once, here, at the moment stdout changes owner.
 *
 * WHAT THIS DOES NOT COVER. Direct `process.stdout.write` calls still land on
 * the protocol stream. They cannot be swept the same way: the MCP SDK's
 * StdioServerTransport writes the protocol through that very function, so
 * patching it would redirect the protocol itself. Those call sites must use
 * `cliOut()` — which is why `sync.ts`'s `cliSink` does.
 *
 * Idempotent, and returns a restore function so tests can call it without
 * leaking a patched console into the rest of the run.
 */
let claimed: (() => void) | null = null;

export function claimStdoutForProtocol(): () => void {
  // Genuinely idempotent: a second claim must NOT snapshot the already-patched
  // console as its "original", or restoring in any order but the exact reverse
  // hands `console.log` back as `console.error` and every later CLI line
  // vanishes from stdout — silently, which is how this class of bug hides.
  if (claimed) return claimed;

  process.env.GBRAIN_STDOUT_IS_PROTOCOL = '1';

  const saved = { log: console.log, info: console.info, debug: console.debug };
  // console.error already writes to stderr, which is not part of the protocol
  // and which MCP hosts surface as server logs.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  claimed = () => {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
    delete process.env.GBRAIN_STDOUT_IS_PROTOCOL;
    claimed = null;
  };
  return claimed;
}
