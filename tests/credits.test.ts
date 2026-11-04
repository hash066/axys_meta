import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Store } from "../server/store.ts";
import { Credits } from "../server/credits.ts";

test("credits charge idempotently and refund one failed generation", () => {
  const root = mkdtempSync(path.resolve("var-test-"));
  const previous = process.env.AXYS_STARTER_CREDITS;
  process.env.AXYS_STARTER_CREDITS = "5";
  const store = new Store(root),
    credits = new Credits(store);
  try {
    assert.equal(credits.seed("merchant").balance, 5);
    assert.equal(credits.seed("merchant").balance, 5);
    assert.equal(
      credits.charge("merchant", "Both", "generation:one:1").balance,
      1,
    );
    assert.equal(
      credits.charge("merchant", "Both", "generation:one:1").balance,
      1,
    );
    assert.throws(
      () => credits.charge("merchant", "Reels", "generation:two:1"),
      /remain/,
    );
    assert.equal(credits.refund("merchant", "generation:one:1").balance, 5);
    assert.equal(credits.refund("merchant", "generation:one:1").balance, 5);
  } finally {
    store.db.close();
    previous === undefined
      ? delete process.env.AXYS_STARTER_CREDITS
      : (process.env.AXYS_STARTER_CREDITS = previous);
    rmSync(root, { recursive: true, force: true });
  }
});
