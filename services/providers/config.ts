import { isIP } from "node:net";

export type Check = {
  name: string;
  status: "pass" | "blocked" | "warning";
  detail: string;
};

const value = (env: NodeJS.ProcessEnv, name: string) => env[name]?.trim() || "";

export function isPublicHttpsOrigin(raw: string) {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local")) return false;
    const ip = isIP(host.replace(/^\[|\]$/g, ""));
    if (ip === 4) {
      const [a, b] = host.split(".").map(Number);
      if (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a >= 224
      )
        return false;
    }
    if (ip === 6) {
      const bare = host.replace(/^\[|\]$/g, "");
      if (
        bare === "::" ||
        bare === "::1" ||
        /^f[cd]/i.test(bare) ||
        /^fe[89ab]/i.test(bare)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Muse gateway configuration. Everything is optional: with no variables the
 * app boots and AI features report `available: false` instead of failing.
 * The model API key lives only in the gateway process, never here.
 */
export function museChecks(env: NodeJS.ProcessEnv = process.env): Check[] {
  const raw = value(env, "MUSE_GATEWAY_URL");
  if (!raw)
    return [
      {
        name: "muse.gateway-url",
        status: "pass",
        detail: "Using the default gateway http://127.0.0.1:8766.",
      },
    ];
  let valid = false;
  try {
    const url = new URL(raw);
    valid =
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {}
  return [
    {
      name: "muse.gateway-url",
      status: valid ? "pass" : "blocked",
      detail: valid
        ? "MUSE_GATEWAY_URL is an http(s) URL."
        : "MUSE_GATEWAY_URL must be an http(s) URL without credentials, query or fragment.",
    },
  ];
}

export function metaChecks(env: NodeJS.ProcessEnv = process.env): Check[] {
  const names = [
    "META_APP_ID",
    "META_APP_SECRET",
    "META_API_VERSION",
    "META_REDIRECT_URI",
    "META_INSIGHT_METRICS",
  ];
  const missing = names.filter((name) => !value(env, name));
  const checks: Check[] = [
    {
      name: "meta.configuration",
      status: missing.length ? "blocked" : "pass",
      detail: missing.length
        ? `Missing ${missing.join(", ")}`
        : "Instagram Login values are present; secrets were not displayed.",
    },
  ];
  if (missing.length) return checks;
  const version = value(env, "META_API_VERSION");
  checks.push({
    name: "meta.api-version",
    status: /^v\d+\.0$/.test(version) ? "pass" : "blocked",
    detail: /^v\d+\.0$/.test(version)
      ? `Configured Graph API version: ${version}; confirm its support window in the Meta app dashboard.`
      : "META_API_VERSION must look like v24.0 and must be verified in the app dashboard.",
  });
  const origin = value(env, "AXYS_ORIGIN");
  const expected = origin
    ? `${origin.replace(/\/$/, "")}/api/v1/oauth/callback`
    : "";
  checks.push({
    name: "meta.redirect",
    status:
      isPublicHttpsOrigin(origin) &&
      value(env, "META_REDIRECT_URI") === expected
        ? "pass"
        : "blocked",
    detail:
      isPublicHttpsOrigin(origin) &&
      value(env, "META_REDIRECT_URI") === expected
        ? "OAuth callback exactly matches the public Axys origin."
        : "Use a public HTTPS AXYS_ORIGIN and set META_REDIRECT_URI to its exact /api/v1/oauth/callback URL.",
  });
  const metrics = value(env, "META_INSIGHT_METRICS");
  checks.push({
    name: "meta.metrics",
    status: /^[a-z_]+(?:,[a-z_]+)*$/.test(metrics) ? "pass" : "blocked",
    detail: /^[a-z_]+(?:,[a-z_]+)*$/.test(metrics)
      ? "Insight metric names are syntactically valid; availability still depends on media type and API version."
      : "META_INSIGHT_METRICS must be a comma-separated list of lowercase metric names.",
  });
  return checks;
}

export function deploymentChecks(
  env: NodeJS.ProcessEnv = process.env,
): Check[] {
  const origin = value(env, "AXYS_ORIGIN");
  const tokenKey = value(env, "AXYS_TOKEN_KEY");
  let tokenBytes = 0;
  try {
    tokenBytes = Buffer.from(tokenKey, "base64").length;
  } catch {}
  const access = value(env, "AXYS_ACCESS_KEYS").split(",").filter(Boolean);
  return [
    {
      name: "deployment.runtime",
      status: value(env, "NODE_ENV") === "production" ? "pass" : "blocked",
      detail:
        value(env, "NODE_ENV") === "production"
          ? "Production runtime mode is selected."
          : "Set NODE_ENV=production before public deployment.",
    },
    {
      name: "deployment.origin",
      status: isPublicHttpsOrigin(origin) ? "pass" : "blocked",
      detail: isPublicHttpsOrigin(origin)
        ? `Public origin: ${origin}`
        : "AXYS_ORIGIN must be a public HTTPS origin with no path, credentials, query or fragment.",
    },
    {
      name: "deployment.storage",
      status: value(env, "AXYS_DATA_DIR") ? "pass" : "blocked",
      detail: value(env, "AXYS_DATA_DIR")
        ? "A data directory is configured; the operator must mount it as persistent storage and back it up."
        : "AXYS_DATA_DIR is required for an explicit persistent production volume.",
    },
    {
      name: "deployment.keys",
      status:
        tokenBytes === 32 &&
        value(env, "AXYS_MEDIA_KEY").length >= 32 &&
        access.length > 0 &&
        access.every((entry) =>
          /^[A-Za-z0-9_-]{1,64}:[a-f0-9]{64}$/.test(entry),
        )
          ? "pass"
          : "blocked",
      detail:
        tokenBytes === 32 &&
        value(env, "AXYS_MEDIA_KEY").length >= 32 &&
        access.length > 0 &&
        access.every((entry) =>
          /^[A-Za-z0-9_-]{1,64}:[a-f0-9]{64}$/.test(entry),
        )
          ? "Encryption, media-signing and hashed tenant access keys are configured."
          : "Require a 32-byte base64 AXYS_TOKEN_KEY, 32+ character AXYS_MEDIA_KEY, and tenant:sha256 AXYS_ACCESS_KEYS.",
    },
  ];
}
