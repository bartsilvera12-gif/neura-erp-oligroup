import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { isLikelyUnexposedTenantChatSchema } from "@/lib/supabase/chat-data-schema";
import {
  getChatPostgresPool,
  isPgPoolExhaustionMessage,
  logPgPoolStats,
  quoteSchemaTable,
} from "@/lib/supabase/chat-pg-pool";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { invalidateSorteosListCachesForEmpresa } from "@/lib/sorteos/server-queries";
import type { SorteoEntradaEstadoPago } from "@/lib/sorteos/types";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { createServiceRoleClientForEmpresa } from "@/lib/supabase/empresa-data-schema";
import {
  buildOrderResultFromEntradaId,
  flowDataStubFromEntrada,
} from "@/lib/sorteos/sorteo-ticket-admin";
import { maybeGenerateAndSendSorteoTicketDelivery } from "@/lib/sorteos/sorteo-ticket-delivery";

const LOG = "[sorteos-cupones][payment-status-update]";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim());
}

function sanitizeErr(msg: string): string {
  return msg.replace(/\b(password|token|secret|key)\s*=[^\s]+/gi, "[redacted]").slice(0, 280);
}

type Body = { estado_pago?: unknown };

/** Al aprobar el pago a mano se genera la boleta (queda lista en Tickets para «Reenviar WA»). No bloquea la respuesta. */
async function generarBoletaTrasAprobar(empresaId: string, entradaId: string): Promise<void> {
  try {
    const sbFlow = await getChatServiceClientForEmpresa(empresaId);
    const sb = await createServiceRoleClientForEmpresa(empresaId);
    const orderResult = await buildOrderResultFromEntradaId(sb, entradaId, empresaId);
    if (!orderResult) return;
    const fd = await flowDataStubFromEntrada(sb, entradaId);
    const { data: ent } = await sb
      .from("sorteo_entradas")
      .select("chat_conversation_id")
      .eq("id", entradaId)
      .maybeSingle();
    const conversationId =
      (ent as { chat_conversation_id?: string | null } | null)?.chat_conversation_id ?? null;
    await maybeGenerateAndSendSorteoTicketDelivery({
      supabase: sbFlow,
      empresaId,
      sorteoId: orderResult.sorteoId,
      entradaId,
      conversationId,
      flowSessionId: null,
      contactId: "",
      channelId: "",
      orderResult,
      flowData: fd,
      trigger: "confirmacion_final",
      skipWhatsApp: true,
    });
  } catch (e: unknown) {
    console.error(LOG, { stage: "boleta_error", entrada_id: entradaId, error: sanitizeErr(String(e)) });
  }
}

