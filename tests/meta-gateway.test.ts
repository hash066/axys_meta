import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  GatewayError,
  MuseGateway,
  decodePng,
  museStatus,
  resetMuseStatusCache,
} from "../packages/meta/gateway.ts";
import { museChecks } from "../services/providers/config.ts";
import { png, startFakeGateway } from "./fake-gateway.ts";

test("gateway client validates health, segment, scene and json replies", async () => {
  const fake = await startFakeGateway({ json: () => ({ a: 1 }) });
  try {
    const g = new MuseGateway({ baseUrl: fake.url });
    assert.equal((await g.health()).key_configured, true);
    const seg = await g.segment(await png(), "bread");
    assert.equal(seg.found, true);
    assert.ok(seg.cutout!.subarray(1, 4).toString() === "PNG");
    assert.deepEqual(fake.calls.at(-1)!.fields!.concept, "bread");
    const scene = await g.scene(await png(), "on a table");
    assert.equal(scene.faithful, true);
    const j = await g.json({ model: "wonder", prompt: "x", effort: "low" });
    assert.deepEqual(j.json, { a: 1 });
    assert.equal(fake.calls.at(-1)!.body.effort, "low");
    assert.equal(await g.transcribe(Buffer.alloc(3200)), "hello world");
    await assert.rejects(
      () => g.transcribe(Buffer.alloc(3)),
      (e: unknown) => e instanceof GatewayError && e.code === "bad_request",
    );
  } finally {
    await fake.close();
  }
});

test("gateway maps failures to clear honest errors", async () => {
  const noKey = await startFakeGateway({ keyConfigured: false });
  try {
    await assert.rejects(
      () =>
        new MuseGateway({ baseUrl: noKey.url }).segment(Buffer.from("x"), "a"),
      (e: unknown) =>
        e instanceof GatewayError &&
        e.code === "no_key" &&
        /MODEL_API_KEY/.test(e.message),
    );
  } finally {
    await noKey.close();
  }
  // Unreachable gateway.
  const dead = await startFakeGateway();
  const deadUrl = dead.url;
  await dead.close();
  await assert.rejects(
    () => new MuseGateway({ baseUrl: deadUrl }).health(),
    (e: unknown) => e instanceof GatewayError && e.code === "unavailable",
  );
  // Timeout mapping and malformed bodies via injected fetch.
  await assert.rejects(
    () =>
      new MuseGateway({
        baseUrl: "http://127.0.0.1:1",
        fetch: (async () => {
          throw new DOMException("t", "TimeoutError");
        }) as typeof fetch,
      }).health(),
    (e: unknown) => e instanceof GatewayError && e.code === "timeout",
  );
  await assert.rejects(
    () =>
      new MuseGateway({
        baseUrl: "http://127.0.0.1:1",
        fetch: (async () =>
          new Response(JSON.stringify({ found: "yes" }))) as typeof fetch,
      }).segment(Buffer.from("x"), "a"),
    (e: unknown) => e instanceof GatewayError && e.code === "bad_response",
  );
  await assert.rejects(
    () =>
      new MuseGateway({
        baseUrl: "http://127.0.0.1:1",
        fetch: (async () =>
          new Response("<html>", { status: 500 })) as typeof fetch,
      }).json({ model: "wonder", prompt: "x" }),
    (e: unknown) => e instanceof GatewayError && e.code === "upstream",
  );
});

test("gateway refuses redirects, credential URLs and non-PNG images", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:9/steal" }).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      () =>
        new MuseGateway({
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        }).health(),
      (e: unknown) => e instanceof GatewayError && e.code === "unavailable",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  assert.throws(
    () => new MuseGateway({ baseUrl: "http://u:p@127.0.0.1:8766" }).baseUrl,
    /without credentials/,
  );
  assert.throws(
    () => new MuseGateway({ baseUrl: "nope" }).baseUrl,
    /valid URL/,
  );
  assert.throws(
    () =>
      decodePng(Buffer.from("not a png at all really").toString("base64"), "x"),
    /invalid x/,
  );
  assert.equal(museChecks({} as NodeJS.ProcessEnv)[0].status, "pass");
});

test("museStatus reports unavailable without a key or a gateway and never throws", async () => {
  resetMuseStatusCache();
  const fake = await startFakeGateway({ keyConfigured: false });
  try {
    const s = await museStatus(new MuseGateway({ baseUrl: fake.url }));
    assert.equal(s.reachable, true);
    assert.equal(s.available, false);
    assert.equal(s.keyConfigured, false);
    resetMuseStatusCache();
    fake.state.keyConfigured = true;
    const ok = await museStatus(new MuseGateway({ baseUrl: fake.url }));
    assert.equal(ok.available, true);
    assert.equal(ok.models.sam, "sam-3.1");
  } finally {
    await fake.close();
    resetMuseStatusCache();
  }
  const s = await museStatus(new MuseGateway({ baseUrl: fake.url }));
  assert.equal(s.available, false);
  assert.ok(s.error);
  resetMuseStatusCache();
});
