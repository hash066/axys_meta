import { test, expect } from "@playwright/test";
import sharp from "sharp";
test("merchant creates, reviews and publishes an exact website version", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("Workspace access key").fill("local-demo");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Start with what’s true." }),
  ).toBeVisible();
  await page.getByLabel("Business name").fill("Sample bakery — browser test");
  await page.getByLabel("Offer headline").fill("Weekend bread collection");
  await page
    .getByLabel("Collection date & time")
    .fill("24 October 2026, 4–6 pm IST");
  await page.getByLabel("Contact URL").fill("https://example.com/contact");
  await page
    .getByRole("combobox", { name: "Create", exact: true })
    .selectOption("Website");
  await page.getByLabel("I own or have permission").check();
  const image = await sharp({
    create: { width: 500, height: 500, channels: 3, background: "#c29463" },
  })
    .png()
    .toBuffer();
  await page.getByLabel("Product photo", { exact: true }).setInputFiles({
    name: "sample-bread.png",
    mimeType: "image/png",
    buffer: image,
  });
  await expect(page.getByLabel("Product name")).toBeVisible();
  await page.getByLabel("Product name").fill("Sample loaf");
  await page.getByLabel("Price", { exact: true }).fill("125");
  await page.getByLabel("I confirm these prices").check();
  await page.screenshot({
    path: "docs/evidence/desktop-brief.png",
    fullPage: true,
  });
  await page.screenshot({ path: "docs/evidence/studio.png" });
  await page.getByRole("button", { name: "Save facts & continue" }).click();
  await page.getByRole("button", { name: "Render confirmed facts" }).click();
  await expect(
    page.getByRole("heading", { name: "Website preview" }),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".merchant-site")).toContainText("$125.00");
  await page.screenshot({
    path: "docs/evidence/desktop-review.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Mobile", exact: true }).click();
  await expect(page.locator(".merchant-site")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "docs/evidence/mobile-review.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Review publication" }).click();
  await page
    .getByRole("button", { name: "Prepare exact-version review" })
    .click();
  await page
    .getByRole("button", { name: "I approve this version & account" })
    .click();
  await page.getByRole("button", { name: "Publish approved campaign" }).click();
  await expect(page.getByRole("link", { name: "Open website" })).toBeVisible({
    timeout: 20000,
  });
  const url = await page
    .getByRole("link", { name: "Open website" })
    .getAttribute("href");
  const response = await page.request.get(url!);
  expect(response.ok()).toBeTruthy();
  expect(await response.text()).toContain("$125.00");
  await page.getByRole("button", { name: "View results" }).click();
  await page.getByRole("button", { name: "Load available results" }).click();
  await expect(
    page.getByText("Unknown — Not retrieved or unavailable"),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/evidence/mobile-results.png",
    fullPage: true,
  });
  await page.goto(url!);
  await expect(page.locator(".merchant-site")).toContainText("$125.00");
  await expect
    .poll(() =>
      page
        .locator(".products img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  const contact = await page
    .getByRole("link", { name: "Enquire about this offer" })
    .getAttribute("href");
  const redirect = await page.request.get(contact!, { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  expect(redirect.headers().location).toBe("https://example.com/contact");
  await page.screenshot({
    path: "docs/evidence/published-mobile.png",
    fullPage: true,
  });
});

test("final reel preview and explicit permission/partial states", async ({
  page,
}) => {
  test.setTimeout(90000);
  const headers = { Origin: "http://127.0.0.1:4310" };
  await page.request.post("/api/v1/session", {
    headers,
    data: { key: "local-demo" },
  });
  const bytes = await sharp({
    create: { width: 500, height: 500, channels: 3, background: "#bd8d57" },
  })
    .png()
    .toBuffer();
  const uploaded = await page.request.post("/api/v1/assets", {
    headers: {
      ...headers,
      "Content-Type": "image/png",
      "X-Asset-Rights": "confirmed",
    },
    data: bytes,
  });
  const asset = (await uploaded.json()).data;
  const input = {
    mode: "Both",
    layout: "catalog",
    reelStyle: "bold",
    brief: "Browser QA fixture only",
    facts: {
      business: "Sample reel QA",
      offer: "Weekend collection",
      collection: "24 October 2026 4pm IST",
      contact: "https://example.com",
      confirmed: true,
      source: "merchant",
      products: [
        {
          id: crypto.randomUUID(),
          name: "Sample loaf",
          priceMinor: 14900,
          currency: "INR",
          assetId: asset.id,
        },
      ],
    },
  };
  const created = await page.request.post("/api/v1/campaigns", {
    headers,
    data: input,
  });
  const c = (await created.json()).data;
  await page.request.post(`/api/v1/campaigns/${c.id}/generate`, {
    headers,
    data: { mode: "manual" },
  });
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`/api/v1/campaigns/${c.id}`);
        return (await r.json()).data.state;
      },
      { timeout: 45000 },
    )
    .toBe("NeedsReview");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Sample reel QA NeedsReview", exact: true })
    .first()
    .click();
  await expect
    .poll(
      () =>
        page
          .locator("video")
          .evaluate((v: HTMLVideoElement) =>
            v.error ? -v.error.code : v.readyState,
          ),
      { timeout: 15000 },
    )
    .toBeGreaterThan(0);
  expect(
    await page.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth),
  ).toBe(1080);
  expect(
    await page.locator("video").evaluate((v: HTMLVideoElement) => v.duration),
  ).toBeGreaterThanOrEqual(4);
  await page.locator("video").evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThan(0.2);
  await page.locator("video").evaluate((v: HTMLVideoElement) => v.pause());
  await page.screenshot({
    path: "docs/evidence/desktop-both-review.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Review publication" }).click();
  await expect(page.getByText("No Instagram account connected.")).toBeVisible();
  await page
    .getByRole("button", { name: "Prepare exact-version review" })
    .click();
  await page
    .getByRole("button", { name: "I approve this version & account" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "disconnected or expired",
  );
  await page.screenshot({
    path: "docs/evidence/permission-state.png",
    fullPage: true,
  });
  const current = (
    await (await page.request.get(`/api/v1/campaigns/${c.id}`)).json()
  ).data;
  const fixture = {
    ...current,
    state: "PartialFailure",
    facts: { ...current.facts, business: "UI fixture — partial publication" },
    attempt: {
      id: crypto.randomUUID(),
      site: "Published",
      social: "Failed",
      error:
        "Injected UI fixture: Instagram access revoked. No real provider publication.",
    },
  };
  await page.route("**/api/v1/campaigns", (route) =>
    route.fulfill({ json: { data: [fixture] } }),
  );
  await page.reload();
  await page
    .getByRole("button", {
      name: "UI fixture — partial publication PartialFailure",
    })
    .click();
  await page.getByRole("button", { name: "04Publish", exact: true }).click();
  await expect(
    page.getByText(
      "Injected UI fixture: Instagram access revoked. No real provider publication.",
    ),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/evidence/partial-state-fixture.png",
    fullPage: true,
  });
});
