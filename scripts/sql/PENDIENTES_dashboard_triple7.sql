-- =============================================================================
-- PENDIENTES TRIPLE 7 (v2) — acotadas al schema `triple7`.
-- Correr en Supabase → SQL Editor. Idempotentes.
-- =============================================================================

-- --- BLOQUE A: módulo Dashboard para la empresa (hace aparecer el ítem del menú)
-- =============================================================================
-- Módulo "Dashboard" habilitado para la empresa de Triple 7
--
-- El ítem Dashboard del menú se gatea con el slug `dashboard` (la ruta `/` lo pide).
-- Si la empresa no lo tiene en `empresa_modulos`, el tablero no aparece en el sidebar
-- ni para un admin, porque el admin ve "todos los módulos activos de su empresa" y ese
-- módulo no está entre ellos.
--
-- Acotada al schema de Triple 7: esta base aloja un schema por cliente y catálogos
-- compartidos en `public` / `zentra_erp`; habilitar módulos ahí se los activaría a
-- clientes que no lo pidieron.
--
-- No otorga el módulo a ningún usuario puntual: los admins lo ven por ser admins, y un
-- usuario con `usuario_modulos` acotado (el vendedor de cupón manual) sigue sin verlo.
-- =============================================================================

DO $$
DECLARE
  v_schema text := 'triple7';
BEGIN
  IF to_regclass(format('%I.modulos', v_schema)) IS NULL THEN
    RAISE EXCEPTION 'No existe %.modulos — revisá el nombre del schema.', v_schema;
  END IF;

  EXECUTE format(
    $sql$
    INSERT INTO %I.modulos (id, nombre, slug)
    SELECT gen_random_uuid(), 'Dashboard', 'dashboard'
    WHERE NOT EXISTS (SELECT 1 FROM %I.modulos WHERE slug = 'dashboard')
    $sql$,
    v_schema, v_schema
  );

  IF to_regclass(format('%I.empresa_modulos', v_schema)) IS NULL
     OR to_regclass(format('%I.empresas', v_schema)) IS NULL THEN
    RAISE EXCEPTION 'Faltan %.empresa_modulos o %.empresas', v_schema, v_schema;
  END IF;

  /* Alta para las empresas del schema que no lo tienen. */
  EXECUTE format(
    $sql$
    INSERT INTO %I.empresa_modulos (empresa_id, modulo_id, activo)
    SELECT e.id, m.id, true
    FROM %I.empresas e
    CROSS JOIN %I.modulos m
    WHERE m.slug = 'dashboard'
      AND NOT EXISTS (
        SELECT 1 FROM %I.empresa_modulos x
        WHERE x.empresa_id = e.id AND x.modulo_id = m.id
      )
    $sql$,
    v_schema, v_schema, v_schema, v_schema
  );

  /* Y reactivación si la fila existía con activo = false. */
  EXECUTE format(
    $sql$
    UPDATE %I.empresa_modulos em
       SET activo = true
      FROM %I.modulos m
     WHERE m.id = em.modulo_id
       AND m.slug = 'dashboard'
       AND em.activo IS DISTINCT FROM true
    $sql$,
    v_schema, v_schema
  );
END $$;


-- --- BLOQUE B: vista "Sorteos" del dashboard (la pestaña adentro del tablero)
-- =============================================================================
-- Vista de dashboard "Sorteos" (pestaña con ventas manuales vs bot)
--
-- Acotada al schema de Triple 7. Esta base Postgres aloja un schema por cliente
-- (abhuevos, acaihouse, casairala, …) y catálogos compartidos en `public` /
-- `zentra_erp`: tocar esos catálogos le agregaría la vista a clientes que no la
-- pidieron y que además corren otro deploy. Por eso un solo schema, explícito.
--
-- Para otra instancia, cambiar `v_schema`.
-- =============================================================================

DO $$
DECLARE
  v_schema text := 'triple7';
BEGIN
  IF to_regclass(format('%I.dashboard_views', v_schema)) IS NULL THEN
    RAISE EXCEPTION 'No existe %.dashboard_views — revisá el nombre del schema.', v_schema;
  END IF;

  EXECUTE format(
    $sql$
    INSERT INTO %I.dashboard_views (slug, nombre, orden, activo)
    VALUES ('sorteos', 'Sorteos', 50, true)
    ON CONFLICT (slug) DO UPDATE SET
      nombre = EXCLUDED.nombre,
      orden  = EXCLUDED.orden,
      activo = true
    $sql$,
    v_schema
  );

  IF to_regclass(format('%I.empresa_dashboard_views', v_schema)) IS NULL
     OR to_regclass(format('%I.empresas', v_schema)) IS NULL THEN
    RAISE NOTICE 'Sin tablas de habilitación en %: la vista queda en el catálogo.', v_schema;
    RETURN;
  END IF;

  EXECUTE format(
    $sql$
    INSERT INTO %I.empresa_dashboard_views (empresa_id, dashboard_view_id, activo)
    SELECT e.id, dv.id, true
    FROM %I.empresas e
    CROSS JOIN %I.dashboard_views dv
    WHERE dv.slug = 'sorteos'
      AND NOT EXISTS (
        SELECT 1 FROM %I.empresa_dashboard_views x
        WHERE x.empresa_id = e.id AND x.dashboard_view_id = dv.id
      )
    $sql$,
    v_schema, v_schema, v_schema, v_schema
  );
END $$;
