// Live end-to-end run against the REAL Axys server and the REAL Muse gateway (Meta Model API).
// Usage: node scripts/live-e2e.mjs [photo.png] [outDir]
// Needs: gateway on :8766 with MODEL_API_KEY, server on :4310 (npm start). Costs a few cents of API credit.
// Writes outDir/live-run.json (no secrets, no base64) plus the generated reel poster and mp4.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.AXYS_URL ?? "http://127.0.0.1:4310";
const photoPath = process.argv[2] ?? "docs/evidence/sample-product.png";
const outDir = process.argv[3] ?? "docs/evidence";
const PRODUCT = process.env.PRODUCT_NAME ?? "ceramic mug";
mkdirSync(outDir, { recursive: true });

const log = { startedAt: new Date().toISOString(), steps: [] };
const record = (name, data) => {
  log.steps.push({ name, at: new Date().toISOString(), ...data });
  console.log(name, JSON.stringify(data));
};

const login = await fetch(BASE + "/api/v1/session", {
  method: "POST",
  headers: { Origin: BASE, "Content-Type": "application/json" },
  body: JSON.stringify({ key: process.env.AXYS_KEY ?? "local-demo" }),
});
const cookie = login.headers.get("set-cookie").split(";")[0];
const call = async (method, url, body, extra = {}) => {
  const raw = Buffer.isBuffer(body);
  const r = await fetch(BASE + url, {
    method,
    headers: {
      Origin: BASE,
      Cookie: cookie,
      ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : raw ? new Uint8Array(body) : JSON.stringify(body),
  });
  const type = r.headers.get("content-type") ?? "";
  return { status: r.status, json: type.includes("json") ? await r.json() : null, res: r };
};
const data = (r) => r.json?.data ?? r.json;

const cap = data(await call("GET", "/api/v1/capabilities"));
record("capabilities", { muse: cap?.muse });
if (!cap?.muse?.available) {
  console.error("Muse gateway not available; start it and set MODEL_API_KEY.");
  process.exit(2);
}

const up = await call("POST", "/api/v1/assets", readFileSync(photoPath), {
  "Content-Type": "image/png",
  "x-asset-rights": "confirmed",
});
const assetId = data(up).id;
record("upload", { status: up.status });

const input = {
  facts: {
    business: "Clay & Co",
    offer: "Weekend studio sale",
    collection: "Saturday, Nov 7, 10am to 4pm ET",
    contact: "https://example.com/clayandco",
    confirmed: true,
    source: "merchant",
    products: [{ id: crypto.randomUUID(), name: PRODUCT, priceMinor: Number(process.env.PRICE_MINOR ?? 12900), currency: process.env.CURRENCY ?? "USD", assetId }],
  },
  mode: "Both",
  layout: "editorial",
  reelStyle: "warm",
  brief: process.env.PRODUCT_BRIEF ?? "Hand-thrown blue stoneware mug, dishwasher safe.",
};
const created = await call("POST", "/api/v1/campaigns", input);
const id = data(created).id;
record("create", { status: created.status, state: data(created).state });

const t0 = Date.now();
const enrich = await call("POST", `/api/v1/campaigns/${id}/enrich?scenes=1`);
const e = data(enrich);
record("enrich: SAM 3.1 + Muse Image + Spark fidelity", {
  status: enrich.status,
  seconds: Math.round((Date.now() - t0) / 1000),
  products: e?.products?.map((p) => ({ found: p.found, coverage: p.coverage, cutout: !!p.cutoutAssetId })),
  heroes: e?.heroes?.map((h) => ({ faithful: h.faithful, differences: h.differences })),
  warnings: e?.warnings,
});

const gen = await call("POST", `/api/v1/campaigns/${id}/generate`, { mode: "muse", audio: false });
let c;
for (let i = 0; i < 120; i++) {
  c = data(await call("GET", `/api/v1/campaigns/${id}`));
  if (c && c.state !== "Generating") break;
  await new Promise((r) => setTimeout(r, 2000));
}
record("generate: Muse Wonder plan + FFmpeg reel", {
  status: gen.status,
  state: c?.state,
  aiPlanned: c?.generation?.ai,
  headline: c?.site?.headline,
  reelRendered: !!c?.videoAssetId,
  reelLayout: c?.generation?.reelLayout,
  error: c?.error,
});

const pf1 = data(await call("POST", `/api/v1/campaigns/${id}/preflight`, {}));
record("preflight (clean)", { ok: pf1?.ok, issues: pf1?.issues, model: pf1?.model, fuzzyRan: pf1?.fuzzy?.ran });

// The demo moment: change the price after generation WITHOUT regenerating.
const edited = { ...input, facts: structuredClone(input.facts), revision: c.revision };
edited.facts.products[0].priceMinor = Number(process.env.STALE_MINOR ?? 14900);
edited.facts.products[0].id = c.facts.products[0].id;
const put = await call("PUT", `/api/v1/campaigns/${id}?keepGenerated=true`, edited);
record("edit price after generation (keepGenerated)", { status: put.status });
const pf2 = data(await call("POST", `/api/v1/campaigns/${id}/preflight`, {}));
record("preflight (stale price)", {
  ok: pf2?.ok,
  issues: pf2?.issues?.map((i) => `${i.severity}/${i.surface}: expected ${i.expected} found ${i.found}`),
  model: pf2?.model,
});

for (const [file, assetRef] of [["live-reel-poster.png", c?.videoPosterId], ["live-reel.mp4", c?.videoAssetId]]) {
  if (!assetRef) continue;
  const r = await fetch(`${BASE}/api/v1/assets/${assetRef}`, { headers: { Origin: BASE, Cookie: cookie } });
  writeFileSync(`${outDir}/${file}`, Buffer.from(await r.arrayBuffer()));
}
log.finishedAt = new Date().toISOString();
log.campaignId = id;
writeFileSync(`${outDir}/live-run.json`, JSON.stringify(log, null, 2));
console.log("wrote", `${outDir}/live-run.json`);
