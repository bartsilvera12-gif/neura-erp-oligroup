-- =============================================================================
-- Etiquetas Automáticas para Triple 7 — FASE 1 (fundación tenant-only).
-- Sorteo ACTIVO: modo seguro. SOLO DDL aditivo + SEEDS idempotentes + función
-- read-only de clasificación. NO se aplica ocultamiento, no se modifica ninguna
-- conversación existente.
--
-- Tenant: schema `triple7` (empresa 82f8a15a-5dd6-48d9-99b3-97210b5130bd "TRIPLE 7").
-- Idempotente. Ningún UPDATE/DELETE/TRUNCATE/DROP de datos productivos.
-- No toca: webhook, flow-engine, sorteos, entradas, cupones, tickets, campañas.
-- No toca: otros schemas (public, zentra_erp, erp_*, vastion, alquiloya, etc.).
-- =============================================================================

-- chat_conversation_tags ------------------------------------------------------
CREATE TABLE IF NOT EXISTS triple7.chat_conversation_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  description text,
  color text,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_t7_chat_conv_tags_empresa_code
  ON triple7.chat_conversation_tags (empresa_id, code);
CREATE INDEX IF NOT EXISTS idx_t7_chat_conv_tags_empresa
  ON triple7.chat_conversation_tags (empresa_id, code);

-- chat_conversation_tag_rules -------------------------------------------------
CREATE TABLE IF NOT EXISTS triple7.chat_conversation_tag_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  channel_id uuid,
  tag_id uuid NOT NULL REFERENCES triple7.chat_conversation_tags(id) ON DELETE RESTRICT,
  name text NOT NULL,
  description text,
  -- En esta fase NO queremos que las reglas estén operativas:
  --   is_active = false (no listas en el ejecutor real)
  --   shadow_mode = true (cualquier dry-run reporta sin tocar conversación)
  is_active boolean NOT NULL DEFAULT false,
  shadow_mode boolean NOT NULL DEFAULT true,
  days_without_activity integer NOT NULL DEFAULT 3 CHECK (days_without_activity >= 1),
  purchase_condition text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  exclude_human_taken_over boolean NOT NULL DEFAULT true,
  exclude_active_bot_session boolean NOT NULL DEFAULT true,
  exclude_manual_closure boolean NOT NULL DEFAULT true,
  recontact_exclusion boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_t7_chat_conv_tag_rules_empresa_active
  ON triple7.chat_conversation_tag_rules (empresa_id, is_active, shadow_mode);

