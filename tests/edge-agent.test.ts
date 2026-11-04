import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedMetaMediaUrl,
  constantTimeEqual,
  extractMessages,
  normalizePlan,
} from "../workers/hermes-agent/worker.ts";

test("edge agent authenticates proxy values without prefix matches", () => {
  assert.equal(constantTimeEqual("correct", "correct"), true);
  assert.equal(constantTimeEqual("correct", "correcx"), false);
  assert.equal(constantTimeEqual("correct", "correct-extra"), false);
  assert.equal(constantTimeEqual("", ""), false);
});

test("edge agent extracts bounded WhatsApp messages", () => {
  const messages = extractMessages({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: "m-1",
                  from: "919999999999",
                  type: "text",
                  text: { body: "Website" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text?.body, "Website");
  assert.equal(
    extractMessages({
      entry: [
        {
          changes: [
            { value: { messages: [{ id: "m-2", from: "bad", type: "text" }] } },
          ],
        },
      ],
    }).length,
    0,
  );
});

test("edge agent accepts only Meta HTTPS media hosts", () => {
  assert.equal(allowedMetaMediaUrl("https://lookaside.fbsbx.com/file"), true);
  assert.equal(allowedMetaMediaUrl("https://cdn.fbcdn.net/file"), true);
  assert.equal(allowedMetaMediaUrl("https://fbcdn.net.evil.test/file"), false);
  assert.equal(allowedMetaMediaUrl("http://lookaside.fbsbx.com/file"), false);
});

test("edge agent converts a bounded model proposal to the existing edge contract", () => {
  const plan = normalizePlan(
    {
      status: "ready",
      businessType: "tailor",
      businessName: "Maya Tailoring",
      description: "Blouse stitching and alterations.",
      fulfillmentArea: "Bengaluru",
      leadTime: "Usually ready in four days.",
      timezone: "Asia/Kolkata",
      suppliedClaims: ["Merchant supplied claim"],
      projectIntent: "both",
      catalog: [
        {
          name: "Blouse stitching",
          description: "Custom fitting",
          priceMinor: 90000,
          currency: "INR",
        },
      ],
    },
    "919999999999",
    ["asset-abc-image"],
  );
  assert.equal(plan?.businessName, "Maya Tailoring");
  assert.equal(plan?.orderWhatsAppNumber, "+919999999999");
  assert.equal(plan?.catalog[0].imageAssetId, "asset-abc-image");
  assert.equal(normalizePlan({ status: "ready" }, "919999999999", []), null);
});
