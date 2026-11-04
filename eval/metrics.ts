/** Metric helpers for the preflight mutation eval (pure, unit tested). */
export type Rate = {
  k: number;
  n: number;
  rate: number | null;
  ci95: [number, number] | null;
};

/**
 * Wilson score interval for a binomial proportion (default 95%, z=1.96).
 * Unlike the normal approximation it behaves at k=0, k=n and small n.
 * Returns null for n=0 (no data is not 0%).
 */
export function wilson(
  k: number,
  n: number,
  z = 1.959964,
): [number, number] | null {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0 || k > n)
    throw new RangeError(`Invalid counts k=${k} n=${n}`);
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lo = Math.max(0, centre - half),
    hi = Math.min(1, centre + half);
  // Exact endpoints: lower bound is 0 when k=0, upper is 1 when k=n.
  return [k === 0 ? 0 : lo, k === n ? 1 : hi];
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;
export function rate(k: number, n: number): Rate {
  const ci = wilson(k, n);
  return {
    k,
    n,
    rate: n === 0 ? null : round(k / n),
    ci95: ci ? [round(ci[0]), round(ci[1])] : null,
  };
}

/** Count booleans into a Rate (true = success/positive). */
export const rateOf = (flags: boolean[]) =>
  rate(flags.filter(Boolean).length, flags.length);

/** Group items by a key and compute a Rate per group. */
export function groupRates<T>(
  items: T[],
  key: (t: T) => string,
  flag: (t: T) => boolean,
): Record<string, Rate> {
  const groups = new Map<string, boolean[]>();
  for (const it of items) {
    const k = key(it);
    groups.set(k, [...(groups.get(k) ?? []), flag(it)]);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, rateOf(v)]),
  );
}

export const pct = (r: Rate) =>
  r.rate === null || !r.ci95
    ? "n/a (no cases)"
    : `${(r.rate * 100).toFixed(1)}% (${r.k}/${r.n}), 95% CI ${(r.ci95[0] * 100).toFixed(1)}–${(r.ci95[1] * 100).toFixed(1)}%`;