/**
 * PATCH /api/sorteos/cupones/[entradaId]/estado-pago
 * Solo desde `pendiente_revision` → `confirmado` | `rechazado` (sin efectos colaterales en flujos).
 *
 * Pool PG: evitar `getChatServiceClientForEmpresa` + shim (SELECT+UPDATE duplica uso del pooler en modo sesión).
 * - Schema expuesto (p. ej. zentra_erp): PostgREST vía `authCtx.supabase` (HTTP, sin cliente pg Node).
 * - Tenant erp_* no expuesto: una sentencia UPDATE … RETURNING sobre `getChatPostgresPool()` singleton.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ entradaId: string }> }
) {
  let empresaIdForLog = "";
  let schemaForLog = "";
  let entradaIdForLog = "";

  try {
    const authCtx = await getTenantSupabaseFromAuth(request);
    if (!authCtx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    const { entradaId: rawId } = await params;
    const entradaId = typeof rawId === "string" ? rawId.trim() : "";
    entradaIdForLog = entradaId;
    if (!entradaId || !isUuid(entradaId)) {
      return NextResponse.json(errorResponse("entradaId inválido."), { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as Body;
    const nextRaw = body.estado_pago;
    const next =
      nextRaw === "confirmado" || nextRaw === "rechazado"
        ? (nextRaw as SorteoEntradaEstadoPago)
        : null;
    if (!next) {
      return NextResponse.json(errorResponse('estado_pago debe ser "confirmado" o "rechazado".'), {
        status: 400,
      });
    }

    const empresaId = authCtx.auth.empresa_id;
    empresaIdForLog = empresaId;
    const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
    schemaForLog = dataSchema;

    const updatedAt = new Date().toISOString();

    console.info(LOG, {
      stage: "before_update",
      empresa_id: empresaId,
      schema: dataSchema,
      entrada_id: entradaId,
      estado_nuevo: next,
    });

    if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
      const pool = getChatPostgresPool();
      if (!pool) {
        console.error(LOG, {
          stage: "error",
          empresa_id: empresaId,
          schema: dataSchema,
          entrada_id: entradaId,
          estado_nuevo: next,
          error: "sin_pool_pg",
        });
        return NextResponse.json(
          errorResponse(
            "El servidor no tiene conexión directa a Postgres (SUPABASE_DB_URL / DIRECT_URL). No se puede actualizar la entrada."
          ),
          { status: 503 }
        );
      }

      const qtbl = quoteSchemaTable(dataSchema, "sorteo_entradas");
      let rowOut: { id: string; estado_pago: string } | null = null;
      try {
        const r = await pool.query<{ id: string; estado_pago: string }>(
          `UPDATE ${qtbl}
           SET estado_pago = $1::text, updated_at = $2::timestamptz
           WHERE id = $3::uuid
             AND empresa_id = $4::uuid
             AND estado_pago = 'pendiente_revision'
           RETURNING id, estado_pago`,
          [next, updatedAt, entradaId, empresaId]
        );
        rowOut = r.rows?.[0] ?? null;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const poolErr = isPgPoolExhaustionMessage(msg);
        if (poolErr) logPgPoolStats("cupones_estado_pago_patch", pool, { empresa_id: empresaId, schema: dataSchema });
        console.error(LOG, {
          stage: "error",
          empresa_id: empresaId,
          schema: dataSchema,
          entrada_id: entradaId,
          estado_nuevo: next,
          error: sanitizeErr(msg),
        });
        return NextResponse.json(
          errorResponse(
            poolErr
              ? "Base de datos saturada momentáneamente; reintentá en unos segundos."
              : sanitizeErr(msg) || "Error al actualizar."
          ),
          { status: poolErr ? 503 : 500 }
        );
      }

      if (!rowOut) {
        try {
          const r2 = await pool.query<{ estado_pago: string | null }>(
            `SELECT estado_pago FROM ${qtbl} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
            [entradaId, empresaId]
          );
          const cur = r2.rows?.[0];
          if (!cur) {
            console.info(LOG, {
              stage: "after_update",
              empresa_id: empresaId,
              schema: dataSchema,
              entrada_id: entradaId,
              estado_nuevo: next,
              resultado: "not_found",
            });
            return NextResponse.json(errorResponse("Entrada no encontrada."), { status: 404 });
          }
          const ea = String(cur.estado_pago ?? "").trim();
          console.info(LOG, {
            stage: "after_update",
            empresa_id: empresaId,
            schema: dataSchema,
            entrada_id: entradaId,
            estado_nuevo: next,
            estado_actual: ea,
            resultado: "reject_wrong_state",
          });
          return NextResponse.json(
            errorResponse(
              ea === "confirmado" || ea === "rechazado"
                ? "Este pago ya fue resuelto."
                : `Solo se puede aprobar o rechazar desde «Pendiente revisión». Estado actual: ${ea}.`
            ),
            { status: 409 }
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(LOG, {
            stage: "error",
            empresa_id: empresaId,
            schema: dataSchema,
            entrada_id: entradaId,
            estado_nuevo: next,
            error: sanitizeErr(msg),
          });
          return NextResponse.json(errorResponse(sanitizeErr(msg)), { status: 500 });
        }
      }

      console.info(LOG, {
        stage: "after_update",
        empresa_id: empresaId,
        schema: dataSchema,
        entrada_id: entradaId,
        estado_nuevo: next,
        resultado: "ok",
      });

      invalidateSorteosListCachesForEmpresa(empresaId, dataSchema);
      console.info(LOG, {
        stage: "cache_invalidation",
        empresa_id: empresaId,
        schema: dataSchema,
        entrada_id: entradaId,
        estado_nuevo: next,
      });

      if (next === "confirmado") void generarBoletaTrasAprobar(empresaId, entradaId);

      return NextResponse.json(
        successResponse({
          entrada_id: entradaId,
          estado_pago: next as SorteoEntradaEstadoPago,
        })
      );
    }

    const sb = authCtx.supabase;
    const { data: updated, error: upErr } = await sb
      .from("sorteo_entradas")
      .update({ estado_pago: next, updated_at: updatedAt })
      .eq("id", entradaId)
      .eq("empresa_id", empresaId)
      .eq("estado_pago", "pendiente_revision")
      .select("id, estado_pago")
      .maybeSingle();

    if (upErr) {
      const em = upErr.message ?? "";
      console.error(LOG, {
        stage: "error",
        empresa_id: empresaId,
        schema: dataSchema,
        entrada_id: entradaId,
        estado_nuevo: next,
        error: sanitizeErr(em),
      });
      const poolLike = isPgPoolExhaustionMessage(em);
      return NextResponse.json(
        errorResponse(
          poolLike
            ? "Base de datos saturada momentáneamente; reintentá en unos segundos."
            : sanitizeErr(em)
        ),
        { status: poolLike ? 503 : 500 }
      );
    }

    if (!updated || typeof updated !== "object") {
      const { data: exists, error: exErr } = await sb
        .from("sorteo_entradas")
        .select("estado_pago")
        .eq("id", entradaId)
        .eq("empresa_id", empresaId)
        .maybeSingle();

      if (exErr) {
        console.error(LOG, {
          stage: "error",
          empresa_id: empresaId,
          schema: dataSchema,
          entrada_id: entradaId,
          estado_nuevo: next,
          error: sanitizeErr(exErr.message),
        });
        return NextResponse.json(errorResponse(sanitizeErr(exErr.message)), { status: 500 });
      }

      if (!exists) {
        console.info(LOG, {
          stage: "after_update",
          empresa_id: empresaId,
          schema: dataSchema,
          entrada_id: entradaId,
          estado_nuevo: next,
          resultado: "not_found",
        });
        return NextResponse.json(errorResponse("Entrada no encontrada."), { status: 404 });
      }

      const ea = String((exists as { estado_pago?: unknown }).estado_pago ?? "").trim();
      console.info(LOG, {
        stage: "after_update",
        empresa_id: empresaId,
        schema: dataSchema,
        entrada_id: entradaId,
        estado_nuevo: next,
        estado_actual: ea,
        resultado: "reject_wrong_state",
      });
      return NextResponse.json(
        errorResponse(
          ea === "confirmado" || ea === "rechazado"
            ? "Este pago ya fue resuelto."
            : `Solo se puede aprobar o rechazar desde «Pendiente revisión». Estado actual: ${ea}.`
        ),
        { status: 409 }
      );
    }

    console.info(LOG, {
      stage: "after_update",
      empresa_id: empresaId,
      schema: dataSchema,
      entrada_id: entradaId,
      estado_nuevo: next,
      resultado: "ok",
    });

    invalidateSorteosListCachesForEmpresa(empresaId, dataSchema);
    console.info(LOG, {
      stage: "cache_invalidation",
      empresa_id: empresaId,
      schema: dataSchema,
      entrada_id: entradaId,
      estado_nuevo: next,
    });

    if (next === "confirmado") void generarBoletaTrasAprobar(empresaId, entradaId);

    return NextResponse.json(
      successResponse({
        entrada_id: entradaId,
        estado_pago: next as SorteoEntradaEstadoPago,
      })
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(LOG, {
      stage: "error",
      empresa_id: empresaIdForLog || undefined,
      schema: schemaForLog || undefined,
      entrada_id: entradaIdForLog || undefined,
      estado_nuevo: undefined,
      error: sanitizeErr(msg),
    });
    return NextResponse.json(errorResponse(sanitizeErr(msg) || "Error interno."), { status: 503 });
  }
}
