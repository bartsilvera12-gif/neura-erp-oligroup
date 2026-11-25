"use client";

import { useCallback, useEffect, useState } from "react";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Botón "Activar notificaciones" (Web Push) — solo se muestra al administrador. */
export function PushActivarButton() {
  const [visible, setVisible] = useState(false);
  const [activo, setActivo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
        const r = await fetch("/api/push/subscribe", { cache: "no-store" });
        const j = (await r.json()) as { permitido?: boolean; configured?: boolean };
        if (!r.ok || !j.permitido) return;
        const reg = await navigator.serviceWorker.register("/sw.js");
        const sub = await reg.pushManager.getSubscription();
        if (cancelled) return;
        setVisible(true);
        setActivo(!!sub && Notification.permission === "granted");
      } catch {
        /* sin soporte: no se muestra */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activar = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setMsg("Permiso denegado. Habilitá las notificaciones del sitio en Chrome.");
        return;
      }
      const cfg = (await (await fetch("/api/push/subscribe", { cache: "no-store" })).json()) as {
        publicKey?: string | null;
      };
      if (!cfg.publicKey) {
        setMsg("Las notificaciones todavía no están configuradas en el servidor.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
        });
      }
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) {
        setMsg("No se pudo guardar la suscripción.");
        return;
      }
      setActivo(true);
      setMsg("Notificaciones activadas en este dispositivo.");
    } catch {
      setMsg("No se pudieron activar las notificaciones.");
    } finally {
      setBusy(false);
    }
  }, []);

  const probar = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/push/test", { method: "POST" });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      setMsg(j.ok ? "Listo: te mandamos una notificación de prueba." : (j.error ?? "No se pudo enviar la prueba."));
    } catch {
      setMsg("No se pudo enviar la prueba.");
    } finally {
      setBusy(false);
    }
  }, []);

  if (!visible) return null;
  return (
    <div className="flex flex-col items-end gap-1 shrink-0">
      <div className="flex items-center gap-2">
        {activo ? (
          <button
            type="button"
            onClick={probar}
            disabled={busy}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Probar notificación
          </button>
        ) : (
          <button
            type="button"
            onClick={activar}
            disabled={busy}
            className="rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            Activar notificaciones
          </button>
        )}
      </div>
      {msg ? <span className="text-[10px] text-slate-600 max-w-[16rem] text-right">{msg}</span> : null}
    </div>
  );
}
