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
-- Acotada al schema de Triple 7. Esta base aloja un schema por cliente y catálogos
-- compartidos en `public` / `zentra_erp`: dar de alta el módulo ahí se lo agregaría a
-- clientes que no lo pidieron y que corren otro deploy.
--
-- Para otra instancia, cambiar `v_schema`.
-- =============================================================================

DO $$
DECLARE
  v_schema text := 'triple7';
BEGIN
  IF to_regclass(format('%I.modulos', v_schema)) IS NULL THEN
    RAISE EXCEPTION 'No existe %.modulos — revisá el nombre del schema.', v_schema;
  END IF;

  -- 1) Catálogo
  EXECUTE format(
    $sql$
    INSERT INTO %I.modulos (id, nombre, slug)
    SELECT gen_random_uuid(), 'Cupones manuales', 'cupones-manuales'
    WHERE NOT EXISTS (SELECT 1 FROM %I.modulos WHERE slug = 'cupones-manuales')
    $sql$,
    v_schema, v_schema
  );

  IF to_regclass(format('%I.empresa_modulos', v_schema)) IS NULL THEN
    RAISE NOTICE 'Sin %.empresa_modulos: el módulo queda solo en el catálogo.', v_schema;
    RETURN;
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
    v_schema, v_schema, v_schema, v_schema, v_schema
  );
END $$;
