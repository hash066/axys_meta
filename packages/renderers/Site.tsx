import React from "react";
import type { SiteSpec } from "../campaign/index.ts";
const price = (p: SiteSpec["facts"]["products"][number]) =>
  p.currency + " " + (p.priceMinor / 100).toFixed(2);
export function Site({
  spec,
  assetUrl = (id: string) => `/api/v1/assets/${id}`,
  contactUrl,
}: {
  spec: SiteSpec;
  assetUrl?: (id: string) => string;
  contactUrl?: string;
}) {
  return (
    <main className={`merchant-site ${spec.layout}`}>
      <header>
        <span>{spec.facts.business}</span>
        <a href="#collection">Explore collection</a>
      </header>
      <section className="site-hero">
        <p>MADE FOR YOUR MOMENTS</p>
        <h1>{spec.headline}</h1>
        {spec.facts.message && <p>{spec.facts.message}</p>}
        <p>{spec.facts.collection}</p>
        <a
          className="site-cta"
          href={contactUrl || spec.facts.contact}
          target="_blank"
          rel="noreferrer"
        >
          Enquire about this offer ↗
        </a>
      </section>
      <section className="products" id="collection">
        {spec.facts.products.map((p) => (
          <article key={p.id}>
            <img src={assetUrl(p.assetId)} alt={p.name} />
            <div>
              <h2>{p.name}</h2>
              <p>{price(p)}</p>
            </div>
          </article>
        ))}
      </section>
      <footer>
        <strong>{spec.facts.business}</strong>
        <p>
          {spec.facts.offer} · {spec.facts.collection}
        </p>
        <small>Contact the merchant to confirm availability.</small>
      </footer>
    </main>
  );
}
