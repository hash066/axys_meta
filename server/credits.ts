import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.ts";

export type CreditEntry = {
  id: string;
  tenantId: string;
  units: number;
  reason: "starter" | "generation" | "video-reservation" | "refund" | "grant";
  reference: string;
  createdAt: string;
};

const costs = { Website: 1, Reels: 3, Both: 4 } as const;

export class Credits {
  constructor(private store: Store) {}

  seed(tenant: string) {
    const configured = process.env.AXYS_STARTER_CREDITS;
    const units =
      configured === undefined
        ? process.env.NODE_ENV === "production"
          ? 0
          : 20
        : z.coerce.number().int().min(0).max(10000).parse(configured);
    if (units) this.append(tenant, units, "starter", "workspace-starter");
    return this.summary(tenant);
  }

  cost(mode: keyof typeof costs) {
    return costs[mode];
  }

  summary(tenant: string) {
    const entries = this.store.list<CreditEntry>("credit-entry", tenant);
    const row = this.store.db
      .prepare(
        "SELECT COALESCE(SUM(CAST(json_extract(data,'$.units') AS INTEGER)),0) balance FROM records WHERE kind='credit-entry' AND tenant=?",
      )
      .get(tenant) as { balance: number };
    return {
      balance: row.balance,
      costs,
      entries: entries.slice(0, 20),
      unit: "Axys credit",
      paymentConfigured: false,
    };
  }

  charge(tenant: string, mode: keyof typeof costs, reference: string) {
    const units = this.cost(mode);
    return this.reserve(tenant, units, reference, "generation");
  }

  reserve(
    tenant: string,
    units: number,
    reference: string,
    reason: "generation" | "video-reservation" = "video-reservation",
  ) {
    return this.store.transaction(() => {
      return this.reserveInTransaction(tenant, units, reference, reason);
    });
  }

  reserveInTransaction(
    tenant: string,
    units: number,
    reference: string,
    reason: "generation" | "video-reservation" = "video-reservation",
  ) {
    if (!Number.isInteger(units) || units <= 0 || units > 10000)
      throw new Error("Credit reservation must be a positive bounded integer");
    const existing = this.store.get<CreditEntry>(
      "credit-entry",
      tenant,
      reference,
    );
    if (existing) return this.summary(tenant);
    const current = this.summary(tenant).balance;
    if (current < units)
      throw new Error(
        `This generation needs ${units} credits; ${current} remain.`,
      );
    this.append(tenant, -units, reason, reference);
    return this.summary(tenant);
  }

  refund(tenant: string, chargeReference: string) {
    return this.store.transaction(() => {
      return this.refundInTransaction(tenant, chargeReference);
    });
  }

  refundInTransaction(tenant: string, chargeReference: string) {
    const charge = this.store.get<CreditEntry>(
      "credit-entry",
      tenant,
      chargeReference,
    );
    if (!charge || !["generation", "video-reservation"].includes(charge.reason))
      return this.summary(tenant);
    this.append(tenant, -charge.units, "refund", `refund:${chargeReference}`);
    return this.summary(tenant);
  }

  private append(
    tenant: string,
    units: number,
    reason: CreditEntry["reason"],
    reference: string,
  ) {
    const id = reference;
    if (this.store.get("credit-entry", tenant, id)) return;
    this.store.put("credit-entry", tenant, id, {
      id: randomUUID(),
      tenantId: tenant,
      units,
      reason,
      reference,
      createdAt: new Date().toISOString(),
    } satisfies CreditEntry);
  }
}
