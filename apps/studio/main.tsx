import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import type { Campaign, Input } from "../../packages/campaign/index";
import { Site } from "../../packages/renderers/Site";
import {
  MetaLens,
  PreflightPanel,
  VoiceRecorder,
  SCENARIO_STALE,
  SCENARIO_COMMAND,
  blockCount,
  sleepMs,
  type PreflightState,
} from "./meta";
import { AutoReel } from "./film";
import { RedPen, RedPenDemo } from "./redpen";
import { CommandDemo, SayIt, useSayItLink } from "./sayit";
import "./style.css";
import "./site.css";
import Landing from "./landing";
async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch("/api/v1" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Request failed");
  return j.data;
}
const stages = ["Brief", "Create", "Review", "Publish", "Results"];
type Currency = "INR" | "USD" | "EUR" | "GBP";
type LeadStatus =
  | "New"
  | "Replied"
  | "Qualified"
  | "Ordered"
  | "Fulfilled"
  | "NotInterested"
  | "Spam"
  | "DoNotContact";
type CrmLead = {
  id: string;
  campaignId?: string;
  customerLabel?: string;
  status: LeadStatus;
  source?: string;
  updatedAt?: string;
};
type CrmSummary = {
  visits?: number | null;
  contactActions?: number | null;
  leads?: number | null;
  ordered?: number | null;
  fulfilled?: number | null;
  revenueMinorByCurrency?: Partial<Record<Currency, number | null>> | null;
};
type LeadAction = {
  status: LeadStatus | "";
  note: string;
  amount: string;
  currency: Currency;
};
const leadTransitions: Record<LeadStatus, LeadStatus[]> = {
  New: ["Replied", "NotInterested", "Spam", "DoNotContact"],
  Replied: ["Qualified", "NotInterested", "Spam", "DoNotContact"],
  Qualified: ["Ordered", "NotInterested", "DoNotContact"],
  Ordered: ["Fulfilled", "DoNotContact"],
  Fulfilled: ["DoNotContact"],
  NotInterested: [],
  Spam: [],
  DoNotContact: [],
};
const currencies: Currency[] = ["INR", "USD", "EUR", "GBP"];
const countText = (value: number | null | undefined) =>
  value == null ? "Unknown" : value.toLocaleString();
const statusText = (status: LeadStatus) =>
  status.replace(/([a-z])([A-Z])/g, "$1 $2");
