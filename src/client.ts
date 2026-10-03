import { Impit } from "impit";
import { loadSession, updateSession, type Session } from "./session";

const BASE = "https://blinkit.com";

/**
 * Blinkit sits behind Cloudflare bot-management that blocks clients whose TLS
 * (JA3/JA4) handshake is not browser-like: plain `fetch`/`undici`/curl get a 403
 * HTML page. `impit` performs a Chrome-impersonating TLS handshake, so every
 * request passes with no browser, no `__cf_bm` cookie, and no challenge solve.
 * This is the keystone that keeps the runtime path browser-free.
 */
const impit = new Impit({ browser: "chrome" });

/**
 * The web app calls GET /v2/accounts/auth_key/ with a *fixed* `req_key`
 * (s.config.requestKey in the bundle). A random UUID returns 400 — this exact
 * constant is required. Override via BLINKIT_REQ_KEY if Blinkit rotates it.
 */
export const REQ_KEY =
  process.env.BLINKIT_REQ_KEY ?? "c0e6868e-1180-400c-be51-f473479f1f0a";

/** Constant consumer-web client identity headers. Not signed by Blinkit. */
const STATIC_HEADERS: Record<string, string> = {
  app_client: "consumer_web",
  platform: "desktop_web",
  web_app_version: "1008010016",
  rn_bundle_version: "1009003012",
  app_version: "52434332",
  "x-age-consent-granted": "false",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
};

export class BlinkitError extends Error {
  constructor(
    message: string,
    public status = 0,
    public body?: unknown,
  ) {
    super(message);
    this.name = "BlinkitError";
  }
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body (content-type: application/json). */
  json?: unknown;
  /** Form body (content-type: application/x-www-form-urlencoded). */
  form?: Record<string, string | number>;
  /** Extra one-off headers. */
  headers?: Record<string, string>;
  /** Whether to attach the user access_token header (default: true). */
  authed?: boolean;
}

function buildUrl(path: string, query?: RequestOpts["query"]): string {
  const url = new URL(path.startsWith("http") ? path : BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * The single low-level request helper. Injects the standard Blinkit header set
 * (auth_key, device_id, session_uuid, lat/lon, client identity) so every tool
 * stays thin. No browser involved — plain HTTPS via impit.
 */
export async function request<T = any>(
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const s = await loadSession();
  const headers: Record<string, string> = {
    ...STATIC_HEADERS,
    device_id: s.device_id,
    session_uuid: s.session_uuid,
    referer: BASE + "/",
    origin: BASE,
  };

  if (s.auth_key) headers.auth_key = s.auth_key;
  if (s.location) {
    headers.lat = String(s.location.lat);
    headers.lon = String(s.location.lon);
  }

  // Only send access_token when we actually have one. The web app sends the
  // literal string "null" when logged out, but /visibility rejects that with 401.
  const wantAuth = opts.authed ?? true;
  if (wantAuth && s.access_token) headers.access_token = s.access_token;

  // `gr_1_accessToken` is validated as a cookie (not just a header) by some
  // checkout endpoints; gr_1_deviceId mirrors the device header.
  const cookies = [`gr_1_deviceId=${s.device_id}`];
  if (wantAuth && s.access_token) {
    cookies.push(`gr_1_accessToken=${encodeURIComponent(s.access_token)}`);
  }
  headers.cookie = cookies.join("; ");

  let body: string | undefined;
  if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(
      Object.fromEntries(Object.entries(opts.form).map(([k, v]) => [k, String(v)])),
    ).toString();
  } else if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if ((opts.method ?? "GET") === "POST") {
    headers["content-type"] = "application/json";
  }

  Object.assign(headers, opts.headers);

  const res = await impit.fetch(buildUrl(path, opts.query), {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }

  if (res.status >= 400) {
    throw new BlinkitError(`Blinkit ${res.status} on ${path}`, res.status, parsed);
  }
  return parsed as T;
}

/**
 * Ensure we have a device `auth_key`. Cheap and login-free; called before any
 * catalog/cart/auth call.
 */
export async function ensureAuthKey(): Promise<string> {
  const s = await loadSession();
  if (s.auth_key) return s.auth_key;
  const res = await request<{ success: boolean; auth_key: string }>(
    "/v2/accounts/auth_key/",
    { headers: { req_key: REQ_KEY }, authed: false },
  );
  if (!res?.auth_key) throw new BlinkitError("Failed to obtain auth_key", 0, res);
  await updateSession({ auth_key: res.auth_key });
  return res.auth_key;
}

export function isLoggedIn(s: Session): boolean {
  return Boolean(s.access_token);
}

export function requireLogin(s: Session): void {
  if (!s.access_token) {
    throw new BlinkitError(
      "Not logged in. Call send_otp then verify_otp first.",
      401,
    );
  }
}

/**
 * Location guard: every catalog/cart/checkout/order action requires a confirmed
 * delivery location. This is enforced centrally so no tool can bypass it.
 */
export function requireLocation(s: Session): void {
  if (!s.location || s.location.lat === undefined || s.location.lon === undefined) {
    throw new BlinkitError(
      "No delivery location set. Call set_location (or find_location) and confirm the address with the user before searching or ordering.",
      400,
    );
  }
  if (s.location.serviceable === false) {
    throw new BlinkitError(
      `The saved location (${s.location.label ?? `${s.location.lat},${s.location.lon}`}) is not serviceable by Blinkit. Set a serviceable location first.`,
      400,
    );
  }
}
