import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import type { Store } from "./store.ts";

export const LeadStatus = z.enum([
  "New",
  "Replied",
  "Qualified",
  "Ordered",
  "Fulfilled",
  "NotInterested",
  "Spam",
  "DoNotContact",
]);
export type LeadStatusValue = z.infer<typeof LeadStatus>;

const IdempotencyKey = z.string().min(1).max(200);
const CampaignId = z.string().uuid();
const Currency = z.enum(["INR", "USD", "EUR", "GBP"]);

const CreateLeadInput = z
  .object({
    idempotencyKey: IdempotencyKey,
    campaignId: CampaignId.optional(),
    source: z.enum(["merchant", "whatsapp"]),
    customerLabel: z.string().max(100).optional(),
    consent: z.boolean(),
  })
  .strict();

const StatusInput = z
  .object({
    idempotencyKey: IdempotencyKey,
    status: LeadStatus,
    note: z.string().max(1000).optional(),
  })
  .strict();

const OrderInput = z
  .object({
    idempotencyKey: IdempotencyKey,
    amountMinor: z.number().int().nonnegative().optional(),
    currency: Currency.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.amountMinor !== undefined && value.currency === undefined)
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Currency is required when an amount is recorded",
      });
  });

export type Lead = {
  id: string;
  tenantId: string;
  campaignId?: string;
  source: "merchant" | "whatsapp";
  customerLabel?: string;
  consent: boolean;
  status: LeadStatusValue;
  createdAt: string;
  updatedAt: string;
};

export type LeadEvent = {
  id: string;
  leadId: string;
  type: "Created" | "StatusChanged" | "OrderCreated";
  at: string;
  from?: LeadStatusValue;
  to?: LeadStatusValue;
  note?: string;
  orderId?: string;
};

export type Order = {
  id: string;
  tenantId: string;
  leadId: string;
  campaignId?: string;
  amountMinor?: number;
  currency?: z.infer<typeof Currency>;
  createdAt: string;
};

const transitions: Record<LeadStatusValue, readonly LeadStatusValue[]> = {
  New: ["Replied", "NotInterested", "Spam", "DoNotContact"],
  Replied: ["Qualified", "NotInterested", "Spam", "DoNotContact"],
  Qualified: ["Ordered", "NotInterested", "DoNotContact"],
  Ordered: ["Fulfilled", "DoNotContact"],
  Fulfilled: ["DoNotContact"],
  NotInterested: [],
  Spam: [],
  DoNotContact: [],
};

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertTenant(tenant: string) {
  return z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .parse(tenant);
}

function assertCampaign(store: Store, tenant: string, campaignId?: string) {
  if (campaignId && !store.get("campaign", tenant, campaignId))
    throw new Error("Campaign not found in this workspace");
}

function event(store: Store, tenant: string, value: Omit<LeadEvent, "id">) {
  const row: LeadEvent = { ...value, id: randomUUID() };
  store.put("crm-lead-event", tenant, row.id, row);
  return row;
}

type SavedMutation<T> = {
  operation: string;
  requestHash: string;
  result: T;
};

function mutate<T>(
  store: Store,
  tenant: string,
  operation: string,
  idempotencyKey: string,
  request: unknown,
  apply: () => T,
) {
  const key = digest(idempotencyKey);
  const requestHash = digest(request);
  return store.transaction(() => {
    const previous = store.get<SavedMutation<T>>(
      "crm-idempotency",
      tenant,
      key,
    );
    if (previous) {
      if (
        previous.operation !== operation ||
        previous.requestHash !== requestHash
      )
        throw new Error(
          "Idempotency key was already used for a different mutation",
        );
      return previous.result;
    }
    const result = apply();
    store.put("crm-idempotency", tenant, key, {
      operation,
      requestHash,
      result,
    } satisfies SavedMutation<T>);
    return result;
  });
}

export function listLeads(store: Store, tenantInput: string) {
  const tenant = assertTenant(tenantInput);
  return store.list<Lead>("crm-lead", tenant);
}

export function createLead(store: Store, tenantInput: string, input: unknown) {
  const tenant = assertTenant(tenantInput);
  const parsed = CreateLeadInput.parse(input);
  assertCampaign(store, tenant, parsed.campaignId);
  return mutate(
    store,
    tenant,
    "lead.create",
    parsed.idempotencyKey,
    parsed,
    () => {
      const now = new Date().toISOString();
      const label = parsed.customerLabel?.trim();
      const lead: Lead = {
        id: randomUUID(),
        tenantId: tenant,
        ...(parsed.campaignId ? { campaignId: parsed.campaignId } : {}),
        source: parsed.source,
        ...(label ? { customerLabel: label } : {}),
        consent: parsed.consent,
        status: "New",
        createdAt: now,
        updatedAt: now,
      };
      store.put("crm-lead", tenant, lead.id, lead);
      event(store, tenant, {
        leadId: lead.id,
        type: "Created",
        at: now,
        to: "New",
      });
      return lead;
    },
  );
}