const revenueText = (summary: CrmSummary | undefined) => {
  if (!summary || summary.revenueMinorByCurrency == null) return "Unknown";
  const values = Object.entries(summary.revenueMinorByCurrency).filter(
    (entry): entry is [Currency, number] => entry[1] != null,
  );
  if (!values.length) return "No amount recorded";
  return values
    .map(([currency, minor]) =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      }).format(minor / 100),
    )
    .join(" · ");
};
const initial: Input = {
  facts: {
    business: "",
    offer: "",
    collection: "",
    contact: "https://",
    products: [],
    confirmed: true,
    source: "merchant",
  },
  brief: "",
  mode: "Both",
  layout: "editorial",
  reelStyle: "warm",
};
function StudioApp() {
  const [session, setSession] = useState(false),
    [publicConfig, setPublicConfig] = useState<any>({}),
    [key, setKey] = useState(""),
    [caps, setCaps] = useState<any>({ connections: [] }),
    [campaigns, setCampaigns] = useState<Campaign[]>([]),
    [c, setC] = useState<Campaign>(),
    [form, setForm] = useState<Input>(initial),
    [stage, setStage] = useState(0),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [rights, setRights] = useState(false),
    [mobile, setMobile] = useState(false),
    [account, setAccount] = useState(""),
    [schedule, setSchedule] = useState(""),
    [approvalDigest, setApprovalDigest] = useState(""),
    [metrics, setMetrics] = useState<any>(),
    [proposal, setProposal] = useState<any>(),
    [intake, setIntake] = useState<any[]>([]),
    [whatsappDrafts, setWhatsappDrafts] = useState<any[]>([]),
    [selectedWhatsappDraft, setSelectedWhatsappDraft] = useState<any>(),
    [leads, setLeads] = useState<CrmLead[]>(),
    [crmSummary, setCrmSummary] = useState<CrmSummary>(),
    [leadLabel, setLeadLabel] = useState(""),
    [leadConsent, setLeadConsent] = useState(false),
    [leadActions, setLeadActions] = useState<Record<string, LeadAction>>({}),
    [preflight, setPreflight] = useState<PreflightState>();
  const sayLink = useSayItLink();
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again");
    } finally {
      setBusy("");
    }
  };
  async function load() {
    const cap = await api("/capabilities");
    setCaps(cap);
    setSession(true);
    setCampaigns(await api("/campaigns"));
    setIntake(await api("/intake"));
    setWhatsappDrafts(await api("/intake/whatsapp-drafts"));
  }
  async function loadCrm(campaignId: string) {
    const [nextLeads, nextSummary] = await Promise.all([
      api("/crm/leads"),
      api(`/crm/summary?campaignId=${encodeURIComponent(campaignId)}`),
    ]);
    setLeads(Array.isArray(nextLeads) ? nextLeads : []);
    setCrmSummary(nextSummary || {});
  }
  useEffect(() => {
    fetch("/api/v1/public-config")
      .then((response) => response.json())
      .then((result) => setPublicConfig(result.data || {}))
      .catch(() => {});
    load().catch(() => {});
  }, []);
  useEffect(() => {
    setNotice("");
  }, [stage]);
  useEffect(() => {
    if (c) setForm(c);
    if (c)
      setCampaigns((items) =>
        items.some((x) => x.id === c.id)
          ? items.map((x) => (x.id === c.id ? c : x))
          : [c, ...items],
      );
  }, [c]);
  useEffect(() => {
    if (!c || !["Generating", "Publishing"].includes(c.state)) return;
    const id = setInterval(() => {
      api(`/campaigns/${c.id}`)
        .then(setC)
        .catch((e) => setError(e.message));
    }, 1500);
    return () => clearInterval(id);
  }, [c?.id, c?.state]);
  function editFacts(field: string, value: any) {
    setForm((f) => ({ ...f, facts: { ...f.facts, [field]: value } }));
    setConfirmed(false);
    setApprovalDigest("");
  }
  async function save() {
    if (!confirmed) throw new Error("Confirm the business facts before saving");
    if (selectedWhatsappDraft && !rights)
      throw new Error("Confirm rights to the WhatsApp images before importing");
    const next = selectedWhatsappDraft
      ? await api(
          `/intake/whatsapp-drafts/${selectedWhatsappDraft.id}/import`,
          {
            confirmFacts: true,
            draftUpdatedAt: selectedWhatsappDraft.updatedAt,
            campaign: { ...form, facts: { ...form.facts, source: "whatsapp" } },
          },
        )
      : await api(
          c ? `/campaigns/${c.id}` : "/campaigns",
          c ? { ...form, revision: c.revision } : form,
          c ? "PUT" : "POST",
        );
    setC(next);
    setSelectedWhatsappDraft(undefined);
    setCampaigns(await api("/campaigns"));
    setWhatsappDrafts(await api("/intake/whatsapp-drafts"));
    setStage(1);
    setNotice("Facts saved. Create matching outputs next.");
  }
  async function upload(file: File) {
    if (!rights) throw new Error("Confirm image rights before uploading");
    const response = await fetch("/api/v1/assets", {
      method: "POST",
      headers: { "Content-Type": file.type, "X-Asset-Rights": "confirmed" },
      body: file,
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error?.message || "Image upload failed");
    editFacts("products", [
      ...form.facts.products,
      {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.[^.]+$/, ""),
        priceMinor: 0,
        currency: "INR",
        assetId: data.data.id,
      },
    ]);
  }
  const setProduct = (i: number, k: string, v: any) =>
    editFacts(
      "products",
      form.facts.products.map((p, j) => (i === j ? { ...p, [k]: v } : p)),
    );
  async function prepareApproval() {
    if (!c) return;
    const when = schedule
      ? new Date(schedule).toISOString()
      : new Date().toISOString();
    setSchedule(when);
    const d = await api(`/campaigns/${c.id}/preview-digest`, {
      accountId: account,
      schedule: when,
      revision: c.revision,
      siteHash: c.siteHash,
      videoHash: c.videoHash,
    });
    setApprovalDigest(d.digest);
  }
  /** Red pen "Fix with Axys": regenerate, poll until generation settles, return the settled campaign. */
  async function regenerateForFix(): Promise<Campaign> {
    if (!c) throw new Error("No campaign to regenerate.");
    let next: Campaign = await api(`/campaigns/${c.id}/generate`, {
      mode: caps.muse?.available ? "muse" : "manual",
    });
    setC(next);
    const t0 = Date.now();
    while (next.state === "Generating" && Date.now() - t0 < 5 * 60_000) {
      await sleepMs(1500);
      next = await api(`/campaigns/${c.id}`);
      setC(next);
    }
    if (next.state === "Generating")
      throw new Error(
        "Regeneration is still running. Run preflight again when it finishes.",
      );
    if (!next.site)
      throw new Error(next.error || "Regeneration did not produce a website.");
    setCaps(await api("/capabilities"));
    return next;
  }
  const preflightBlocked = !!c && blockCount(preflight, c) > 0;
  const campaignLeads =
    c && leads
      ? leads.filter((lead) => !lead.campaignId || lead.campaignId === c.id)
      : undefined;
  const leadAction = (lead: CrmLead): LeadAction =>
    leadActions[lead.id] || {
      status: "",
      note: "",
      amount: "",
      currency: "INR",
    };
  const changeLeadAction = (lead: CrmLead, change: Partial<LeadAction>) =>
    setLeadActions((current) => ({
      ...current,
      [lead.id]: { ...leadAction(lead), ...change },
    }));
  if (!session)
    return (
      <div className="login">
        <div className="wordmark">
          axys<span>●</span>
        </div>
        <p className="eyebrow">YOUR CAMPAIGN WORKSPACE</p>
        <h1>
          One offer.
          <br />
          Every surface.
        </h1>
        <p>
          Describe your sale in WhatsApp or open Studio. Axys turns the same
          brief into a hosted website, reel, customer funnel and follow-up.
        </p>
        <div className="entry-actions">
          {publicConfig.whatsappUrl ? (
            <a
              className="button-link"
              href={publicConfig.whatsappUrl}
              target="_blank"
              rel="noreferrer"
            >
              Start with WhatsApp →
            </a>
          ) : (
            <span className="button-link disabled" aria-disabled="true">
              WhatsApp connection pending
            </span>
          )}
          <p className="muted">
            Messages and Studio use one workspace. Instagram connects later
            through Meta OAuth; Axys never asks for your Instagram password.
          </p>
        </div>
        {publicConfig.hosting === "cloudflare-workers" ? (
          <button
            disabled={!!busy}
            onClick={() =>
              run("Creating workspace", async () => {
                await api("/session", { create: true });
                await load();
              })
            }
          >
            Start a pilot workspace →
          </button>
        ) : (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run("Signing in", async () => {
                  await api("/session", { key });
                  await load();
                });
              }}
            >
              <label>
                Workspace access key
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              <button disabled={!!busy}>Open workspace →</button>
            </form>
            {publicConfig.hosting === "local-development" && (
              <p className="muted">
                Local development: use <code>local-demo</code> when no access
                keys are configured.
              </p>
            )}
          </>
        )}
        {publicConfig.workspaceReady === false && (
          <p className="muted">
            Studio workspace access is being migrated. WhatsApp intake remains
            the live entry for the pilot.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    );
  return (
    <div className="shell">
      <aside>
        <div className="wordmark">
          axys<span>●</span>
        </div>
        <p className="workspace-label">CAMPAIGN STUDIO</p>
        <div className="credit-balance" aria-label="Axys credit balance">
          <strong>{caps.credits?.balance ?? "—"}</strong>
          <span>credits</span>
        </div>
        <button
          className="new"
          onClick={() => {
            setC(undefined);
            setForm(initial);
            setConfirmed(false);
            setStage(0);
            setMetrics(undefined);
            setLeads(undefined);
            setCrmSummary(undefined);
          }}
        >
          ＋ New campaign
        </button>
        <nav aria-label="Campaign steps">
          {stages.map((s, i) => (
            <button
              key={s}
              aria-current={stage === i ? "step" : undefined}
              onClick={() => setStage(i)}
            >
              <span>0{i + 1}</span>
              {s}
            </button>
          ))}
        </nav>
        <div className="campaign-list">
          <p className="eyebrow">YOUR CAMPAIGNS</p>
          {campaigns.length === 0 ? (
            <p className="muted">Your first offer starts here.</p>
          ) : (
            campaigns.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setC(item);
                  setForm(item);
                  setConfirmed(true);
                  setStage(2);
                  setApprovalDigest("");
                  setMetrics(undefined);
                  setLeads(undefined);
                  setCrmSummary(undefined);
                }}
              >
                {item.facts.business}
                <small>{item.state}</small>
              </button>
            ))
          )}
        </div>
        <div className="sidebar-bottom">
          <span className="dot" />{" "}
          {caps.local ? "Local workspace" : "Merchant workspace"}
          <button
            className="text-button"
            onClick={() =>
              run("Signing out", async () => {
                await api("/logout", {});
                setSession(false);
              })
            }
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="studio">
        <header className="topbar">
          <span>
            {c?.facts.business || "Your next campaign"}{" "}
            <span className="muted">/ {stages[stage]}</span>
          </span>
          <span className="pill">{c?.state || "New brief"}</span>
        </header>
        <div className="content">
          <div className="section-heading">
            <div>
              <p className="eyebrow">
                {String(stage + 1).padStart(2, "0")} /{" "}
                {stages[stage].toUpperCase()}
              </p>
              <h1>
                {
                  [
                    "Start with what’s true.",
                    "Make it a campaign.",
                    "Every detail, together.",
                    "Ready when you are.",
                    "Observe. Then improve.",
                  ][stage]
                }
              </h1>
            </div>
            <span className="edition">
              WEBSITE + REEL
              <br />
              ONE SHARED OFFER
            </span>
          </div>
          {busy && (
            <div className="feedback" role="status">
              {busy}…
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="feedback" role="status">
              {notice}
            </div>
          )}
          {c?.error && <div className="error">{c.error}</div>}
          {stage === 0 && (
            <div className="brief-grid">
              <section className="panel">
                <h2>The business & offer</h2>
                <label>
                  Business name
                  <input
                    value={form.facts.business}
                    onChange={(e) => editFacts("business", e.target.value)}
                    placeholder="Your business name"
                  />
                </label>
                <label>
                  Offer headline
                  <input
                    value={form.facts.offer}
                    onChange={(e) => editFacts("offer", e.target.value)}
                    placeholder="What are you offering?"
                  />
                </label>
                <div className="two">
                  <label>
                    Collection date & time
                    <input
                      value={form.facts.collection}
                      onChange={(e) => editFacts("collection", e.target.value)}
                      placeholder="24 October 2026, 4–6 pm IST"
                    />
                  </label>
                  <label>
                    Contact URL
                    <input
                      type="url"
                      value={form.facts.contact}
                      onChange={(e) => editFacts("contact", e.target.value)}
                      placeholder="https://wa.me/…"
                    />
                  </label>
                </div>
                <label>
                  Offer ends (required for scheduled publication)
                  <input
                    type="datetime-local"
                    onChange={(e) =>
                      editFacts(
                        "validUntil",
                        e.target.value
                          ? new Date(e.target.value).toISOString()
                          : undefined,
                      )
                    }
                  />
                </label>
                <label>
                  Website & caption note (optional)
                  <textarea
                    value={form.facts.message || ""}
                    maxLength={400}
                    onChange={(e) => editFacts("message", e.target.value)}
                    placeholder="Add your own confirmed details or a short message."
                  />
                </label>
                <label>
                  Your brief or corrected transcript
                  <textarea
                    rows={4}
                    value={form.brief}
                    onChange={(e) =>
                      setForm({ ...form, brief: e.target.value })
                    }
                    placeholder="Describe your campaign in your own words. Include only facts you can confirm."
                  />
                </label>
                <VoiceRecorder
                  disabled={!!busy}
                  onTranscript={(text) =>
                    setForm((f) => ({
                      ...f,
                      brief: f.brief.trim()
                        ? `${f.brief.trim()}
${text}`
                        : text,
                    }))
                  }
                />
                <label>
                  Voice recording (optional, up to 3 minutes)
                  <input
                    type="file"
                    accept="audio/wav,audio/mpeg,audio/mp4,audio/webm,audio/ogg"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file)
                        run("Checking voice recording", async () => {
                          const r = await fetch("/api/v1/audio", {
                            method: "POST",
                            headers: {
                              "Content-Type": file.type,
                              "X-Asset-Rights": "confirmed",
                            },
                            body: file,
                          });
                          const data = await r.json();
                          if (!r.ok)
                            throw new Error(
                              data.error?.message || "Audio upload failed",
                            );
                          setForm({ ...form, voiceAssetId: data.data.id });
                        });
                    }}
                  />
                </label>
                {form.voiceAssetId && (
                  <audio controls src={`/api/v1/assets/${form.voiceAssetId}`} />
                )}
                <p className="muted">
                  Upload only your own or permitted recording. An uploaded file
                  is kept as an attachment; use the recorder above to transcribe
                  speech into the brief.
                </p>
                {whatsappDrafts.length > 0 && (
                  <label>
                    Continue a WhatsApp draft
                    <select
                      value={selectedWhatsappDraft?.id || ""}
                      onChange={(e) => {
                        const draft = whatsappDrafts.find(
                          (item) => item.id === e.target.value,
                        );
                        setSelectedWhatsappDraft(draft);
                        if (!draft) return;
                        const images = draft.media.filter(
                          (item: any) =>
                            item.kind === "image" &&
                            item.status === "Stored" &&
                            item.assetId,
                        );
                        const audio = draft.media.find(
                          (item: any) =>
                            item.kind === "audio" &&
                            item.status === "Stored" &&
                            item.assetId,
                        );
                        setC(undefined);
                        const planned = draft.plan;
                        setForm({
                          ...initial,
                          brief: draft.brief,
                          mode: draft.mode || "Both",
                          facts: {
                            ...initial.facts,
                            source: "whatsapp",
                            business: planned?.businessName || "",
                            offer: planned?.description || "",
                            collection: [
                              planned?.fulfillmentArea,
                              planned?.leadTime,
                            ]
                              .filter(Boolean)
                              .join(" · "),
                            contact: planned?.orderWhatsAppNumber
                              ? `https://wa.me/${String(planned.orderWhatsAppNumber).replace(/\D/g, "")}`
                              : "",
                            products: images.map(
                              (item: any, index: number) => ({
                                id: crypto.randomUUID(),
                                name:
                                  planned?.catalog?.[index]?.name ||
                                  `WhatsApp product ${index + 1}`,
                                priceMinor:
                                  planned?.catalog?.[index]?.priceMinor || 0,
                                currency:
                                  planned?.catalog?.[index]?.currency ||
                                  ("INR" as const),
                                assetId: item.assetId,
                              }),
                            ),
                          },
                          ...(audio ? { voiceAssetId: audio.assetId } : {}),
                        });
                        setConfirmed(false);
                        setRights(false);
                        setNotice(
                          images.length
                            ? "WhatsApp media loaded. Fill every factual field, confirm image rights, then import."
                            : "WhatsApp text loaded. Wait for a stored image before importing this campaign.",
                        );
                      }}
                    >
                      <option value="">Choose a sender-bound draft</option>
                      {whatsappDrafts.map((draft) => (
                        <option key={draft.id} value={draft.id}>
                          {draft.brief.slice(0, 52) || "Media-only draft"} ·{" "}
                          {draft.status}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {intake.length > 0 && (
                  <label>
                    Import a WhatsApp brief
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const item = intake.find(
                          (x) => x.id === e.target.value,
                        );
                        if (item)
                          setForm({
                            ...form,
                            brief: item.text,
                            facts: { ...form.facts, source: "whatsapp" },
                          });
                      }}
                    >
                      <option value="">Choose a received message</option>
                      {intake
                        .filter((x) => x.text)
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.text.slice(0, 60)}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <label>
                  Create
                  <select
                    aria-label="Create"
                    value={form.mode}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        mode: e.target.value as Input["mode"],
                      })
                    }
                  >
                    <option>Both</option>
                    <option>Website</option>
                    <option>Reels</option>
                  </select>
                </label>
              </section>
              <section className="panel">
                <h2>Your products</h2>
                <p className="muted">
                  Use your own photos. Prices and collection details will stay
                  consistent across the campaign.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={rights}
                    onChange={(e) => setRights(e.target.checked)}
                  />
                  I own or have permission to use these images.
                </label>
                <label className="upload">
                  ＋ Add product photo
                  <input
                    aria-label="Product photo"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={
                      !rights || !!busy || form.facts.products.length >= 6
                    }
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) run("Uploading photo", () => upload(f));
                      e.target.value = "";
                    }}
                  />
                </label>
                {form.facts.products.map((p, i) => (
                  <div className="product-edit" key={p.id}>
                    <img src={`/api/v1/assets/${p.assetId}`} alt={p.name} />
                    <div>
                      <label>
                        Product name
                        <input
                          value={p.name}
                          onChange={(e) =>
                            setProduct(i, "name", e.target.value)
                          }
                        />
                      </label>
                      <div className="two">
                        <label>
                          Price
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={p.priceMinor / 100}
                            onChange={(e) =>
                              setProduct(
                                i,
                                "priceMinor",
                                Math.round(Number(e.target.value) * 100),
                              )
                            }
                          />
                        </label>
                        <label>
                          Currency
                          <select
                            value={p.currency}
                            onChange={(e) =>
                              setProduct(i, "currency", e.target.value)
                            }
                          >
                            {["INR", "USD", "EUR", "GBP"].map((v) => (
                              <option key={v}>{v}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <button
                        className="text-button"
                        onClick={() =>
                          editFacts(
                            "products",
                            form.facts.products.filter((_, j) => i !== j),
                          )
                        }
                      >
                        Remove product
                      </button>
                      <button
                        className="text-button"
                        disabled={i === 0}
                        onClick={() => {
                          const products = [...form.facts.products];
                          [products[i - 1], products[i]] = [
                            products[i],
                            products[i - 1],
                          ];
                          editFacts("products", products);
                        }}
                      >
                        Move earlier in site & reel
                      </button>
                    </div>
                  </div>
                ))}
              </section>
              <div className="action-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I confirm these prices, dates, images and business facts.
                </label>
                <button
                  disabled={
                    !!busy || !confirmed || (!!selectedWhatsappDraft && !rights)
                  }
                  onClick={() => run("Saving facts", save)}
                >
                  Save facts & continue →
                </button>
              </div>
            </div>
          )}
          {stage === 1 &&
            (c ? (
              <>
                <div className="two">
                  <section className="panel">
                    <p className="eyebrow">WEBSITE</p>
                    <h2>A layout for your collection</h2>
                    <div className="choice-row">
                      {(["editorial", "catalog", "minimal"] as const).map(
                        (v) => (
                          <button
                            className={
                              form.layout === v ? "selected" : "secondary"
                            }
                            key={v}
                            onClick={() => setForm({ ...form, layout: v })}
                          >
                            {v}
                          </button>
                        ),
                      )}
                    </div>
                    <p className="muted">
                      Editorial gives the offer room. Catalog puts products
                      first. Minimal keeps the focus on essentials.
                    </p>
                  </section>
                  <section className="panel">
                    <p className="eyebrow">REEL</p>
                    <h2>Set the visual tone</h2>
                    <div className="choice-row">
                      {(["warm", "bold"] as const).map((v) => (
                        <button
                          className={
                            form.reelStyle === v ? "selected" : "secondary"
                          }
                          key={v}
                          onClick={() => setForm({ ...form, reelStyle: v })}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                    <p className="muted">
                      A vertical motion reel with camera movement, animated
                      details, and transitions, built from your actual photos.
                      No synthetic products or unlicensed music.
                    </p>
                  </section>
                </div>
                <MetaLens campaign={c} />
                <div className="panel connection">
                  <div>
                    <h2>Campaign intelligence</h2>
                    <p>
                      {caps.muse?.available
                        ? "Muse models are reachable through the Meta Model API gateway; a per-campaign call cap applies."
                        : "Muse gateway is not reachable or has no key. Start the gateway and set MODEL_API_KEY to use AI planning."}
                    </p>
                  </div>
                  <span className="pill">
                    {caps.muse?.available ? "Ready" : "Access needed"}
                  </span>
                </div>
                <div className="action-row">
                  <span className="muted">
                    This generation uses {caps.credits?.costs?.[c.mode] ?? "—"}{" "}
                    credits. Failed renders are refunded.
                  </span>
                  <button
                    className="secondary"
                    disabled={!!busy || c.state === "Generating"}
                    onClick={() =>
                      run("Creating outputs", async () => {
                        let current = c;
                        if (
                          form.layout !== c.layout ||
                          form.reelStyle !== c.reelStyle
                        ) {
                          current = await api(
                            `/campaigns/${c.id}`,
                            { ...form, revision: c.revision },
                            "PUT",
                          );
                          setC(current);
                        }
                        setC(
                          await api(`/campaigns/${current.id}/generate`, {
                            mode: "manual",
                          }),
                        );
                        setCaps(await api("/capabilities"));
                        setStage(2);
                      })
                    }
                  >
                    Render confirmed facts
                  </button>
                  <button
                    disabled={
                      !!busy ||
                      !caps.muse?.available ||
                      c.state === "Generating"
                    }
                    onClick={() =>
                      run("Planning with Muse Wonder", async () => {
                        setC(
                          await api(`/campaigns/${c.id}/generate`, {
                            mode: "muse",
                          }),
                        );
                        setCaps(await api("/capabilities"));
                        setStage(2);
                      })
                    }
                  >
                    Plan with Muse Wonder →
                  </button>
                </div>
                <p className="muted">
                  “Render confirmed facts” uses deterministic templates. It is
                  not an AI model run.
                </p>
              </>
            ) : (
              <Empty
                text="Save your business facts first."
                action={() => setStage(0)}
              />
            ))}
          {(stage === 2 || stage === 3) &&
            c &&
            (c.site || c.state === "Generating") && (
              <SayIt
                campaign={c}
                link={sayLink}
                disabled={
                  !!busy || ["Generating", "Publishing"].includes(c.state)
                }
                onApplied={(next) => {
                  setC(next);
                  setApprovalDigest("");
                  setStage(3);
                }}
                onPreflight={setPreflight}
              />
            )}
          {stage === 2 &&
            (c?.site ? (
              <>
                <div className="preview-toolbar">
                  <h2>Website preview</h2>
                  <div>
                    <button
                      className={!mobile ? "selected" : "secondary"}
                      onClick={() => setMobile(false)}
                    >
                      Desktop
                    </button>
                    <button
                      className={mobile ? "selected" : "secondary"}
                      onClick={() => setMobile(true)}
                    >
                      Mobile
                    </button>
                  </div>
                </div>
                <div
                  className={mobile ? "site-preview mobile" : "site-preview"}
                >
                  <Site spec={c.site} />
                </div>
                <div className="review-bottom">
                  <section>
                    <h2>Final reel</h2>
                    {c.videoAssetId ? (
                      <AutoReel
                        aria-label="Final reel preview, muted loop"
                        onError={() =>
                          setError(
                            "This browser cannot preview the final video. Open this workspace in Chrome to review it.",
                          )
                        }
                        controls
                        poster={
                          c.videoPosterId
                            ? `/api/v1/assets/${c.videoPosterId}`
                            : undefined
                        }
                        preload="metadata"
                        src={`/api/v1/assets/${c.videoAssetId}`}
                      />
                    ) : (
                      <p className="muted">
                        {c.state === "Generating"
                          ? "Encoding your reel…"
                          : c.mode === "Website"
                            ? "Website-only campaign."
                            : "No encoded reel yet. Return to Create."}
                      </p>
                    )}
                  </section>
                  <section className="panel">
                    <h2>Caption & collection</h2>
                    <pre>{c.reel?.caption}</pre>
                    <p className="muted">
                      Edit business facts to update the website, reel and
                      caption together. Every edit requires a fresh approval.
                    </p>
                    <button className="secondary" onClick={() => setStage(0)}>
                      Edit facts
                    </button>
                    <button
                      disabled={c.state === "Generating"}
                      onClick={() => setStage(3)}
                    >
                      Review publication →
                    </button>
                  </section>
                </div>
                <MetaLens campaign={c} />
              </>
            ) : (
              <Empty
                text={
                  c?.state === "Generating"
                    ? "Your outputs are rendering. This page updates when the final file is ready."
                    : "No outputs to review yet."
                }
                action={() => setStage(1)}
              />
            ))}
          {stage === 3 &&
            (c ? (
              <>
                <div className="two">
                  <section className="panel">
                    <h2>Website destination</h2>
                    <p>
                      {c.mode === "Reels"
                        ? "Not selected"
                        : `${location.origin}/sites/${c.id}`}
                    </p>
                    <p className="muted">
                      Local hosting is available now. Public reachability
                      requires an authorized HTTPS deployment.
                    </p>
                  </section>
                  <section className="panel">
                    <h2>Your business Instagram</h2>
                    {caps.connections.filter((x: any) => x.active).length ? (
                      <>
                        <label>
                          Publish to
                          <select
                            value={account}
                            onChange={(e) => {
                              setAccount(e.target.value);
                              setApprovalDigest("");
                            }}
                          >
                            <option value="">Select connected account</option>
                            {caps.connections
                              .filter((x: any) => x.active)
                              .map((x: any) => (
                                <option key={x.accountId} value={x.accountId}>
                                  @{x.username}
                                </option>
                              ))}
                          </select>
                        </label>
                        {account && (
                          <button
                            className="text-button"
                            onClick={() =>
                              run("Disconnecting", async () => {
                                await api(
                                  `/connections/${account}/disconnect`,
                                  {},
                                );
                                setAccount("");
                                await load();
                                setC(await api(`/campaigns/${c.id}`));
                              })
                            }
                          >
                            Disconnect selected account
                          </button>
                        )}
                      </>
                    ) : (
                      <p>No Instagram account connected.</p>
                    )}
                    <button
                      className="secondary"
                      disabled={!caps.instagram || !!busy}
                      onClick={() =>
                        run("Connecting Instagram", async () => {
                          const result = await api("/oauth/start", {});
                          location.href = result.url;
                        })
                      }
                    >
                      Connect your business Instagram ↗
                    </button>
                    <p className="muted">
                      Sign in on Meta and choose the professional account you
                      want this workspace to publish to. Axys never collects
                      your Instagram password.
                    </p>
                  </section>
                </div>
                <PreflightPanel
                  campaign={c}
                  state={preflight}
                  onResult={setPreflight}
                />
                <RedPen
                  campaign={c}
                  state={preflight}
                  onResult={setPreflight}
                  regenerate={regenerateForFix}
                  {...sayLink.redpen}
                />
                <section className="panel">
                  <h2>Approve this exact version</h2>
                  <p>
                    Version {c.revision} · {c.mode} · {c.facts.collection}
                  </p>
                  <label>
                    Publish time (leave empty for now)
                    <input
                      type="datetime-local"
                      value={
                        schedule && !schedule.endsWith("Z") ? schedule : ""
                      }
                      onChange={(e) => {
                        setSchedule(e.target.value);
                        setApprovalDigest("");
                      }}
                    />
                  </label>
                  <p className="muted">
                    Approval binds the website, final video, caption, selected
                    account and time. Caption URLs may not be clickable;
                    configure your profile link separately.
                  </p>
                  <div className="choice-row">
                    <button
                      className="secondary"
                      disabled={!!busy}
                      onClick={() => run("Preparing review", prepareApproval)}
                    >
                      Prepare exact-version review
                    </button>
                    {preflightBlocked && (
                      <p className="approve-block" id="approve-block-reason">
                        Approval is disabled: preflight found{" "}
                        {blockCount(preflight, c)} blocking issue
                        {blockCount(preflight, c) > 1 ? "s" : ""}. Fix the facts
                        or outputs, then re-run preflight above.
                      </p>
                    )}
                    {(approvalDigest || preflightBlocked) && (
                      <button
                        aria-disabled={preflightBlocked || undefined}
                        aria-describedby={
                          preflightBlocked ? "approve-block-reason" : undefined
                        }
                        onClick={() =>
                          !preflightBlocked &&
                          run("Approving version", async () =>
                            setC(
                              await api(`/campaigns/${c.id}/approve`, {
                                digest: approvalDigest,
                                accountId: account,
                                schedule: new Date(schedule).toISOString(),
                              }),
                            ),
                          )
                        }
                      >
                        I approve this version & account
                      </button>
                    )}
                    <button
                      disabled={!c.approval || !!busy}
                      onClick={() =>
                        run("Starting publication", async () => {
                          setC(
                            await api(`/campaigns/${c.id}/publish`, {
                              approvalId: c.approval!.id,
                            }),
                          );
                        })
                      }
                    >
                      Publish approved campaign →
                    </button>
                  </div>
                </section>
                {c.attempt && (
                  <section className="panel">
                    <h2>Publication receipts</h2>
                    <p>
                      Website: <strong>{c.attempt.site}</strong>{" "}
                      {c.attempt.siteUrl && (
                        <a
                          href={c.attempt.siteUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open website ↗
                        </a>
                      )}
                    </p>
                    <p>
                      Instagram: <strong>{c.attempt.social}</strong>{" "}
                      {c.attempt.permalink && (
                        <a
                          href={c.attempt.permalink}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open post ↗
                        </a>
                      )}
                    </p>
                    {c.attempt.error && (
                      <p className="error">{c.attempt.error}</p>
                    )}
                    <button
                      className="secondary"
                      onClick={() =>
                        run("Checking existing publication", async () =>
                          setC(await api(`/campaigns/${c.id}/reconcile`, {})),
                        )
                      }
                    >
                      Reconcile existing attempt
                    </button>
                    <button className="text-button" onClick={() => setStage(4)}>
                      View results →
                    </button>
                  </section>
                )}
              </>
            ) : (
              <Empty
                text="Create and review a campaign first."
                action={() => setStage(0)}
              />
            ))}
          {stage === 4 &&
            (c ? (
              <>
                <div className="action-row">
                  <button
                    className="secondary"
                    onClick={() =>
                      run("Loading results", async () => {
                        const [nextMetrics] = await Promise.all([
                          api(`/campaigns/${c.id}/metrics`),
                          loadCrm(c.id),
                        ]);
                        setMetrics(nextMetrics);
                      })
                    }
                  >
                    Load available results
                  </button>
                  <button
                    className="secondary"
                    disabled={!c.attempt?.mediaId}
                    onClick={() =>
                      run("Retrieving Instagram insights", async () =>
                        setMetrics(await api(`/campaigns/${c.id}/metrics`, {})),
                      )
                    }
                  >
                    Refresh Instagram insights
                  </button>
                </div>
                <section className="panel funnel-panel">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">CAMPAIGN FUNNEL</p>
                      <h2>From attention to recorded fulfilment</h2>
                    </div>
                    <span className="muted">
                      {crmSummary ? "Latest CRM snapshot" : "Not loaded"}
                    </span>
                  </div>
                  <div className="funnel-grid" aria-label="Campaign funnel">
                    <div>
                      <span>Visits</span>
                      <strong>{countText(crmSummary?.visits)}</strong>
                    </div>
                    <div>
                      <span>Contact actions</span>
                      <strong>{countText(crmSummary?.contactActions)}</strong>
                    </div>
                    <div>
                      <span>Leads</span>
                      <strong>{countText(crmSummary?.leads)}</strong>
                    </div>
                    <div>
                      <span>Ordered</span>
                      <strong>{countText(crmSummary?.ordered)}</strong>
                    </div>
                    <div>
                      <span>Fulfilled</span>
                      <strong>{countText(crmSummary?.fulfilled)}</strong>
                    </div>
                    <div className="revenue-stat">
                      <span>Recorded revenue</span>
                      <strong>{revenueText(crmSummary)}</strong>
                    </div>
                  </div>
                  <p className="muted evidence-note">
                    Visits and contact actions are observed events. Leads,
                    orders, fulfilment and revenue are merchant-recorded CRM
                    entries; they are not payment-provider proof or verified
                    sales lift.
                  </p>
                </section>
                <div className="two">
                  <section className="panel">
                    <p className="eyebrow">WEBSITE</p>
                    <h2>Visits & contact clicks</h2>
                    {metrics?.website?.length ? (
                      metrics.website.map((m: any) => (
                        <p key={m.kind}>
                          {m.kind}: <strong>{m.value}</strong>
                          <br />
                          <small>Last event: {m.observedAt}</small>
                        </p>
                      ))
                    ) : (
                      <p>Unknown — no recorded events.</p>
                    )}
                    <p className="muted">
                      These events do not establish purchases or sales lift.
                      Automated traffic may be included.
                    </p>
                  </section>
                  <section className="panel">
                    <p className="eyebrow">INSTAGRAM</p>
                    <h2>Available insights</h2>
                    {metrics?.instagram?.data ? (
                      <pre>{JSON.stringify(metrics.instagram, null, 2)}</pre>
                    ) : (
                      <p>
                        Unknown —{" "}
                        {metrics?.instagram?.reason ||
                          "no confirmed insights retrieved."}
                      </p>
                    )}
                  </section>
                </div>
                <section className="panel crm-panel">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">LEAD RECORD</p>
                      <h2>Follow up without overstating sales</h2>
                    </div>
                    <span className="muted">
                      {campaignLeads
                        ? `${campaignLeads.length} for this campaign`
                        : "Not loaded"}
                    </span>
                  </div>
                  <form
                    className="lead-create"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run("Adding lead", async () => {
                        await api("/crm/leads", {
                          campaignId: c.id,
                          source: "merchant",
                          customerLabel: leadLabel.trim() || undefined,
                          consent: leadConsent,
                          idempotencyKey: crypto.randomUUID(),
                        });
                        setLeadLabel("");
                        setLeadConsent(false);
                        await loadCrm(c.id);
                        setNotice("Lead recorded for this campaign.");
                      });
                    }}
                  >
                    <label>
                      Customer label
                      <input
                        value={leadLabel}
                        onChange={(event) => setLeadLabel(event.target.value)}
                        placeholder="Example: Saturday enquiry 03"
                        maxLength={100}
                        required
                      />
                    </label>
                    <p className="muted">
                      Use a non-sensitive internal label. Do not enter a phone
                      number or other private contact detail here.
                    </p>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={leadConsent}
                        onChange={(event) =>
                          setLeadConsent(event.target.checked)
                        }
                        required
                      />
                      I have a lawful reason to record and follow up this lead.
                    </label>
                    <button disabled={!leadConsent || !!busy}>
                      Add campaign lead
                    </button>
                  </form>
                  {campaignLeads === undefined ? (
                    <p>Unknown — load available results to retrieve leads.</p>
                  ) : campaignLeads.length === 0 ? (
                    <p className="muted">
                      No merchant-recorded leads for this campaign yet.
                    </p>
                  ) : (
                    <div className="lead-list">
                      {campaignLeads.map((lead) => {
                        const action = leadAction(lead);
                        return (
                          <article className="lead-card" key={lead.id}>
                            <div className="lead-title">
                              <div>
                                <strong>
                                  {lead.customerLabel || "Unlabelled lead"}
                                </strong>
                                <small>
                                  Current status: {statusText(lead.status)}
                                </small>
                              </div>
                              <span className="pill">
                                {statusText(lead.status)}
                              </span>
                            </div>
                            <div className="lead-controls">
                              {leadTransitions[lead.status].length ? (
                                <label>
                                  Next status
                                  <select
                                    value={action.status}
                                    onChange={(event) =>
                                      changeLeadAction(lead, {
                                        status: event.target
                                          .value as LeadStatus,
                                      })
                                    }
                                  >
                                    <option value="">Choose next status</option>
                                    {leadTransitions[lead.status].map(
                                      (status) => (
                                        <option key={status} value={status}>
                                          {statusText(status)}
                                        </option>
                                      ),
                                    )}
                                  </select>
                                </label>
                              ) : (
                                <p className="muted terminal-status">
                                  No further status action is available.
                                </p>
                              )}
                              <label>
                                Status note (optional)
                                <input
                                  value={action.note}
                                  onChange={(event) =>
                                    changeLeadAction(lead, {
                                      note: event.target.value,
                                    })
                                  }
                                  maxLength={300}
                                  placeholder="Keep this factual and brief"
                                />
                              </label>
                            </div>
                            {action.status === "Ordered" ? (
                              <div className="order-controls">
                                <label>
                                  Order amount (optional)
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    inputMode="decimal"
                                    value={action.amount}
                                    onChange={(event) =>
                                      changeLeadAction(lead, {
                                        amount: event.target.value,
                                      })
                                    }
                                    placeholder="Leave blank if unknown"
                                  />
                                </label>
                                <label>
                                  Currency
                                  <select
                                    value={action.currency}
                                    onChange={(event) =>
                                      changeLeadAction(lead, {
                                        currency: event.target
                                          .value as Currency,
                                      })
                                    }
                                  >
                                    {currencies.map((currency) => (
                                      <option key={currency}>{currency}</option>
                                    ))}
                                  </select>
                                </label>
                                <button
                                  disabled={!!busy}
                                  onClick={() =>
                                    run("Recording order", async () => {
                                      const amount = action.amount.trim();
                                      await api(
                                        `/crm/leads/${lead.id}/orders`,
                                        {
                                          ...(amount
                                            ? {
                                                amountMinor: Math.round(
                                                  Number(amount) * 100,
                                                ),
                                                currency: action.currency,
                                              }
                                            : {}),
                                          idempotencyKey: crypto.randomUUID(),
                                        },
                                      );
                                      await loadCrm(c.id);
                                      setNotice(
                                        "Order recorded from the merchant's entry; no payment was verified.",
                                      );
                                    })
                                  }
                                  type="button"
                                >
                                  Record merchant-reported order
                                </button>
                              </div>
                            ) : (
                              <button
                                className="secondary"
                                disabled={!action.status || !!busy}
                                onClick={() =>
                                  run("Updating lead", async () => {
                                    await api(`/crm/leads/${lead.id}/status`, {
                                      status: action.status,
                                      note: action.note.trim() || undefined,
                                      idempotencyKey: crypto.randomUUID(),
                                    });
                                    await loadCrm(c.id);
                                    setNotice("Lead status updated.");
                                  })
                                }
                                type="button"
                              >
                                Save status
                              </button>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>
                <section className="panel">
                  <h2>What should change next?</h2>
                  <p>
                    Muse Wonder proposes a revision grounded in the available
                    observations. You review and approve any new campaign.
                  </p>
                  <button
                    disabled={!caps.muse?.available || !!busy}
                    onClick={() =>
                      run("Reviewing observations", async () =>
                        setProposal(
                          await api(`/campaigns/${c.id}/revision`, {}),
                        ),
                      )
                    }
                  >
                    Propose a revision
                  </button>
                  {proposal && <p>{proposal.proposal.suggestion}</p>}
                </section>
              </>
            ) : (
              <Empty
                text="Results appear after a campaign has been created."
                action={() => setStage(0)}
              />
            ))}
        </div>
        <footer className="studio-footer">
          Axys · One campaign, connected surfaces.
          <span>
            {caps.muse?.available
              ? "Meta Muse gateway connected"
              : "Meta Muse gateway not connected"}
          </span>
        </footer>
      </main>
    </div>
  );
}
function Empty({ text, action }: { text: string; action: () => void }) {
  return (
    <section className="empty">
      <h2>{text}</h2>
      <button className="secondary" onClick={action}>
        Continue creating →
      </button>
    </section>
  );
}
function App() {
  const q = new URLSearchParams(window.location.search);
  const studio = q.has("studio") || q.has("fixture");
  if (SCENARIO_STALE) return <RedPenDemo />;
  if (SCENARIO_COMMAND) return <CommandDemo />;
  return window.location.pathname === "/" && !studio ? (
    <Landing />
  ) : (
    <StudioApp />
  );
}
createRoot(document.getElementById("root")!).render(<App />);
