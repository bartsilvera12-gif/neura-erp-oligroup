-- =============================================================================
-- PENDIENTES TRIPLE 7 — correr en Supabase → SQL Editor, en este orden.
--
-- Paso previo al BLOQUE 3: crear el usuario en Authentication → Users
--   email: vendedorgeneral@triple7.com  ·  marcar "Auto Confirm User"
--
-- Bloques 1 y 2 son idempotentes: se pueden correr de nuevo sin romper nada.
-- Después de correrlos, verificá que el deploy de main ya esté arriba.
-- =============================================================================


-- =============================================================================
-- BLOQUE 1 — Módulo propio "Cupones manuales"
-- Sin esto, el ítem del menú no se puede otorgar sin dar todo el módulo Sorteos.
-- =============================================================================
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


-- =============================================================================
-- BLOQUE 2 — Vista de dashboard "Sorteos"
-- Sin esto, la pestaña Sorteos no aparece en el tablero.
-- =============================================================================
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


-- =============================================================================
-- BLOQUE 3 — Alta del usuario vendedor acotado a Cupones manuales
-- REQUIERE que vendedorgeneral@triple7.com ya exista en Supabase Auth.
-- =============================================================================
-- =============================================================================
-- Alta de usuario acotado a "Cupones manuales" (módulo `cupones-manuales`)
--   email: vendedorgeneral@triple7.com
--   rol:   usuario  (NO admin/administrador: esos ven todos los módulos de la empresa)
--
-- Schema operativo single_client: triple7 (NEURA_CLIENT_SCHEMA).
-- Si la instancia usa otro schema, reemplazar `triple7` en los dos `search_path`.
--
-- Paso previo: crear el usuario en Supabase Auth (Authentication → Users → Add user,
-- con "Auto Confirm User") o vía API admin, y luego correr este script:
-- vincula por email con auth.users y deja usuario_modulos = {cupones-manuales}.
-- =============================================================================

DO $$
DECLARE
  v_email        text := 'vendedorgeneral@triple7.com';
  v_nombre       text := 'Vendedor General';
  v_empresa_id   uuid;
  v_auth_user_id uuid;
  v_modulo_id    uuid;
  v_usuario_id   uuid;
BEGIN
  SET LOCAL search_path = triple7, public;

  -- 1) Usuario de Auth (debe existir; si no, crearlo antes en Authentication → Users)
  SELECT id INTO v_auth_user_id
  FROM auth.users
  WHERE lower(email) = lower(v_email)
  LIMIT 1;

  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'No existe % en auth.users. Creálo primero en Supabase → Authentication → Users (Auto Confirm User).', v_email;
  END IF;

  -- 2) Empresa destino (single_client: hay una sola)
  SELECT id INTO v_empresa_id
  FROM empresas
  ORDER BY created_at
  LIMIT 1;

  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No hay empresas en el schema operativo.';
  END IF;

  -- 3) Módulo propio de Cupones manuales (slug con el que se gatea /sorteos/cupones-manuales).
  --    Requiere la migración 20260930120000_modulo_cupones_manuales.sql.
  SELECT id INTO v_modulo_id FROM modulos WHERE slug = 'cupones-manuales' LIMIT 1;

  IF v_modulo_id IS NULL THEN
    INSERT INTO modulos (id, nombre, slug)
    VALUES (gen_random_uuid(), 'Cupones manuales', 'cupones-manuales')
    RETURNING id INTO v_modulo_id;
  END IF;

  -- 4) El módulo tiene que estar activo para la empresa (lo exige el trigger de usuario_modulos)
  UPDATE empresa_modulos
     SET activo = true
   WHERE empresa_id = v_empresa_id AND modulo_id = v_modulo_id;

  IF NOT FOUND THEN
    INSERT INTO empresa_modulos (empresa_id, modulo_id, activo)
    VALUES (v_empresa_id, v_modulo_id, true);
  END IF;

  -- 5) Fila de catálogo en usuarios (idempotente por email, sin asumir índice único)
  SELECT id INTO v_usuario_id FROM usuarios WHERE lower(email) = lower(v_email) LIMIT 1;

  IF v_usuario_id IS NULL THEN
    INSERT INTO usuarios (empresa_id, email, nombre, rol, estado, area, auth_user_id)
    VALUES (v_empresa_id, lower(v_email), v_nombre, 'usuario', 'activo', 'ventas', v_auth_user_id)
    RETURNING id INTO v_usuario_id;
  ELSE
    UPDATE usuarios
       SET empresa_id   = v_empresa_id,
           nombre       = v_nombre,
           rol          = 'usuario',
           estado       = 'activo',
           auth_user_id = v_auth_user_id
     WHERE id = v_usuario_id;
  END IF;

  -- 6) Permisos: SOLO el módulo cupones-manuales (borra cualquier otro previo).
  --    Ojo: NO otorgar `sorteos`, que por alias también habilita esta pantalla y todo el resto.
  DELETE FROM usuario_modulos WHERE usuario_id = v_usuario_id AND modulo_id <> v_modulo_id;

  INSERT INTO usuario_modulos (usuario_id, modulo_id)
  VALUES (v_usuario_id, v_modulo_id)
  ON CONFLICT (usuario_id, modulo_id) DO NOTHING;

  RAISE NOTICE 'OK · usuario=% · empresa=% · modulos={cupones-manuales}', v_usuario_id, v_empresa_id;
END
$$;

-- Verificación
SET search_path = triple7, public;

SELECT u.id, u.email, u.rol, u.estado, u.empresa_id, u.auth_user_id,
       coalesce(string_agg(m.slug, ', ' ORDER BY m.slug), '(sin módulos)') AS modulos
FROM usuarios u
LEFT JOIN usuario_modulos um ON um.usuario_id = u.id
LEFT JOIN modulos m ON m.id = um.modulo_id
WHERE lower(u.email) = 'vendedorgeneral@triple7.com'
GROUP BY u.id, u.email, u.rol, u.estado, u.empresa_id, u.auth_user_id;
