import crypto from "node:crypto";

/**
 * Web Push (RFC 8030 + cifrado aes128gcm RFC 8291 + VAPID RFC 8292) sin librerías externas.
 * Claves: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url) si están en el entorno; si no, se
 * generan solas y quedan en la tabla push_vapid_claves (ver loadVapidConfig).
 * VAPID_SUBJECT (mailto: o https:) es opcional.
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

type VapidConfig = { pub: string; priv: string; subject: string };

const VAPID_SUBJECT = () => process.env.VAPID_SUBJECT?.trim() || "mailto:soporte@neura.com.py";

/** Par VAPID nuevo (P-256): pública sin comprimir y privada `d`, ambas base64url. */
export function generateVapidKeys(): { pub: string; priv: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([
    Buffer.from([4]),
    fromB64u(String(pubJwk.x)),
    fromB64u(String(pubJwk.y)),
  ]);
  return { pub: b64u(pub), priv: String(privJwk.d) };
}

let vapidCache: VapidConfig | null = null;

/**
 * Claves VAPID del servidor. Si están en variables de entorno se usan esas; si no, se
 * leen de `push_vapid_claves` y, la primera vez, se generan y se guardan solas. Así el
 * aviso funciona sin que nadie cargue claves a mano. Las claves no cambian después:
 * cambiarlas obligaría a cada celular a volver a activar las notificaciones.
 */
export async function loadVapidConfig(supabase: {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}): Promise<VapidConfig | null> {
  const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPub && envPriv) return { pub: envPub, priv: envPriv, subject: VAPID_SUBJECT() };
  if (vapidCache) return vapidCache;
  try {
    const leer = async () => {
      const { data } = await supabase
        .from("push_vapid_claves")
        .select("public_key, private_key")
        .eq("id", 1)
        .maybeSingle();
      const r = data as { public_key?: string; private_key?: string } | null;
      return r?.public_key && r?.private_key ? { pub: r.public_key, priv: r.private_key } : null;
    };
    let claves = await leer();
    if (!claves) {
      const nuevas = generateVapidKeys();
      // Si otro proceso las creó al mismo tiempo, el insert choca con id=1 y se relee.
      await supabase
        .from("push_vapid_claves")
        .insert({ id: 1, public_key: nuevas.pub, private_key: nuevas.priv });
      claves = await leer();
    }
    if (!claves) return null;
    vapidCache = { ...claves, subject: VAPID_SUBJECT() };
    return vapidCache;
  } catch (e) {
    console.warn("[web-push]", "vapid_no_disponible", e instanceof Error ? e.message : String(e));
    return null;
  }
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
  opts?: { urgency?: "very-low" | "low" | "normal" | "high"; ttlSeconds?: number; vapid?: VapidConfig }
): Promise<WebPushResult> {
  const cfg = opts?.vapid ?? vapidCache;
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
