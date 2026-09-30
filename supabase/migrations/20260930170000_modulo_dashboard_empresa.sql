-- =============================================================================
-- Módulo "Dashboard" habilitado para la empresa
--
-- El ítem Dashboard del menú se gatea con el slug `dashboard` (ver route-slug-map:
-- la ruta `/` pide ese módulo). Si la empresa no lo tiene en `empresa_modulos`, el
-- tablero no aparece en el sidebar ni siquiera para un admin, porque el admin ve
-- "todos los módulos de la empresa" y ahí ese módulo no está.
--
-- Esta migración da de alta el módulo en el catálogo si falta y lo activa para todas
-- las empresas. NO se lo otorga a ningún usuario en particular: los admins lo ven por
-- ser admins, y un usuario con `usuario_modulos` acotado (p. ej. el vendedor de cupón
-- manual) sigue sin verlo.
--
-- Se replica en todo schema que tenga el catálogo `modulos`.
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
    EXECUTE format(
      $sql$
      INSERT INTO %I.modulos (id, nombre, slug)
      SELECT gen_random_uuid(), 'Dashboard', 'dashboard'
      WHERE NOT EXISTS (SELECT 1 FROM %I.modulos WHERE slug = 'dashboard')
      $sql$,
      r.sch, r.sch
    );

    IF to_regclass(format('%I.empresa_modulos', r.sch)) IS NULL
       OR to_regclass(format('%I.empresas', r.sch)) IS NULL THEN
      CONTINUE;
    END IF;

    /* Alta para las empresas que no lo tienen todavía. */
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
      r.sch, r.sch, r.sch, r.sch
    );

    /* Y reactivación si quedó en activo = false. */
    EXECUTE format(
      $sql$
      UPDATE %I.empresa_modulos em
         SET activo = true
        FROM %I.modulos m
       WHERE m.id = em.modulo_id
         AND m.slug = 'dashboard'
         AND em.activo IS DISTINCT FROM true
      $sql$,
      r.sch, r.sch
    );
  END LOOP;
END $$;
