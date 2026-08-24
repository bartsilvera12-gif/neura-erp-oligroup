-- =============================================================================
-- Bloque de VIDEO en nodos de flujo.
--
-- Permite que el nodo `media` mande un video (mp4/3gpp) en vez de una imagen,
-- p. ej. el mensaje de bienvenida de un sorteo.
--
-- Aditiva: solo amplia el CHECK de block_type. No toca datos existentes ni
-- cambia el comportamiento de los bloques 'text' / 'image' / 'buttons'.
--
-- Aplica a TODOS los schemas que tengan la tabla (public, zentra_erp, erp_*,
-- er_*, y schemas de tenant con nombre libre como `triple7`), buscando el
-- CHECK por su definicion y no por su nombre, que puede variar por schema.
-- =============================================================================

DO $$
DECLARE
  sch text;
  con text;
BEGIN
  FOR sch IN
    SELECT n.nspname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'chat_flow_node_blocks'
      AND c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1
  LOOP
    -- Quita cualquier CHECK que mencione block_type (nombre auto-generado variable).
    FOR con IN
      SELECT co.conname
      FROM pg_constraint co
      JOIN pg_class c2 ON c2.oid = co.conrelid
      JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
      WHERE n2.nspname = sch
        AND c2.relname = 'chat_flow_node_blocks'
        AND co.contype = 'c'
        AND pg_get_constraintdef(co.oid) ILIKE '%block_type%'
    LOOP
      EXECUTE format('ALTER TABLE %I.chat_flow_node_blocks DROP CONSTRAINT %I', sch, con);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE %I.chat_flow_node_blocks ADD CONSTRAINT chat_flow_node_blocks_block_type_check '
      || 'CHECK (block_type IN (''text'', ''image'', ''video'', ''buttons''))',
      sch
    );

    RAISE NOTICE 'chat_flow_node_blocks.block_type ahora acepta video en schema %', sch;
  END LOOP;
END $$;
