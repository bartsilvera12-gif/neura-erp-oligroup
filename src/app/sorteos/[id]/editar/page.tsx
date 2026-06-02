"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSorteoById, updateSorteo } from "@/lib/sorteos/actions";
import type { SorteoCouponNumberMode, SorteoEstado, SorteoTicketDeliveryMode } from "@/lib/sorteos/types";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { normalizeTicketImageConfig } from "@/lib/sorteos/sorteo-ticket-types";

const SORTEO_TICKET_ASSETS_BUCKET = "sorteo-ticket-assets";
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const ASSET_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

function publicTicketAssetUrl(storagePath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") ?? "";
  const seg = storagePath.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/public/${SORTEO_TICKET_ASSETS_BUCKET}/${seg}`;
}

/**
 * Construye el payload de `ticket_image_config` respetando el `design_mode`
 * de `base`. Sigue auto por default si no viene set. Antes hardcodeaba
 * `custom_template` y forzaba a todo sorteo a depender de plantilla subida —
 * ahora el modo automático con logo es la opción primaria.
 */
function buildTicketImagePayload(
  base: Record<string, unknown>,
  text: { caption: string; stub: string }
): Record<string, unknown> {
  const incomingMode = typeof base.design_mode === "string" ? base.design_mode : undefined;
  const resolvedMode =
    incomingMode === "custom_template" || incomingMode === "auto" ? incomingMode : "auto";
  const ticketMerged: Record<string, unknown> = {
    ...base,
    design_mode: resolvedMode,
    showClienteNombre: true,
    showDocumento: true,
    showTelefono: true,
    showNumeroOrden: true,
    showCupones: true,
    showSorteoNombre: true,
  };
  const cap = text.caption.trim();
  const stu = text.stub.trim();
  if (cap) ticketMerged.caption = cap;
  else delete ticketMerged.caption;
  if (stu) ticketMerged.ticket_image_only_stub = stu;
  else delete ticketMerged.ticket_image_only_stub;
  return ticketMerged;
}

function validateAssetFile(f: File): string | null {
  const mime = (f.type || "").toLowerCase();
  if (!ASSET_MIME.has(mime)) {
    return "Solo se admiten PNG, JPG o WebP.";
  }
  if (f.size > MAX_ASSET_BYTES) {
    return `El archivo supera el máximo de ${MAX_ASSET_BYTES / (1024 * 1024)} MB.`;
  }
  if (f.size < 1) {
    return "El archivo está vacío.";
  }
  return null;
}

/** Encadena intentos de carga de imagen pública (bucket público). */
function probePublicImage(urls: string[], onFound: (url: string) => void, onDone?: () => void) {
  if (urls.length === 0) {
    onDone?.();
    return;
  }
  const [first, ...rest] = urls;
  const img = new Image();
  img.onload = () => {
    onFound(first);
    onDone?.();
  };
  img.onerror = () => probePublicImage(rest, onFound, onDone);
  img.src = first;
}

export default function EditarSorteoPage() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const router = useRouter();
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [precio, setPrecio] = useState(0);
  const [maxBoletos, setMaxBoletos] = useState(100);
  const [fechaSorteo, setFechaSorteo] = useState("");
  const [estado, setEstado] = useState<SorteoEstado>("activo");
  const [imagenUrl, setImagenUrl] = useState("");
  const [datosBancarios, setDatosBancarios] = useState("{}");
  const [empresaId, setEmpresaId] = useState<string | null>(null);
  const [ticketDeliveryMode, setTicketDeliveryMode] = useState<SorteoTicketDeliveryMode>("text_only");
  const [ticketCaption, setTicketCaption] = useState("");
  const [ticketStub, setTicketStub] = useState("");
  /** Resto de claves de ticket_image_config (colores, show*, paths de storage). */
  const [ticketImageConfigBase, setTicketImageConfigBase] = useState<Record<string, unknown>>({});
  const ticketCfgRef = useRef<Record<string, unknown>>({});
  ticketCfgRef.current = ticketImageConfigBase;

  /** Preview si hay template en Storage sin path en config (legado). */
  const [legacyTemplateUrl, setLegacyTemplateUrl] = useState<string | null>(null);

  const [couponNumberingEnabled, setCouponNumberingEnabled] = useState(false);
  const [couponStart, setCouponStart] = useState(0);
  const [couponMode, setCouponMode] = useState<SorteoCouponNumberMode>("correlative");
  const [couponLimit, setCouponLimit] = useState("");
  const [totalBoletosVendidos, setTotalBoletosVendidos] = useState(0);

  type AssetPhase = "idle" | "uploading" | "ok" | "error";
  const [templatePickName, setTemplatePickName] = useState<string | null>(null);
  const [templateObjectUrl, setTemplateObjectUrl] = useState<string | null>(null);
  const [templatePhase, setTemplatePhase] = useState<AssetPhase>("idle");
  const [templateMsg, setTemplateMsg] = useState<string | null>(null);

  const templateInputRef = useRef<HTMLInputElement>(null);

  /**
   * Modo de diseño del ticket. `auto` = SVG dinámico con logo subido (recomendado).
   * `custom_template` = PNG completo (modo avanzado, requiere diseñar todo el ticket).
   * Se inicializa desde `ticket_image_config.design_mode` y default es `auto`.
   */
  const [designMode, setDesignMode] = useState<"auto" | "custom_template">("auto");

  /** Logo asset uploader state. */
  const [logoPickName, setLogoPickName] = useState<string | null>(null);
  const [logoObjectUrl, setLogoObjectUrl] = useState<string | null>(null);
  const [logoPhase, setLogoPhase] = useState<AssetPhase>("idle");
  const [logoMsg, setLogoMsg] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const textFields = useCallback(
    () => ({
      caption: ticketCaption,
      stub: ticketStub,
    }),
    [ticketCaption, ticketStub]
  );

  const persistTicketConfig = useCallback(
    async (nextBase: Record<string, unknown>) => {
      const ticketMerged = buildTicketImagePayload(nextBase, textFields());
      const res = await fetchWithSupabaseSession(`/api/sorteos/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket_image_config: ticketMerged }),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(raw || `${res.status}`);
      let json: { success?: boolean; data?: { ticket_image_config?: Record<string, unknown> } };
      try {
        json = JSON.parse(raw) as { success?: boolean; data?: { ticket_image_config?: Record<string, unknown> } };
      } catch {
        throw new Error("Respuesta inválida del servidor.");
      }
      if (json.success && json.data?.ticket_image_config && typeof json.data.ticket_image_config === "object") {
        setTicketImageConfigBase({ ...json.data.ticket_image_config });
      }
    },
    [id, textFields]
  );

  useEffect(() => {
    if (!id) return;
    getSorteoById(id)
      .then((s) => {
        if (!s) {
          setError("Sorteo no encontrado");
          return;
        }
        setEmpresaId(s.empresa_id);
        setNombre(s.nombre);
        setDescripcion(s.descripcion ?? "");
        setPrecio(s.precio_por_boleto);
        setMaxBoletos(s.max_boletos);
        if (s.fecha_sorteo) {
          const d = new Date(s.fecha_sorteo);
          const pad = (n: number) => String(n).padStart(2, "0");
          setFechaSorteo(
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
          );
        }
        setEstado(s.estado);
        setImagenUrl(s.imagen_url ?? "");
        setDatosBancarios(JSON.stringify(s.datos_bancarios ?? {}, null, 2));
        setTicketDeliveryMode((s.ticket_delivery_mode as SorteoTicketDeliveryMode) ?? "text_only");
        const tic = normalizeTicketImageConfig(s.ticket_image_config);
        setTicketImageConfigBase(
          s.ticket_image_config &&
            typeof s.ticket_image_config === "object" &&
            s.ticket_image_config !== null &&
            !Array.isArray(s.ticket_image_config)
            ? { ...(s.ticket_image_config as Record<string, unknown>) }
            : {}
        );
        setTicketCaption(typeof tic.caption === "string" ? tic.caption : "");
        setTicketStub(typeof tic.ticket_image_only_stub === "string" ? tic.ticket_image_only_stub : "");
        // Modo de diseño: respetar lo guardado en DB; si no hay nada, default `auto`.
        setDesignMode(tic.design_mode === "custom_template" ? "custom_template" : "auto");
        setCouponNumberingEnabled(Boolean(s.coupon_numbering_enabled));
        setCouponStart(
          s.coupon_number_start != null && Number.isFinite(Number(s.coupon_number_start))
            ? Math.trunc(Number(s.coupon_number_start))
            : 0
        );
        setCouponMode(
          s.coupon_number_mode === "random" || s.coupon_number_mode === "correlative"
            ? s.coupon_number_mode
            : "correlative"
        );
        setCouponLimit(
          s.coupon_number_limit != null && Number.isFinite(Number(s.coupon_number_limit))
            ? String(Math.trunc(Number(s.coupon_number_limit)))
            : ""
        );
        setTotalBoletosVendidos(
          typeof s.total_boletos_vendidos === "number" ? s.total_boletos_vendidos : Number(s.total_boletos_vendidos) || 0
        );
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Error"))
      .finally(() => setCargando(false));
  }, [id]);

  const depTemplatePath =
    typeof ticketImageConfigBase.custom_template_storage_path === "string"
      ? ticketImageConfigBase.custom_template_storage_path
      : "";

  useEffect(() => {
    if (!empresaId || !id) return;
    const base = `${empresaId}/${id}`;
    if (depTemplatePath) {
      setLegacyTemplateUrl(null);
      return;
    }
    const urls = [`${base}/template.png`, `${base}/template.webp`, `${base}/template.jpg`].map(publicTicketAssetUrl);
    setLegacyTemplateUrl(null);
    probePublicImage(urls, (u) => setLegacyTemplateUrl(u));
  }, [empresaId, id, depTemplatePath]);

  useEffect(() => {
    return () => {
      if (templateObjectUrl) URL.revokeObjectURL(templateObjectUrl);
    };
  }, [templateObjectUrl]);

  useEffect(() => {
    return () => {
      if (logoObjectUrl) URL.revokeObjectURL(logoObjectUrl);
    };
  }, [logoObjectUrl]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const nombreTrim = nombre.trim();
    if (!nombreTrim) {
      setError("El nombre del sorteo es obligatorio.");
      return;
    }
    if (!Number.isFinite(precio) || precio < 0) {
      setError("El precio por boleto debe ser un número válido mayor o igual a 0.");
      return;
    }
    if (!Number.isFinite(maxBoletos) || maxBoletos < 1) {
      setError("El máximo de boletos debe ser al menos 1.");
      return;
    }
    if (couponNumberingEnabled) {
      if (!Number.isFinite(couponStart) || couponStart < 0) {
        setError("El número inicial de cupón debe ser un entero mayor o igual a 0.");
        return;
      }
      if (couponMode === "random") {
        const lim = couponLimit.trim() === "" ? NaN : Number(couponLimit);
        if (!Number.isFinite(lim)) {
          setError("En modo aleatorio el límite máximo es obligatorio.");
          return;
        }
        if (lim < couponStart) {
          setError("El límite máximo debe ser mayor o igual al número inicial.");
          return;
        }
      }
      if (couponMode === "correlative" && couponLimit.trim() !== "") {
        const lim = Number(couponLimit);
        if (!Number.isFinite(lim) || lim < couponStart) {
          setError("El límite máximo debe ser mayor o igual al número inicial.");
          return;
        }
      }
    }

    let json: Record<string, unknown> = {};
    try {
      json = datosBancarios.trim() ? (JSON.parse(datosBancarios) as Record<string, unknown>) : {};
    } catch {
      setError("Datos bancarios: el JSON no es válido. Revisá comillas y comas.");
      return;
    }

    let fechaIso: string | null = null;
    if (fechaSorteo.trim()) {
      const d = new Date(fechaSorteo);
      if (Number.isNaN(d.getTime())) {
        setError("La fecha del sorteo no es válida.");
        return;
      }
      fechaIso = d.toISOString();
    }

    const ticketMerged = buildTicketImagePayload(ticketImageConfigBase, textFields());

    setGuardando(true);
    try {
      const updated = await updateSorteo(id, {
        nombre: nombreTrim,
        descripcion,
        precio_por_boleto: precio,
        max_boletos: maxBoletos,
        fecha_sorteo: fechaIso,
        estado,
        datos_bancarios: json,
        imagen_url: imagenUrl.trim() || null,
        ticket_delivery_mode: ticketDeliveryMode,
        ticket_image_config: ticketMerged,
        coupon_numbering_enabled: couponNumberingEnabled,
        coupon_number_start: couponNumberingEnabled ? Math.trunc(couponStart) : null,
        coupon_number_mode: couponNumberingEnabled ? couponMode : null,
        coupon_number_limit:
          couponNumberingEnabled && couponLimit.trim() !== ""
            ? Math.trunc(Number(couponLimit))
            : null,
      });
      if (updated.ticket_image_config && typeof updated.ticket_image_config === "object") {
        setTicketImageConfigBase({ ...(updated.ticket_image_config as Record<string, unknown>) });
      }
      setSuccess("Cambios guardados correctamente.");
      router.refresh();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error al guardar";
      setError(msg);
      console.error("[editar sorteo]", err);
    } finally {
      setGuardando(false);
    }
  }

  async function onTemplateFile(files: FileList | null) {
    const f = files?.[0];
    if (!f || !id) return;
    setTemplateMsg(null);
    setTemplatePhase("idle");
    const err = validateAssetFile(f);
    if (err) {
      setTemplatePhase("error");
      setTemplateMsg(err);
      return;
    }
    if (templateObjectUrl) URL.revokeObjectURL(templateObjectUrl);
    const ou = URL.createObjectURL(f);
    setTemplateObjectUrl(ou);
    setTemplatePickName(f.name);
    setTemplatePhase("uploading");

    const dims = await new Promise<{ w: number; h: number }>((resolve) => {
      const im = new Image();
      im.onload = () =>
        resolve({
          w: im.naturalWidth || 1080,
          h: im.naturalHeight || 1350,
        });
      im.onerror = () => resolve({ w: 1080, h: 1350 });
      im.src = ou;
    });

    const fd = new FormData();
    fd.set("sorteo_id", id);
    fd.set("kind", "template");
    fd.set("file", f);
    try {
      const res = await fetchWithSupabaseSession("/api/sorteos/ticket-assets", {
        method: "POST",
        body: fd,
      });
      const raw = await res.text();
      if (!res.ok) {
        setTemplatePhase("error");
        setTemplateMsg(raw || `Error ${res.status}`);
        return;
      }
      const json = JSON.parse(raw) as { success?: boolean; data?: { bucket?: string; path?: string } };
      const bucket = json.data?.bucket;
      const path = json.data?.path;
      if (!json.success || !bucket || !path) {
        setTemplatePhase("error");
        setTemplateMsg("Respuesta inválida del servidor.");
        return;
      }
      const nextBase = {
        ...ticketCfgRef.current,
        // Subir template implica modo custom_template (avanzado).
        design_mode: "custom_template" as const,
        custom_template_storage_bucket: bucket,
        custom_template_storage_path: path,
        custom_template_width: dims.w,
        custom_template_height: dims.h,
        custom_template_original_filename: f.name,
      };
      await persistTicketConfig(nextBase);
      setDesignMode("custom_template");
      URL.revokeObjectURL(ou);
      setTemplateObjectUrl(null);
      setTemplatePickName(null);
      setLegacyTemplateUrl(null);
      setTemplatePhase("idle");
      setTemplateMsg(null);
    } catch (e) {
      setTemplatePhase("error");
      setTemplateMsg(e instanceof Error ? e.message : "Error al subir");
    }
  }

  /**
   * Sube el LOGO (kind=logo) y guarda en `ticket_image_config` las rutas
   * (`logo_storage_bucket`, `logo_storage_path`) + `design_mode=auto`. El
   * render automático (`renderTicketPngUnified`) usa el logo cuando no hay
   * template — recomendado para Triple 7 que sólo quiere subir logo.
   */
  async function onLogoFile(files: FileList | null) {
    const f = files?.[0];
    if (!f || !id) return;
    setLogoMsg(null);
    setLogoPhase("idle");
    const err = validateAssetFile(f);
    if (err) {
      setLogoPhase("error");
      setLogoMsg(err);
      return;
    }
    if (logoObjectUrl) URL.revokeObjectURL(logoObjectUrl);
    const ou = URL.createObjectURL(f);
    setLogoObjectUrl(ou);
    setLogoPickName(f.name);
    setLogoPhase("uploading");

    const fd = new FormData();
    fd.set("sorteo_id", id);
    fd.set("kind", "logo");
    fd.set("file", f);

    try {
      const res = await fetchWithSupabaseSession("/api/sorteos/ticket-assets", {
        method: "POST",
        body: fd,
      });
      const raw = await res.text();
      if (!res.ok) {
        setLogoPhase("error");
        setLogoMsg(raw || `Error ${res.status}`);
        return;
      }
      const json = JSON.parse(raw) as { success?: boolean; data?: { bucket?: string; path?: string } };
      const bucket = json.data?.bucket;
      const path = json.data?.path;
      if (!json.success || !bucket || !path) {
        setLogoPhase("error");
        setLogoMsg("Respuesta inválida del servidor.");
        return;
      }
      const nextBase = {
        ...ticketCfgRef.current,
        design_mode: "auto" as const,
        logo_storage_bucket: bucket,
        logo_storage_path: path,
        showLogo: true,
      };
      await persistTicketConfig(nextBase);
      setDesignMode("auto");
      setLogoPhase("ok");
      setLogoMsg(null);
    } catch (e) {
      setLogoPhase("error");
      setLogoMsg(e instanceof Error ? e.message : "Error al subir");
    }
  }

  async function removeLogo() {
    if (!id) return;
    setLogoMsg(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/sorteos/ticket-assets?sorteo_id=${encodeURIComponent(id)}&kind=logo`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        setLogoPhase("error");
        setLogoMsg(await res.text());
        return;
      }
      const next = { ...ticketCfgRef.current };
      delete next.logo_storage_bucket;
      delete next.logo_storage_path;
      await persistTicketConfig(next);
      if (logoObjectUrl) URL.revokeObjectURL(logoObjectUrl);
      setLogoObjectUrl(null);
      setLogoPickName(null);
      setLogoPhase("idle");
      setLogoMsg(null);
    } catch (e) {
      setLogoPhase("error");
      setLogoMsg(e instanceof Error ? e.message : "Error");
    }
  }

  async function removeTemplate() {
    if (!id) return;
    setTemplateMsg(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/sorteos/ticket-assets?sorteo_id=${encodeURIComponent(id)}&kind=template`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        setTemplatePhase("error");
        setTemplateMsg(await res.text());
        return;
      }
      const next = { ...ticketCfgRef.current };
      delete next.custom_template_storage_bucket;
      delete next.custom_template_storage_path;
      delete next.custom_template_width;
      delete next.custom_template_height;
      delete next.custom_template_original_filename;
      await persistTicketConfig(next);
      setLegacyTemplateUrl(null);
      setTemplatePhase("idle");
      setTemplateMsg(null);
    } catch (e) {
      setTemplatePhase("error");
      setTemplateMsg(e instanceof Error ? e.message : "Error");
    }
  }

  const templatePathStored =
    typeof ticketImageConfigBase.custom_template_storage_path === "string"
      ? ticketImageConfigBase.custom_template_storage_path
      : null;
  const templatePreviewSrc = templateObjectUrl
    ? templateObjectUrl
    : templatePathStored
      ? publicTicketAssetUrl(templatePathStored)
      : legacyTemplateUrl;

  const hasTemplateOnServer = Boolean(templatePathStored || legacyTemplateUrl);

  /** Datos del logo persistido para previsualizar y decidir UX. */
  const logoPathStored =
    typeof ticketImageConfigBase.logo_storage_path === "string"
      ? ticketImageConfigBase.logo_storage_path
      : null;
  const logoPreviewSrc = logoObjectUrl
    ? logoObjectUrl
    : logoPathStored
      ? publicTicketAssetUrl(logoPathStored)
      : null;
  const hasLogoOnServer = Boolean(logoPathStored);

  const templateW =
    typeof ticketImageConfigBase.custom_template_width === "number"
      ? ticketImageConfigBase.custom_template_width
      : null;
  const templateH =
    typeof ticketImageConfigBase.custom_template_height === "number"
      ? ticketImageConfigBase.custom_template_height
      : null;

  const templateStoredOriginalName =
    typeof ticketImageConfigBase.custom_template_original_filename === "string"
      ? ticketImageConfigBase.custom_template_original_filename.trim()
      : "";
  const templatePathFilename =
    templatePathStored && typeof templatePathStored === "string"
      ? (templatePathStored.split("/").pop() ?? "")
      : "";
  const templateDisplayFileName = templateStoredOriginalName || templatePathFilename || null;

  if (cargando) {
    return <div className="py-16 text-center text-slate-400 text-sm animate-pulse">Cargando…</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/sorteos" className="hover:text-slate-800">
          Sorteos
        </Link>
        <span>/</span>
        <span className="text-slate-800 font-medium">Editar</span>
      </div>
      <h1 className="text-2xl font-bold text-gray-800">Editar sorteo</h1>
      <div className="pt-1 flex flex-wrap gap-2">
        <Link
          href={`/configuracion/conversaciones/flujos?sorteo_id=${encodeURIComponent(id)}`}
          className="inline-flex items-center rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
        >
          Flujo WhatsApp para este sorteo
        </Link>
        <Link
          href={`/sorteos/${id}/revendedores`}
          className="inline-flex items-center rounded-lg border border-[#4FAEB2]/30 bg-[#4FAEB2]/8 px-3 py-2 text-sm font-medium text-[#3F8E91] hover:bg-sky-100"
        >
          Revendedores y enlaces de referido
        </Link>
        <Link
          href="/sorteos/tickets"
          className="inline-flex items-center rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-800 hover:bg-violet-100"
        >
          Tickets / Comprobantes
        </Link>
        <Link
          href={`/sorteos/${encodeURIComponent(id)}/imprimir-cupones`}
          className="inline-flex items-center rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
        >
          Imprimir cupones para urna
        </Link>
      </div>
      <p className="text-sm text-slate-600 max-w-3xl">
        El botón <strong className="font-medium text-slate-800">Tickets / Comprobantes</strong> abre el reservorio de
        envíos. Subí <strong className="font-medium text-slate-800">una imagen base</strong> del comprobante y los textos
        de la sección{" "}
        <a href="#respuesta-ticket" className="text-violet-700 underline underline-offset-2">
          Respuesta al comprador / Ticket
        </a>
        .
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div
          className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm rounded-lg px-4 py-2"
          role="status"
        >
          {success}{" "}
          <Link href="/sorteos" className="font-medium text-emerald-800 underline underline-offset-2">
            Ver listado de sorteos
          </Link>
        </div>
      )}

      <form noValidate onSubmit={handleSubmit} className="space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-slate-800 border-b border-slate-100 pb-2">Datos del sorteo</h2>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nombre</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
            <textarea
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm min-h-[80px]"
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Precio por boleto (₲)</label>
              <input
                type="number"
                min={0}
                step={1}
                required
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={precio}
                onChange={(e) => setPrecio(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Máx. boletos</label>
              <input
                type="number"
                min={1}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={Number.isFinite(maxBoletos) ? maxBoletos : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setMaxBoletos(v === "" ? 0 : Number(v));
                }}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Fecha del sorteo</label>
              <input
                type="datetime-local"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={fechaSorteo}
                onChange={(e) => setFechaSorteo(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Estado</label>
              <select
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={estado}
                onChange={(e) => setEstado(e.target.value as SorteoEstado)}
              >
                <option value="activo">activo</option>
                <option value="pausado">pausado</option>
                <option value="cerrado">cerrado</option>
                <option value="finalizado">finalizado</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">URL imagen</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={imagenUrl}
              onChange={(e) => setImagenUrl(e.target.value)}
            />
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-slate-800 border-b border-slate-100 pb-2">
            Numeración de cupones
          </h2>
          <label className="flex items-center gap-2 text-sm text-slate-800 cursor-pointer">
            <input
              type="checkbox"
              checked={couponNumberingEnabled}
              onChange={(e) => setCouponNumberingEnabled(e.target.checked)}
              className="rounded border-slate-300"
            />
            Personalizar numeración de cupones
          </label>
          <p className="text-xs text-slate-500">
            Esta configuración solo afecta nuevos cupones generados desde este sorteo. No modifica cupones ya emitidos.
          </p>
          {totalBoletosVendidos > 0 && couponNumberingEnabled ? (
            <p className="text-xs text-amber-800 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              Esto no renumera cupones existentes. Solo aplica a próximas ventas.
            </p>
          ) : null}
          {couponNumberingEnabled ? (
            <div className="space-y-3 pl-0 sm:pl-1">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Número inicial</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  placeholder="0"
                  className="w-full max-w-xs border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  value={Number.isFinite(couponStart) ? couponStart : 0}
                  onChange={(e) => setCouponStart(e.target.value === "" ? 0 : Number(e.target.value))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Modo de generación</label>
                <select
                  className="w-full max-w-xs border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  value={couponMode}
                  onChange={(e) => setCouponMode(e.target.value as SorteoCouponNumberMode)}
                >
                  <option value="correlative">Correlativo</option>
                  <option value="random">Aleatorio</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Límite máximo
                  {couponMode === "random" ? (
                    <span className="text-amber-700"> (obligatorio en aleatorio)</span>
                  ) : (
                    <span className="text-slate-400"> (opcional en correlativo)</span>
                  )}
                </label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="w-full max-w-xs border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  value={couponLimit}
                  onChange={(e) => setCouponLimit(e.target.value)}
                  placeholder={couponMode === "random" ? "Ej. 9999" : "Sin tope (vacío)"}
                />
              </div>
            </div>
          ) : null}
        </section>

        <section
          id="respuesta-ticket"
          className="rounded-xl border-2 border-violet-300 bg-gradient-to-b from-violet-50/90 to-white p-6 shadow-md space-y-4 scroll-mt-6"
        >
          <div>
            <h2 className="text-base font-semibold text-slate-900">Respuesta al comprador / Ticket</h2>
            <p className="text-xs text-slate-600 mt-1">
              Definí si el comprador recibe solo texto, texto más imagen del comprobante o solo la imagen. Subí{" "}
              <span className="font-medium">una imagen base</span> ya diseñada; el sistema completará datos y cupones
              encima. La imagen y los textos se guardan con <span className="font-medium">Guardar</span> o al terminar
              la subida (se actualiza{" "}
              <code className="rounded bg-violet-100/80 px-1">ticket_image_config</code>).
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Modo de respuesta</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
              value={ticketDeliveryMode}
              onChange={(e) => setTicketDeliveryMode(e.target.value as SorteoTicketDeliveryMode)}
            >
              <option value="text_only">Solo texto</option>
              <option value="text_and_image">Texto + imagen del comprobante</option>
              <option value="image_only">Solo imagen del comprobante</option>
            </select>
          </div>

          {/* Selector de modo de diseño del ticket */}
          <div className="rounded-xl border border-violet-200 bg-white p-4 space-y-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">Modo de diseño del ticket</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
              value={designMode}
              onChange={(e) => {
                const next = e.target.value === "custom_template" ? "custom_template" : "auto";
                setDesignMode(next);
                void persistTicketConfig({ ...ticketCfgRef.current, design_mode: next });
              }}
            >
              <option value="auto">Diseño automático con logo (recomendado)</option>
              <option value="custom_template">Plantilla personalizada (avanzado)</option>
            </select>
            <p className="text-xs text-slate-600">
              {designMode === "auto"
                ? "El ERP genera el ticket usando tu logo y los datos del comprador. Solo subí el logo."
                : "Subí una imagen base completa con el diseño del ticket. El ERP completa los datos encima."}
            </p>
          </div>

          {/* Uploader de LOGO — visible en modo auto */}
          {designMode === "auto" && (
            <div className="rounded-xl border-2 border-violet-400/80 bg-white p-5 space-y-4">
              <div>
                <p className="text-base font-semibold text-slate-900">Subir logo del cliente</p>
                <p className="text-sm text-slate-600 mt-2">
                  Subí solo el logo. El ERP arma el ticket con el diseño automático y completa los datos
                  del comprador y sus cupones.
                </p>
                <ul className="mt-2 text-xs text-slate-600 list-disc list-inside space-y-0.5">
                  <li>PNG, JPG o WebP · máximo {MAX_ASSET_BYTES / (1024 * 1024)} MB</li>
                  <li>Recomendado: fondo transparente (PNG) y proporciones cuadradas o rectangulares</li>
                </ul>
              </div>

              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={(e) => {
                  void onLogoFile(e.target.files);
                  e.target.value = "";
                }}
              />

              <div className="flex flex-wrap items-center gap-2">
                {!hasLogoOnServer && (
                  <button
                    type="button"
                    onClick={() => logoInputRef.current?.click()}
                    disabled={logoPhase === "uploading"}
                    className="inline-flex items-center rounded-lg bg-violet-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-800 disabled:opacity-50"
                  >
                    Seleccionar logo
                  </button>
                )}
                {hasLogoOnServer && (
                  <>
                    <button
                      type="button"
                      onClick={() => logoInputRef.current?.click()}
                      disabled={logoPhase === "uploading"}
                      className="inline-flex items-center rounded-lg bg-violet-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-800 disabled:opacity-50"
                    >
                      Cambiar logo
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeLogo()}
                      className="inline-flex items-center rounded-lg border border-red-200 bg-white px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50"
                    >
                      Quitar logo
                    </button>
                  </>
                )}
              </div>

              {logoPhase === "uploading" && (
                <p className="text-sm font-medium text-violet-800">Subiendo logo…</p>
              )}
              {logoPhase === "error" && logoMsg && (
                <p className="text-sm text-red-700" role="alert">{logoMsg}</p>
              )}
              {hasLogoOnServer && logoPhase !== "uploading" && logoPhase !== "error" && (
                <p className="text-sm font-medium text-emerald-800">Logo cargado correctamente.</p>
              )}
              {logoPickName && (
                <p className="text-sm text-slate-700">
                  Archivo: <span className="font-medium break-all">{logoPickName}</span>
                </p>
              )}
              {logoPreviewSrc && (
                <div className="mt-2 inline-block rounded-lg border border-slate-200 bg-slate-50 p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={logoPreviewSrc}
                    alt="Preview del logo"
                    className="block max-h-32 max-w-[200px] object-contain"
                  />
                </div>
              )}
            </div>
          )}

          {/* Uploader de TEMPLATE — visible en modo custom_template (avanzado) */}
          {designMode === "custom_template" && (
          <div className="rounded-xl border-2 border-violet-400/80 bg-white p-5 space-y-4">
            <div>
              <p className="text-base font-semibold text-slate-900">Subir imagen base del comprobante</p>
              <p className="text-sm text-slate-600 mt-2">
                Subí una imagen ya diseñada con el logo y espacio libre para los datos. El sistema completará
                automáticamente los datos del comprador y sus cupones.
              </p>
              <ul className="mt-2 text-xs text-slate-600 list-disc list-inside space-y-0.5">
                <li>PNG, JPG o WebP · máximo {MAX_ASSET_BYTES / (1024 * 1024)} MB</li>
                <li>
                  Tamaño recomendado: <span className="font-medium">1080×1350</span> · dejá espacio libre{" "}
                  <span className="font-medium">abajo</span> para los datos
                </li>
              </ul>
            </div>

            <input
              ref={templateInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(e) => {
                void onTemplateFile(e.target.files);
                e.target.value = "";
              }}
            />

            <div className="flex flex-wrap items-center gap-2">
              {!hasTemplateOnServer && (
                <button
                  type="button"
                  onClick={() => templateInputRef.current?.click()}
                  disabled={templatePhase === "uploading"}
                  className="inline-flex items-center rounded-lg bg-violet-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-800 disabled:opacity-50"
                >
                  Seleccionar imagen
                </button>
              )}
              {hasTemplateOnServer && (
                <>
                  <button
                    type="button"
                    onClick={() => templateInputRef.current?.click()}
                    disabled={templatePhase === "uploading"}
                    className="inline-flex items-center rounded-lg bg-violet-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-800 disabled:opacity-50"
                  >
                    Cambiar imagen
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeTemplate()}
                    className="inline-flex items-center rounded-lg border border-red-200 bg-white px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50"
                  >
                    Quitar imagen
                  </button>
                </>
              )}
            </div>

            {templatePhase === "uploading" && (
              <p className="text-sm font-medium text-violet-800">Subiendo imagen…</p>
            )}
            {templatePhase === "error" && templateMsg && (
              <p className="text-sm text-red-700" role="alert">
                {templateMsg}
              </p>
            )}

            {hasTemplateOnServer && templatePhase !== "uploading" && templatePhase !== "error" && (
              <p className="text-sm font-medium text-emerald-800">Imagen base cargada correctamente.</p>
            )}

            {(templatePickName || templateDisplayFileName) && (
              <p className="text-sm text-slate-700">
                Archivo:{" "}
                <span className="font-medium break-all">{templatePickName || templateDisplayFileName}</span>
              </p>
            )}

            {(templateW != null && templateH != null) || templatePathStored ? (
              <p className="text-sm text-slate-600">
                {templateW != null && templateH != null ? (
                  <>
                    Dimensiones: <span className="font-medium">{templateW}×{templateH}px</span>
                  </>
                ) : (
                  <span className="text-slate-500">Dimensiones no registradas (subí de nuevo la imagen).</span>
                )}
              </p>
            ) : null}

            {!templatePathStored && legacyTemplateUrl && (
              <p className="text-xs text-amber-800">
                Hay un archivo template.* en Storage sin registrar en el sorteo. Subí de nuevo la imagen para asociarla.
              </p>
            )}

            {!hasTemplateOnServer && (
              <p className="text-xs text-amber-900/90 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                Si todavía no subís imagen base, el sistema puede generar un comprobante de respaldo automáticamente;
                lo recomendable es subir tu diseño para un resultado profesional.
              </p>
            )}

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="mx-auto w-full max-w-xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                {templatePreviewSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={templatePreviewSrc}
                    alt="Vista previa de la imagen base del comprobante"
                    className="w-full h-auto max-h-[min(70vh,900px)] object-contain"
                  />
                ) : (
                  <div className="flex min-h-[220px] items-center justify-center px-6 py-10 text-center text-sm text-slate-400">
                    Aún no hay imagen base. Usá &quot;Seleccionar imagen&quot;.
                  </div>
                )}
              </div>
            </div>
          </div>
          )}

          <div className="space-y-3 pt-1 border-t border-violet-200/80">
            <div>
              <label className="block text-xs text-slate-600 mb-1">Caption WhatsApp de la imagen</label>
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
                value={ticketCaption}
                onChange={(e) => setTicketCaption(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Texto corto fallback (opcional)</label>
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
                value={ticketStub}
                onChange={(e) => setTicketStub(e.target.value)}
                placeholder="Listo, generamos tu comprobante…"
              />
            </div>
          </div>

          <p className="text-xs text-slate-600 border-t border-violet-200/80 pt-3">
            Los cambios de diseño se aplicarán en los próximos tickets generados o al regenerar tickets existentes desde{" "}
            <strong>Tickets / Comprobantes</strong>.
          </p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-slate-800 border-b border-slate-100 pb-2">Datos bancarios</h2>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Datos bancarios (JSON)</label>
            <textarea
              className="w-full font-mono text-xs border border-slate-200 rounded-lg px-3 py-2 min-h-[100px]"
              value={datosBancarios}
              onChange={(e) => setDatosBancarios(e.target.value)}
            />
          </div>
        </section>
        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={guardando}
            className="bg-[#4FAEB2] hover:bg-[#3F8E91] disabled:opacity-50 text-white px-5 py-2.5 rounded-lg text-sm font-medium"
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
          <Link href="/sorteos" className="px-5 py-2.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">
            Volver
          </Link>
        </div>
      </form>
    </div>
  );
}