export function updateLeadStatus(
  store: Store,
  tenantInput: string,
  leadIdInput: string,
  input: unknown,
) {
  const tenant = assertTenant(tenantInput);
  const leadId = z.string().uuid().parse(leadIdInput);
  const parsed = StatusInput.parse(input);
  return mutate(
    store,
    tenant,
    "lead.status:" + leadId,
    parsed.idempotencyKey,
    parsed,
    () => {
      const lead = store.get<Lead>("crm-lead", tenant, leadId);
      if (!lead) throw new Error("Lead not found");
      if (lead.status === "DoNotContact")
        throw new Error("Do Not Contact is terminal");
      if (!transitions[lead.status].includes(parsed.status))
        throw new Error(
          "Lead cannot move from " + lead.status + " to " + parsed.status,
        );
      const now = new Date().toISOString();
      const updated: Lead = {
        ...lead,
        status: parsed.status,
        updatedAt: now,
      };
      store.put("crm-lead", tenant, lead.id, updated);
      event(store, tenant, {
        leadId: lead.id,
        type: "StatusChanged",
        at: now,
        from: lead.status,
        to: parsed.status,
        ...(parsed.note?.trim() ? { note: parsed.note.trim() } : {}),
      });
      return updated;
    },
  );
}

export function createOrder(
  store: Store,
  tenantInput: string,
  leadIdInput: string,
  input: unknown,
) {
  const tenant = assertTenant(tenantInput);
  const leadId = z.string().uuid().parse(leadIdInput);
  const parsed = OrderInput.parse(input);
  return mutate(
    store,
    tenant,
    "lead.order:" + leadId,
    parsed.idempotencyKey,
    parsed,
    () => {
      const lead = store.get<Lead>("crm-lead", tenant, leadId);
      if (!lead) throw new Error("Lead not found");
      if (lead.status === "DoNotContact")
        throw new Error("Do Not Contact is terminal");
      if (lead.status !== "Qualified" && lead.status !== "Ordered")
        throw new Error("Qualify the lead before recording an order");
      const now = new Date().toISOString();
      const order: Order = {
        id: randomUUID(),
        tenantId: tenant,
        leadId: lead.id,
        ...(lead.campaignId ? { campaignId: lead.campaignId } : {}),
        ...(parsed.amountMinor === undefined
          ? {}
          : { amountMinor: parsed.amountMinor }),
        ...(parsed.currency ? { currency: parsed.currency } : {}),
        createdAt: now,
      };
      const updated: Lead =
        lead.status === "Qualified"
          ? { ...lead, status: "Ordered", updatedAt: now }
          : lead;
      store.put("crm-order", tenant, order.id, order);
      if (updated !== lead) {
        store.put("crm-lead", tenant, lead.id, updated);
        event(store, tenant, {
          leadId: lead.id,
          type: "StatusChanged",
          at: now,
          from: "Qualified",
          to: "Ordered",
        });
      }
      event(store, tenant, {
        leadId: lead.id,
        type: "OrderCreated",
        at: now,
        orderId: order.id,
      });
      return { lead: updated, order };
    },
  );
}

export function crmSummary(
  store: Store,
  tenantInput: string,
  campaignIdInput?: unknown,
) {
  const tenant = assertTenant(tenantInput);
  const campaignId =
    campaignIdInput === undefined
      ? undefined
      : CampaignId.parse(campaignIdInput);
  assertCampaign(store, tenant, campaignId);
  const campaignClause = campaignId
    ? " AND json_extract(data,'$.campaignId')=?"
    : "";
  const recordCount = (kind: string, extra = "") =>
    Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM records WHERE kind=? AND tenant=?" +
              campaignClause +
              extra,
          )
          .get(kind, tenant, ...(campaignId ? [campaignId] : [])) as {
          n: number;
        }
      ).n,
    );
  const eventCount = (kind: "visit" | "contact") => {
    if (campaignId)
      return Number(
        (
          store.db
            .prepare("SELECT COUNT(*) AS n FROM events WHERE site=? AND kind=?")
            .get(campaignId, kind) as { n: number }
        ).n,
      );
    return Number(
      (
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE kind=? AND site IN (SELECT id FROM records WHERE kind='campaign' AND tenant=?)",
          )
          .get(kind, tenant) as { n: number }
      ).n,
    );
  };
  const orders = (
    store.db
      .prepare(
        "SELECT data FROM records WHERE kind='crm-order' AND tenant=?" +
          campaignClause,
      )
      .all(tenant, ...(campaignId ? [campaignId] : [])) as { data: string }[]
  ).map((row) => JSON.parse(row.data) as Order);
  const revenueMinorByCurrency: Record<string, number> = {};
  for (const order of orders)
    if (order.amountMinor !== undefined && order.currency)
      revenueMinorByCurrency[order.currency] =
        (revenueMinorByCurrency[order.currency] || 0) + order.amountMinor;
  return {
    visits: eventCount("visit"),
    contactActions: eventCount("contact"),
    leads: recordCount("crm-lead"),
    ordered: orders.length,
    fulfilled: recordCount(
      "crm-lead",
      " AND json_extract(data,'$.status')='Fulfilled'",
    ),
    revenueMinorByCurrency,
  };
}

export function installCrmRoutes(app: Express, store: Store) {
  app.get("/api/v1/crm/leads", (_req, res) => {
    res.json({ data: listLeads(store, res.locals.tenant) });
  });
  app.post("/api/v1/crm/leads", (req, res) => {
    res.status(201).json({
      data: createLead(store, res.locals.tenant, req.body),
    });
  });
  app.post("/api/v1/crm/leads/:id/status", (req, res) => {
    res.json({
      data: updateLeadStatus(store, res.locals.tenant, req.params.id, req.body),
    });
  });
  app.post("/api/v1/crm/leads/:id/orders", (req, res) => {
    res.status(201).json({
      data: createOrder(store, res.locals.tenant, req.params.id, req.body),
    });
  });
  app.get("/api/v1/crm/summary", (req, res) => {
    res.json({
      data: crmSummary(store, res.locals.tenant, req.query.campaignId),
    });
  });
}
