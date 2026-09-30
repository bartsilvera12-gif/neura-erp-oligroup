-- =============================================================================
-- Vista de dashboard "Sorteos" (pestaña con ventas manuales vs bot)
--
-- Se replica en todo schema que tenga el catálogo `dashboard_views`
-- (public, zentra_erp, triple7, erp_*, er_*), igual que el resto del ERP.
--
-- Habilitación: se activa para todas las empresas (empresa_dashboard_views). El acceso
-- por usuario sigue la regla existente — `usuario_dashboard_views` vacío = todas las de la
-- empresa — y el endpoint que alimenta la pestaña exige rol admin de empresa o super_admin,
-- así que un operador acotado al cupón manual no ve estos totales aunque abra la pestaña.
-- =============================================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'dashboard_views'
      AND c.relkind = 'r'
      AND (
        n.nspname IN ('public', 'zentra_erp', 'triple7')
        OR n.nspname ~ '^er_[0-9a-f]{32}$'
        OR n.nspname LIKE 'erp\_%' ESCAPE '\'
      )
    ORDER BY 1
  LOOP
    EXECUTE format(
      $sql$
      INSERT INTO %I.dashboard_views (slug, nombre, orden, activo)
      VALUES ('sorteos', 'Sorteos', 50, true)
      ON CONFLICT (slug) DO UPDATE SET
        nombre = EXCLUDED.nombre,
        orden  = EXCLUDED.orden,
        activo = true
      $sql$,
      r.sch
    );

    /* Algunos schemas tienen el catálogo pero no las tablas de habilitación ni `empresas`. */
    IF to_regclass(format('%I.empresa_dashboard_views', r.sch)) IS NULL
       OR to_regclass(format('%I.empresas', r.sch)) IS NULL THEN
      CONTINUE;
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
      r.sch, r.sch, r.sch, r.sch
    );
  END LOOP;
END $$;
