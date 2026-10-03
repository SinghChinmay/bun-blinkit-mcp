import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Persistent device/user state for the Blinkit MCP.
 *
 * Stored at ~/.blinkit-mcp/session.json (chmod 600). Holds the device identity,
 * the login-free device `auth_key`, the user `access_token` (after OTP login),
 * and the confirmed delivery location. This file contains secrets and must never
 * be committed.
 */
export interface SavedLocation {
  lat: number;
  lon: number;
  /** Human-readable address line returned by /location/info. */
  label?: string;
  city?: string;
  /** Dark-store id that serves this location (from /visibility). */
  merchant_id?: number;
  serviceable: boolean;
  /** ISO timestamp of when the location was last resolved/confirmed. */
  confirmed_at: string;
}

export interface Session {
  /** Stable per-device id (16 hex chars). Sent as the `device_id` header. */
  device_id: string;
  /** Per-install session uuid. Sent as the `session_uuid` header. */
  session_uuid: string;
  /** Device key from GET /v2/accounts/auth_key/. Sent on every call. */
  auth_key?: string;
  /** User token from OTP verify (format `v2::<uuid>`). undefined = logged out. */
  access_token?: string;
  /** Numeric Blinkit account id (from OTP verify). */
  user_id?: number;
  /** Phone number captured at login. */
  phone?: string;
  /** Delivery address id chosen for checkout. */
  address_id?: number;
  /** Confirmed delivery location. Required before any catalog/cart action. */
  location?: SavedLocation;
}

const DIR = process.env.BLINKIT_HOME ?? join(homedir(), ".blinkit-mcp");
const FILE = join(DIR, "session.json");

export const SESSION_DIR = DIR;
export const SESSION_FILE = FILE;

let cache: Session | null = null;

function freshSession(): Session {
  return {
    device_id: randomBytes(8).toString("hex"),
    session_uuid: randomUUID(),
  };
}

async function persist(s: Session): Promise<void> {
  await Bun.write(FILE, JSON.stringify(s, null, 2));
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(FILE, 0o600);
  } catch {
    /* best effort */
  }
}

export async function loadSession(): Promise<Session> {
  if (cache) return cache;
  const file = Bun.file(FILE);
  if (await file.exists()) {
    try {
      cache = { ...freshSession(), ...(await file.json()) } as Session;
      return cache;
    } catch {
      /* fall through to fresh */
    }
  }
  cache = freshSession();
  await Bun.write(FILE, JSON.stringify(cache, null, 2));
  return cache;
}

export async function saveSession(s: Session): Promise<void> {
  cache = s;
  await persist(s);
}

/** Merge a partial update into the session and persist. */
export async function updateSession(patch: Partial<Session>): Promise<Session> {
  const s = await loadSession();
  const next = { ...s, ...patch };
  await saveSession(next);
  return next;
}
