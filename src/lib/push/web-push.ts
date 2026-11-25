import crypto from "node:crypto";

/**
 * Web Push (RFC 8030 + cifrado aes128gcm RFC 8291 + VAPID RFC 8292) sin librerías externas.
 * Claves en variables de entorno: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (base64url), VAPID_SUBJECT (mailto: o https:).
 */

export type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type WebPushResult = { ok: boolean; status: number; gone: boolean; error?: string };

function b64u(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function fromB64u(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function getVapidPublicKey(): string | null {
  const k = process.env.VAPID_PUBLIC_KEY?.trim();
  return k ? k : null;
}

function getVapidConfig(): { pub: string; priv: string; subject: string } | null {
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) return null;
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:soporte@neura.com.py";
  return { pub, priv, subject };
}

export function isWebPushConfigured(): boolean {
  return getVapidConfig() !== null;
}

function buildVapidJwt(audience: string, cfg: { pub: string; priv: string; subject: string }): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: cfg.subject,
      })
    )
  );
  const pubRaw = fromB64u(cfg.pub);
  const key = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: cfg.priv,
      x: b64u(pubRaw.subarray(1, 33)),
      y: b64u(pubRaw.subarray(33, 65)),
    },
    format: "jwk",
  });
  const data = `${header}.${payload}`;
  const sig = crypto.sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64u(sig)}`;
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, len));
}

function encryptPayload(sub: PushSubscriptionRow, plaintext: Buffer): Buffer {
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prk = hkdf(
    authSecret,
    shared,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32
  );
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, encrypted]);
}

/** Envía un push. `gone` = true si la suscripción venció (404/410) y hay que borrarla. */
export async function sendWebPush(
  sub: PushSubscriptionRow,
  payload: Record<string, unknown>,
  opts?: { urgency?: "very-low" | "low" | "normal" | "high"; ttlSeconds?: number }
): Promise<WebPushResult> {
  const cfg = getVapidConfig();
  if (!cfg) return { ok: false, status: 0, gone: false, error: "VAPID no configurado" };
  try {
    const url = new URL(sub.endpoint);
    const jwt = buildVapidJwt(url.origin, cfg);
    const body = encryptPayload(sub, Buffer.from(JSON.stringify(payload)));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${cfg.pub}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(opts?.ttlSeconds ?? 60 * 60),
        Urgency: opts?.urgency ?? "high",
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(10_000),
    });
    const gone = res.status === 404 || res.status === 410;
    return { ok: res.ok, status: res.status, gone, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: e instanceof Error ? e.message : String(e) };
  }
}
