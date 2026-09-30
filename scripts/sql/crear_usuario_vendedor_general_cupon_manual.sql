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
