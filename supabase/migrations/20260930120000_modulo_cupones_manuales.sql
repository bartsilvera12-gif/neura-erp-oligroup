-- =============================================================================
-- Módulo "Cupones manuales" (slug `cupones-manuales`)
--
-- Hasta ahora el ítem de menú Cupones manuales usaba el slug `sorteos`, por lo que
-- no se podía otorgar sin dar acceso a todo el módulo Sorteos. Se le da módulo propio.
--
-- Compatibilidad: `isModuleSlugGranted` trata `sorteos` como alias de
-- `cupones-manuales`, así que quien ya tenía Sorteos sigue viendo la pantalla
-- aunque no reciba filas nuevas.
--
-- Se replica en todo schema que tenga catálogo `modulos` (public, zentra_erp,
-- triple7, erp_*, er_*).
-- =============================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'modulos'
      AND c.relkind = 'r'
      AND (
        n.nspname IN ('public', 'zentra_erp', 'triple7')
        OR n.nspname ~ '^er_[0-9a-f]{32}$'
        OR n.nspname LIKE 'erp\_%' ESCAPE '\'
      )
    ORDER BY 1
  LOOP
    -- 1) Catálogo
    EXECUTE format(
      $sql$
      INSERT INTO %I.modulos (id, nombre, slug)
      SELECT gen_random_uuid(), 'Cupones manuales', 'cupones-manuales'
      WHERE NOT EXISTS (SELECT 1 FROM %I.modulos WHERE slug = 'cupones-manuales')
      $sql$,
      r.sch, r.sch
    );

    IF to_regclass(format('%I.empresa_modulos', r.sch)) IS NULL THEN
      CONTINUE;
    END IF;

    -- 2) Habilitado para toda empresa que ya tenga Sorteos activo (sin cambiar acceso efectivo)
    EXECUTE format(
      $sql$
      INSERT INTO %I.empresa_modulos (empresa_id, modulo_id, activo)
      SELECT em.empresa_id, nuevo.id, true
      FROM %I.empresa_modulos em
      JOIN %I.modulos sorteos ON sorteos.id = em.modulo_id AND sorteos.slug = 'sorteos'
      CROSS JOIN %I.modulos nuevo
      WHERE em.activo IS TRUE
        AND nuevo.slug = 'cupones-manuales'
        AND NOT EXISTS (
          SELECT 1 FROM %I.empresa_modulos x
          WHERE x.empresa_id = em.empresa_id AND x.modulo_id = nuevo.id
        )
      $sql$,
      r.sch, r.sch, r.sch, r.sch, r.sch
    );
  END LOOP;
END $$;
