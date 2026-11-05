-- =============================================================================
-- Sorteos: vínculo venta -> factura electrónica (facturación manual).
-- Aditivo (ADD COLUMN IF NOT EXISTS) + FK a facturas + índice. Réplica multi-schema.
-- Habilita el control de duplicados: una venta facturada queda con factura_id.
-- =============================================================================

-- public
ALTER TABLE public.sorteo_entradas
  ADD COLUMN IF NOT EXISTS factura_id uuid,
  ADD COLUMN IF NOT EXISTS facturado_at timestamptz;
ALTER TABLE public.sorteo_entradas DROP CONSTRAINT IF EXISTS sorteo_entradas_factura_id_fkey;
ALTER TABLE public.sorteo_entradas ADD CONSTRAINT sorteo_entradas_factura_id_fkey
  FOREIGN KEY (factura_id) REFERENCES public.facturas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS sorteo_entradas_factura_id_idx ON public.sorteo_entradas (factura_id);
COMMENT ON COLUMN public.sorteo_entradas.factura_id IS
  'Factura electrónica emitida para esta venta (NULL = sin facturar). Control de duplicados.';
COMMENT ON COLUMN public.sorteo_entradas.facturado_at IS
  'Momento en que se emitió la factura para esta venta.';

-- zentra_erp (plantilla por defecto)
ALTER TABLE zentra_erp.sorteo_entradas
  ADD COLUMN IF NOT EXISTS factura_id uuid,
  ADD COLUMN IF NOT EXISTS facturado_at timestamptz;
ALTER TABLE zentra_erp.sorteo_entradas DROP CONSTRAINT IF EXISTS sorteo_entradas_factura_id_fkey;
ALTER TABLE zentra_erp.sorteo_entradas ADD CONSTRAINT sorteo_entradas_factura_id_fkey
  FOREIGN KEY (factura_id) REFERENCES zentra_erp.facturas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS sorteo_entradas_factura_id_idx ON zentra_erp.sorteo_entradas (factura_id);

-- Schemas tenant (erp_* / er_* / single-client oligroup) que tengan ambas tablas
DO $$
DECLARE
  sch text;
BEGIN
  FOR sch IN
    SELECT nspname::text
    FROM pg_namespace
    WHERE (nspname ~ '^erp_[a-zA-Z0-9_]+$' OR nspname ~ '^er_[0-9a-f]{32}$' OR nspname = 'oligroup')
      AND EXISTS (SELECT 1 FROM information_schema.tables t
                  WHERE t.table_schema = nspname AND t.table_name = 'sorteo_entradas')
      AND EXISTS (SELECT 1 FROM information_schema.tables t
                  WHERE t.table_schema = nspname AND t.table_name = 'facturas')
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %1$I.sorteo_entradas
           ADD COLUMN IF NOT EXISTS factura_id uuid,
           ADD COLUMN IF NOT EXISTS facturado_at timestamptz;
         ALTER TABLE %1$I.sorteo_entradas DROP CONSTRAINT IF EXISTS sorteo_entradas_factura_id_fkey;
         ALTER TABLE %1$I.sorteo_entradas ADD CONSTRAINT sorteo_entradas_factura_id_fkey
           FOREIGN KEY (factura_id) REFERENCES %1$I.facturas(id) ON DELETE SET NULL;
         CREATE INDEX IF NOT EXISTS sorteo_entradas_factura_id_idx ON %1$I.sorteo_entradas (factura_id);',
        sch
      );
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'sorteo_entradas factura link skipped for schema %', sch;
    END;
  END LOOP;
END;
$$;
