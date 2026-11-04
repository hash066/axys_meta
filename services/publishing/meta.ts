import { required } from "../../server/security.ts";
export type Connection = {
  id: string;
  tenantId: string;
  accountId: string;
  username: string;
  token: string;
  expiresAt: number;
  active: boolean;
};
export class MetaRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "MetaRequestError";
  }
}
export class Meta {
  constructor(
    private token: string,
    private transport: typeof fetch = fetch,
  ) {}
  async request(
    path: string,
    params: Record<string, string> = {},
    method = "GET",
  ): Promise<any> {
    const version = required("META_API_VERSION");
    if (
      !/^v\d+\.0$/.test(version) ||
      !/^\d+(\/(media|media_publish|insights|permissions))?$|^me$/.test(path)
    )
      throw new Error("Invalid Meta API configuration");
    const u = new URL(`https://graph.instagram.com/${version}/${path}`);
    if (method === "GET") u.search = new URLSearchParams(params).toString();
    const r = await this.transport(u, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
      body: method === "GET" ? undefined : new URLSearchParams(params),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const retry = Number(r.headers.get("retry-after"));
      throw new MetaRequestError(
        body.error?.code === 190
          ? "Instagram access expired or revoked. Reconnect."
          : r.status === 429
            ? "Instagram rate limit reached. Wait before reconciling this request."
            : r.status >= 500
              ? `Instagram is temporarily unavailable (${r.status}). Reconcile before retrying.`
              : `Instagram rejected the request (${r.status}). Check account permissions and API configuration.`,
        r.status,
        Number.isFinite(retry) && retry >= 0 ? retry : undefined,
        r.headers.get("x-fb-request-id") || undefined,
      );
    }
    return r.json();
  }
  create(account: string, url: string, caption: string) {
    if (!/^\d+$/.test(account))
      throw new Error("Invalid Instagram account identifier");
    const media = new URL(url);
    if (media.protocol !== "https:" || media.username || media.password)
      throw new Error("Instagram media URL must use public HTTPS");
    if (!caption.trim() || caption.length > 2200)
      throw new Error("Instagram caption must contain 1 to 2200 characters");
    return this.request(
      `${account}/media`,
      { media_type: "REELS", video_url: url, caption },
      "POST",
    );
  }
  status(container: string) {
    return this.request(container, { fields: "status_code,status" });
  }
  publish(account: string, container: string) {
    if (!/^\d+$/.test(account) || !/^\d+$/.test(container))
      throw new Error("Invalid Instagram publication identifier");
    return this.request(
      `${account}/media_publish`,
      { creation_id: container },
      "POST",
    );
  }
  receipt(media: string) {
    return this.request(media, { fields: "id,permalink,timestamp" });
  }
  insights(media: string, metrics: string) {
    if (!/^[a-z_,]+$/.test(metrics))
      throw new Error("Configure verified insight metrics");
    return this.request(`${media}/insights`, { metric: metrics });
  }
}
export function oauthUrl(state: string) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(state))
    throw new Error("Invalid OAuth state");
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.search = new URLSearchParams({
    client_id: required("META_APP_ID"),
    redirect_uri: required("META_REDIRECT_URI"),
    response_type: "code",
    scope:
      "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights",
    state,
    enable_fb_login: "0",
    force_authentication: "1",
  }).toString();
  return u.toString();
}
export async function exchange(code: string) {
  const response = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: required("META_APP_ID"),
      client_secret: required("META_APP_SECRET"),
      grant_type: "authorization_code",
      redirect_uri: required("META_REDIRECT_URI"),
      code,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("Instagram code exchange failed");
  const short = (await response.json()) as any;
  const u = new URL("https://graph.instagram.com/access_token");
  u.search = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: required("META_APP_SECRET"),
    access_token: short.access_token,
  }).toString();
  const long = await fetch(u, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!long.ok) throw new Error("Instagram long-lived token exchange failed");
  return long.json() as Promise<{ access_token: string; expires_in: number }>;
}
export async function refresh(token: string) {
  const u = new URL("https://graph.instagram.com/refresh_access_token");
  u.search = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: token,
  }).toString();
  const r = await fetch(u, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("Instagram refresh failed; reconnect");
  return r.json() as Promise<{ access_token: string; expires_in: number }>;
}
