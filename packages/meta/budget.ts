import type { Store } from "../../server/store.ts";

/**
 * Simple per-campaign cap on Muse model calls (planner, preflight, SAM,
 * Muse Image). Replaces the Nebius dollar-spend plumbing. Calls are counted
 * before they are made so a failing provider cannot be retried without bound.
 */
export function callCap() {
  const n = Number(process.env.MUSE_CAMPAIGN_CALL_CAP);
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : 60;
}
type Counter = { count: number; byKind: Record<string, number> };
export function callsUsed(store: Store, tenant: string, campaign: string) {
  return store.get<Counter>("muse-calls", tenant, campaign)?.count ?? 0;
}
export function consumeCall(
  store: Store,
  tenant: string,
  campaign: string,
  kind: string,
  n = 1,
) {
  const current = store.get<Counter>("muse-calls", tenant, campaign) || {
    count: 0,
    byKind: {},
  };
  if (current.count + n > callCap())
    throw new Error(
      `Muse call limit reached for this campaign (${callCap()}). Create a new campaign to continue.`,
    );
  current.count += n;
  current.byKind[kind] = (current.byKind[kind] || 0) + n;
  store.put("muse-calls", tenant, campaign, current);
}