-- chat_conversation_tag_history ----------------------------------------------
CREATE TABLE IF NOT EXISTS triple7.chat_conversation_tag_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  contact_id uuid,
  previous_tag_id uuid,
  new_tag_id uuid,
  rule_id uuid,
  action text NOT NULL CHECK (action IN ('applied','replaced','cleared','dry_run')),
  reason text,
  source text NOT NULL DEFAULT 'auto_rule' CHECK (source IN ('auto_rule','manual','client_replied','dry_run')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_t7_chat_conv_tag_history_conv_created
  ON triple7.chat_conversation_tag_history (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_t7_chat_conv_tag_history_empresa_created
  ON triple7.chat_conversation_tag_history (empresa_id, created_at DESC);

-- chat_conversations: columnas NULLABLE sin default ---------------------------
-- Decisión técnica (sorteo activo, tabla caliente con 4.461 filas):
-- añadir columnas NULLABLE sin DEFAULT y sin NOT NULL evita CUALQUIER reescritura
-- de tabla en PG 15: la operación es metadata-only y casi instantánea, sin lock
-- prolongado sobre la tabla. Las consultas que usan estas columnas deben usar
-- COALESCE(hidden_by_tag, false) para tratar NULL como "no oculta".
ALTER TABLE triple7.chat_conversations
  ADD COLUMN IF NOT EXISTS current_tag_id uuid,
  ADD COLUMN IF NOT EXISTS hidden_by_tag boolean,
  ADD COLUMN IF NOT EXISTS hidden_by_tag_at timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_by_tag_rule_id uuid,
  ADD COLUMN IF NOT EXISTS last_tagged_at timestamptz,
  ADD COLUMN IF NOT EXISTS tag_reactivated_at timestamptz;

-- FKs: la columna está vacía (todas NULL) por lo que la validación es trivial.
-- Aún así protegemos con un DO block que sólo crea las FKs si no existen.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_t7_chat_conv_current_tag'
       AND connamespace = 'triple7'::regnamespace
  ) THEN
    ALTER TABLE triple7.chat_conversations
      ADD CONSTRAINT fk_t7_chat_conv_current_tag
      FOREIGN KEY (current_tag_id)
      REFERENCES triple7.chat_conversation_tags(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_t7_chat_conv_hidden_rule'
       AND connamespace = 'triple7'::regnamespace
  ) THEN
    ALTER TABLE triple7.chat_conversations
      ADD CONSTRAINT fk_t7_chat_conv_hidden_rule
      FOREIGN KEY (hidden_by_tag_rule_id)
      REFERENCES triple7.chat_conversation_tag_rules(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Índices nuevos en chat_conversations (sólo metadata + scan vacío) ----------
CREATE INDEX IF NOT EXISTS idx_t7_chat_conv_hidden_by_tag_lm
  ON triple7.chat_conversations (hidden_by_tag, last_message_at DESC NULLS LAST)
  WHERE hidden_by_tag = true;
CREATE INDEX IF NOT EXISTS idx_t7_chat_conv_current_tag
  ON triple7.chat_conversations (current_tag_id)
  WHERE current_tag_id IS NOT NULL;

-- Semillas de etiquetas del sistema (idempotentes) ----------------------------
-- 5 etiquetas alineadas con el modelo del cliente. Las categorías 'repurchased'
-- y 'abandoned' que pueda devolver la función chat_tag_purchase_category quedan
-- sin tag mapeada en esta fase; el dry-run las reportará en sus conteos pero
-- ninguna regla las consume.
INSERT INTO triple7.chat_conversation_tags
  (empresa_id, code, label, description, color, is_system, sort_order)
VALUES
  ('82f8a15a-5dd6-48d9-99b3-97210b5130bd'::uuid, 'compro_boleta',         'Compró boleta',          'Cliente realizó una compra confirmada',                          '#16a34a', true, 10),
  ('82f8a15a-5dd6-48d9-99b3-97210b5130bd'::uuid, 'compro_varias',         'Compró varias boletas',  'Cliente compró múltiples boletas en una misma orden',            '#15803d', true, 20),
  ('82f8a15a-5dd6-48d9-99b3-97210b5130bd'::uuid, 'comprobante_pendiente', 'Comprobante sin finalizar', 'Comprobante recibido pero pago aún no validado',              '#f59e0b', true, 30),
  ('82f8a15a-5dd6-48d9-99b3-97210b5130bd'::uuid, 'datos_incompletos',     'Datos incompletos',      'Cliente no completó cédula / nombre / apellido y no tiene entradas', '#a855f7', true, 40),
  ('82f8a15a-5dd6-48d9-99b3-97210b5130bd'::uuid, 'no_compro',             'No compró',              'Sin compra confirmada después del último mensaje',               '#94a3b8', true, 50)
ON CONFLICT (empresa_id, code) DO NOTHING;

-- Semillas de reglas (todas en modo seguro: is_active=false + shadow_mode=true) ---
-- Cada regla apunta a una categoría que la función chat_tag_purchase_category
-- devuelve. Días sin actividad = 3 por defecto (el dry-run lo respeta).
INSERT INTO triple7.chat_conversation_tag_rules
  (empresa_id, tag_id, name, description, is_active, shadow_mode, days_without_activity,
   purchase_condition, priority, exclude_human_taken_over, exclude_active_bot_session, exclude_manual_closure)
SELECT
  '82f8a15a-5dd6-48d9-99b3-97210b5130bd'::uuid,
  t.id,
  CASE t.code
    WHEN 'compro_boleta' THEN 'Compró boleta (1 boleto)'
    WHEN 'compro_varias' THEN 'Compró varias boletas'
    WHEN 'comprobante_pendiente' THEN 'Comprobante sin finalizar'
    WHEN 'datos_incompletos' THEN 'Datos incompletos'
    WHEN 'no_compro' THEN 'No compró'
  END,
  CASE t.code
    WHEN 'compro_boleta' THEN 'Cliente con 1 entrada confirmada en el sorteo activo'
    WHEN 'compro_varias' THEN 'Cliente con más de 1 entrada en una misma orden'
    WHEN 'comprobante_pendiente' THEN 'Cliente envió comprobante pero el pago aún no se confirmó'
    WHEN 'datos_incompletos' THEN 'Cliente no completó cédula / nombre / apellido y no tiene entradas'
    WHEN 'no_compro' THEN 'Cliente sin compra confirmada después del último mensaje'
  END,
  false,        -- is_active: regla NO se ejecuta automáticamente
  true,         -- shadow_mode: cualquier dry-run NO afecta conversación
  3,            -- días sin actividad
  CASE t.code
    WHEN 'compro_boleta' THEN 'purchased_once'
    WHEN 'compro_varias' THEN 'purchased_multiple_tickets'
    WHEN 'comprobante_pendiente' THEN 'payment_received_incomplete'
    WHEN 'datos_incompletos' THEN 'data_incomplete'
    WHEN 'no_compro' THEN 'no_purchase'
  END,
  CASE t.code
    WHEN 'compro_boleta' THEN 10
    WHEN 'compro_varias' THEN 20
    WHEN 'comprobante_pendiente' THEN 30
    WHEN 'datos_incompletos' THEN 40
    WHEN 'no_compro' THEN 50
  END,
  true, true, true
FROM triple7.chat_conversation_tags t
WHERE t.empresa_id = '82f8a15a-5dd6-48d9-99b3-97210b5130bd'::uuid
  AND t.code IN ('compro_boleta','compro_varias','comprobante_pendiente','datos_incompletos','no_compro')
  AND NOT EXISTS (
    SELECT 1 FROM triple7.chat_conversation_tag_rules r
     WHERE r.empresa_id = '82f8a15a-5dd6-48d9-99b3-97210b5130bd'::uuid
       AND r.tag_id = t.id
  );

-- Función chat_tag_purchase_category(conversation_id) -------------------------
-- READ-ONLY (STABLE, SECURITY INVOKER). Adaptada para Triple 7:
--   - Señal primaria de compra = existencia de fila en triple7.sorteo_entradas
--     vía chat_conversation_id (NO usa estado_pago administrativo).
--   - Refuerzo via chat_flow_data: `numero_orden`/`cupones` indica que el flujo
--     finalizó la compra independientemente del estado de validación.
--   - Comprobante pendiente: chat_comprobante_validaciones con estado distinto
--     de aprobado/confirmado/rechazado/descartado.
--   - Abandonado: chat_flow_sessions.status='abandoned' o end_reason='abandoned'.
--   - Datos incompletos: faltan cédula / nombre / apellido en chat_flow_data.
-- NO consulta triple7.sorteo_ticket_deliveries: RAM está en text_only y no
-- genera deliveries, por lo que ticket entregado NO es señal aplicable.
CREATE OR REPLACE FUNCTION triple7.chat_tag_purchase_category(p_conversation_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = triple7, pg_catalog
AS $func$
DECLARE
  v_entrada_count integer := 0;
  v_distinct_sorteos integer := 0;
  v_total_boletos integer := 0;
  v_has_orden_in_flow_data boolean := false;
  v_pending_validations integer := 0;
  v_has_cedula boolean := false;
  v_has_nombre boolean := false;
  v_has_apellido boolean := false;
  v_abandoned boolean := false;
BEGIN
  IF p_conversation_id IS NULL THEN
    RETURN 'unknown';
  END IF;

  -- 1) Compra confirmada (señal primaria): entradas asociadas a la conversación
  SELECT
    COUNT(*),
    COUNT(DISTINCT sorteo_id),
    COALESCE(SUM(GREATEST(COALESCE(cantidad_boletos, 1), 1)), 0)
    INTO v_entrada_count, v_distinct_sorteos, v_total_boletos
  FROM triple7.sorteo_entradas
  WHERE chat_conversation_id = p_conversation_id;

  -- 1b) Refuerzo: el flujo guardó número de orden / cupones (proxy de compra)
  SELECT EXISTS (
    SELECT 1
    FROM triple7.chat_flow_data
    WHERE conversation_id = p_conversation_id
      AND lower(coalesce(field_name, '')) IN ('numero_orden','orden','cupones','cupon','codigos_cupones')
      AND coalesce(field_value, '') <> ''
  ) INTO v_has_orden_in_flow_data;

  IF v_entrada_count > 0 OR v_has_orden_in_flow_data THEN
    IF v_distinct_sorteos > 1 THEN
      RETURN 'repurchased';
    ELSIF v_total_boletos > 1 THEN
      RETURN 'purchased_multiple_tickets';
    ELSE
      RETURN 'purchased_once';
    END IF;
  END IF;

  -- 2) Comprobante pendiente (sin compra cerrada todavía)
  SELECT COUNT(*) INTO v_pending_validations
  FROM triple7.chat_comprobante_validaciones
  WHERE conversation_id = p_conversation_id
    AND COALESCE(estado_validacion, '') NOT IN ('', 'rechazado', 'descartado', 'aprobado', 'confirmado');

  IF v_pending_validations > 0 THEN
    RETURN 'payment_received_incomplete';
  END IF;

  -- 3) Sesión abandonada
  SELECT EXISTS (
    SELECT 1
    FROM triple7.chat_flow_sessions
    WHERE conversation_id = p_conversation_id
      AND (status = 'abandoned' OR COALESCE(end_reason, '') = 'abandoned')
  ) INTO v_abandoned;

  IF v_abandoned THEN
    RETURN 'abandoned';
  END IF;

  -- 4) Datos básicos del cliente en chat_flow_data
  SELECT
    bool_or(lower(coalesce(field_name, '')) IN ('cedula','documento','ci','dni') AND coalesce(field_value, '') <> ''),
    bool_or(lower(coalesce(field_name, '')) IN ('nombre','first_name') AND coalesce(field_value, '') <> ''),
    bool_or(lower(coalesce(field_name, '')) IN ('apellido','last_name','surname') AND coalesce(field_value, '') <> '')
    INTO v_has_cedula, v_has_nombre, v_has_apellido
  FROM triple7.chat_flow_data
  WHERE conversation_id = p_conversation_id;

  IF NOT COALESCE(v_has_cedula, false)
     OR NOT COALESCE(v_has_nombre, false)
     OR NOT COALESCE(v_has_apellido, false) THEN
    RETURN 'data_incomplete';
  END IF;

  RETURN 'no_purchase';
END;
$func$;

COMMENT ON FUNCTION triple7.chat_tag_purchase_category(uuid) IS
  'Etiquetas Automáticas Triple 7 FASE 1: clasifica el estado de compra de una conversación. READ-ONLY.';
