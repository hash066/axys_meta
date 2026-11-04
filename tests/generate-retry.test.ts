import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { Engine } from "../server/engine.ts";
import type { Campaign } from "../packages/campaign/index.ts";

test("a failed generation job is re-queued when generation is requested again at the same revision", () => {
  const root = mkdtempSync(path.resolve("var-test-"));
  const store = new Store(root);
  try {
    const engine = new Engine(store);
    const c = {
      id: randomUUID(),
      tenantId: "t",
      revision: 3,
      state: "Draft",
      mode: "Both",
      layout: "editorial",
      reelStyle: "warm",
      brief: "",
      facts: { business: "B", offer: "O", collection: "C", contact: "https://example.com/x", confirmed: true, source: "merchant", products: [] },
    } as unknown as Campaign;
    const jobs = () =>
      store.db.prepare("SELECT state,error,tries FROM jobs WHERE campaign=? AND kind='generate-ai'").all(c.id) as { state: string; error: string | null; tries: number }[];
    engine.enqueue(c, "generate-ai");
    assert.deepEqual(jobs().map((j) => j.state), ["queued"]);
    store.db.prepare("UPDATE jobs SET state='failed',error='planner asked a question',tries=2 WHERE campaign=?").run(c.id);
    engine.enqueue(c, "generate-ai"); // the retry
    const after = jobs();
    assert.equal(after.length, 1, "still one job row for this revision");
    assert.deepEqual(after.map((j) => [j.state, j.error, j.tries]), [["queued", null, 0]]);
    // a job that is queued or done is left alone
    store.db.prepare("UPDATE jobs SET state='done' WHERE campaign=?").run(c.id);
    engine.enqueue(c, "generate-ai");
    assert.equal(jobs()[0].state, "done");
    // publication jobs keep their own, separate retry rules
    engine.enqueue(c, "publish");
    store.db.prepare("UPDATE jobs SET state='failed' WHERE campaign=? AND kind='publish'").run(c.id);
    engine.enqueue(c, "publish");
    assert.equal((store.db.prepare("SELECT state FROM jobs WHERE campaign=? AND kind='publish'").get(c.id) as any).state, "failed");
  } finally {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
