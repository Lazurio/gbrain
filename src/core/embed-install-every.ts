/**
 * Lazurio: how often `embed --stale` installs the vectors of one page.
 *
 * Upstream installs a page's vectors once, after the whole page is computed.
 * A wall-clock budget that stops the drain mid-page drops every vector that
 * page computed, and the next run starts the same page from its first chunk.
 * With a slow local model and a page bigger than the budget, no run ever
 * installs a vector. `GBRAIN_EMBED_STALE_INSTALL_EVERY` (or
 * `EmbedOpts.installEvery`) installs an unmetered page every N chunks instead,
 * so each run keeps what it finished and the next goes on from there.
 */

/**
 * The install interval from `GBRAIN_EMBED_STALE_INSTALL_EVERY`: a whole number
 * of chunks, at least 1. Null (unset or not such a number): one install per page.
 */
export function staleInstallEvery(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.GBRAIN_EMBED_STALE_INSTALL_EVERY?.trim();
  if (raw === undefined || !/^[1-9][0-9]{0,5}$/.test(raw)) return null;
  return Number(raw);
}

/** A page's pending chunks in install order: slices of `every`, or the whole page in one when `every` is null. */
export function staleInstallSlices<T>(pending: readonly T[], every: number | null): T[][] {
  if (every === null || pending.length <= every) return [[...pending]];
  const slices: T[][] = [];
  for (let at = 0; at < pending.length; at += every) slices.push(pending.slice(at, at + every));
  return slices;
}
