import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayError, MuseGateway } from "../packages/meta/gateway.ts";
import { startFakeGateway, tinyMp3 } from "./fake-gateway.ts";

test("speak: sends the normalised text and voice, returns the mp3 with cached and credits", async () => {
  const fake = await startFakeGateway();
  try {
    const gw = new MuseGateway({ baseUrl: fake.url });
    const a = await gw.speak("  Stride   Lane.\n White sneaker, $89.00.  ", "reel");
    assert.deepEqual(fake.calls[0].body, { text: "Stride Lane. White sneaker, $89.00.", voice: "reel" });
    assert.ok(a.audio.equals(tinyMp3()));
    assert.equal(a.cached, false);
    assert.equal(a.credits, 17.5);
    assert.equal(a.model, "eleven_flash_v2_5");
    const b = await gw.speak("Stride Lane. White sneaker, $89.00.", "reel");
    assert.equal(b.cached, true);
    assert.equal(b.credits, 0);
  } finally {
    await fake.close();
  }
});

test("speak: refuses empty or over-long text before any call, maps gateway errors, rejects non-mp3 audio", async () => {
  const fake = await startFakeGateway({ failSpeak: 402 });
  try {
    const gw = new MuseGateway({ baseUrl: fake.url });
    await assert.rejects(gw.speak("   "), (e) => e instanceof GatewayError && e.code === "bad_request");
    await assert.rejects(gw.speak("x".repeat(401)), (e) => e instanceof GatewayError && e.code === "bad_request");
    assert.equal(fake.calls.length, 0);
    await assert.rejects(
      gw.speak("Hello there friend."),
      (e) => e instanceof GatewayError && e.code === "bad_request" && e.status === 402 && /credits/i.test(e.message),
    );
    assert.equal(fake.calls.length, 1);
  } finally {
    await fake.close();
  }
  const reply = (audio: string) =>
    (async () =>
      new Response(JSON.stringify({ audio_mp3_b64: audio, cached: false, credits_charged: 1, voice_id: "v", model: "m" }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  for (const audio of [Buffer.from("this is definitely not an mp3 file").toString("base64"), "!!notbase64!!"])
    await assert.rejects(
      new MuseGateway({ baseUrl: "http://127.0.0.1:1", fetch: reply(audio) }).speak("Hello there friend."),
      (e) => e instanceof GatewayError && e.code === "bad_response",
    );
});
