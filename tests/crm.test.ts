import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.ts";
import {
  createLead,
  createOrder,
  crmSummary,
  listLeads,
  updateLeadStatus,
  type LeadEvent,
} from "../server/crm.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "axys-crm-"));
  const store = new Store(root);
  const campaignOne = "20ea67ef-9bc9-4e59-aab1-bde35d79acaa";
  const campaignTwo = "f405aa55-cf92-4d3f-aa17-95e31fa9360f";
  store.put("campaign", "one", campaignOne, {
    id: campaignOne,
    tenantId: "one",
  });
  store.put("campaign", "two", campaignTwo, {
    id: campaignTwo,
    tenantId: "two",
  });
  return {
    store,
    campaignOne,
    campaignTwo,
    close() {
      store.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("lead creation is tenant-scoped, append-only and idempotent", () => {
  const f = fixture();
  try {
    const request = {
      idempotencyKey: "lead-create-one",
      campaignId: f.campaignOne,
      source: "whatsapp",
      customerLabel: "  Morning enquiry  ",
      consent: true,
    };
    const lead = createLead(f.store, "one", request);
    const replay = createLead(f.store, "one", request);
    assert.equal(replay.id, lead.id);
    assert.equal(lead.customerLabel, "Morning enquiry");
    assert.equal(lead.status, "New");
    assert.deepEqual(
      listLeads(f.store, "one").map((item) => item.id),
      [lead.id],
    );
    assert.deepEqual(listLeads(f.store, "two"), []);
    assert.equal(f.store.list("crm-lead-event", "one").length, 1);
    assert.equal(f.store.list("crm-idempotency", "one").length, 1);
    assert.throws(() =>
      createLead(f.store, "one", {
        ...request,
        customerLabel: "Different request",
      }),
    );
    assert.throws(() =>
      createLead(f.store, "one", {
        ...request,
        idempotencyKey: "wrong-campaign",
        campaignId: f.campaignTwo,
      }),
    );
  } finally {
    f.close();
  }
});

test("status transitions are defensible and Do Not Contact is terminal", () => {
  const f = fixture();
  try {
    const lead = createLead(f.store, "one", {
      idempotencyKey: "lead-for-status",
      source: "merchant",
      consent: false,
    });
    assert.throws(() =>
      updateLeadStatus(f.store, "one", lead.id, {
        idempotencyKey: "skip-to-order",
        status: "Ordered",
      }),
    );
    const replied = updateLeadStatus(f.store, "one", lead.id, {
      idempotencyKey: "mark-replied",
      status: "Replied",
      note: "Merchant replied manually",
    });
    const replay = updateLeadStatus(f.store, "one", lead.id, {
      idempotencyKey: "mark-replied",
      status: "Replied",
      note: "Merchant replied manually",
    });
    assert.equal(replay.status, "Replied");
    assert.equal(replay.updatedAt, replied.updatedAt);
    const stopped = updateLeadStatus(f.store, "one", lead.id, {
      idempotencyKey: "customer-opt-out",
      status: "DoNotContact",
    });
    assert.equal(stopped.status, "DoNotContact");
    assert.throws(() =>
      updateLeadStatus(f.store, "one", lead.id, {
        idempotencyKey: "illegal-reopen",
        status: "Replied",
      }),
    );
    assert.throws(() =>
      createOrder(f.store, "one", lead.id, {
        idempotencyKey: "illegal-order",
        currency: "INR",
      }),
    );
    const events = f.store.list<LeadEvent>("crm-lead-event", "one");
    assert.equal(events.length, 3);
    assert.equal(
      events.filter((item) => item.type === "StatusChanged").length,
      2,
    );
  } finally {
    f.close();
  }
});

test("contact activity never becomes an order without an explicit order mutation", () => {
  const f = fixture();
  try {
    f.store.db
      .prepare("INSERT INTO events VALUES(?,?,?)")
      .run(f.campaignOne, "visit", new Date().toISOString());
    f.store.db
      .prepare("INSERT INTO events VALUES(?,?,?)")
      .run(f.campaignOne, "contact", new Date().toISOString());
    const lead = createLead(f.store, "one", {
      idempotencyKey: "summary-lead",
      campaignId: f.campaignOne,
      source: "whatsapp",
      consent: true,
    });
    assert.deepEqual(crmSummary(f.store, "one", f.campaignOne), {
      visits: 1,
      contactActions: 1,
      leads: 1,
      ordered: 0,
      fulfilled: 0,
      revenueMinorByCurrency: {},
    });
    updateLeadStatus(f.store, "one", lead.id, {
      idempotencyKey: "summary-replied",
      status: "Replied",
    });
    updateLeadStatus(f.store, "one", lead.id, {
      idempotencyKey: "summary-qualified",
      status: "Qualified",
    });
    assert.throws(() =>
      createOrder(f.store, "one", lead.id, {
        idempotencyKey: "amount-without-currency",
        amountMinor: 100,
      }),
    );
    const orderRequest = {
      idempotencyKey: "summary-order",
      amountMinor: 125000,
      currency: "INR",
    };
    const first = createOrder(f.store, "one", lead.id, orderRequest);
    const replay = createOrder(f.store, "one", lead.id, orderRequest);
    assert.equal(replay.order.id, first.order.id);
    const amountless = createOrder(f.store, "one", lead.id, {
      idempotencyKey: "amountless-order",
    });
    assert.equal(amountless.order.amountMinor, undefined);
    assert.equal(amountless.order.currency, undefined);
    updateLeadStatus(f.store, "one", lead.id, {
      idempotencyKey: "summary-fulfilled",
      status: "Fulfilled",
      note: "Merchant confirmed fulfillment",
    });
    assert.deepEqual(crmSummary(f.store, "one", f.campaignOne), {
      visits: 1,
      contactActions: 1,
      leads: 1,
      ordered: 2,
      fulfilled: 1,
      revenueMinorByCurrency: { INR: 125000 },
    });
    assert.equal(f.store.list("crm-order", "one").length, 2);
  } finally {
    f.close();
  }
});

test("summary excludes other tenants and rejects their campaign filters", () => {
  const f = fixture();
  try {
    f.store.db
      .prepare("INSERT INTO events VALUES(?,?,?)")
      .run(f.campaignOne, "visit", new Date().toISOString());
    f.store.db
      .prepare("INSERT INTO events VALUES(?,?,?)")
      .run(f.campaignTwo, "visit", new Date().toISOString());
    createLead(f.store, "two", {
      idempotencyKey: "tenant-two-lead",
      campaignId: f.campaignTwo,
      source: "merchant",
      consent: true,
    });
    assert.deepEqual(crmSummary(f.store, "one"), {
      visits: 1,
      contactActions: 0,
      leads: 0,
      ordered: 0,
      fulfilled: 0,
      revenueMinorByCurrency: {},
    });
    assert.throws(() => crmSummary(f.store, "one", f.campaignTwo));
  } finally {
    f.close();
  }
});
