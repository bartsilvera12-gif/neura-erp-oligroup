-- Cambios de estructura aplicados por el Agente IA (ticket #688, neura-erp-oligroup). Ya están en la base.

-- Guardar suscripciones Web Push por usuario y dispositivo, aisladas por empresa
create table if not exists oligroup.push_suscripciones (id uuid primary key default gen_random_uuid(), empresa_id uuid not null, usuario_id uuid not null, endpoint text not null unique, p256dh text not null, auth text not null, user_agent text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on "oligroup".push_suscripciones to anon;
grant INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on "oligroup".push_suscripciones to authenticated;
grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on "oligroup".push_suscripciones to service_role;
alter table "oligroup".push_suscripciones enable row level security;
create policy push_suscripciones_delete_1 on "oligroup".push_suscripciones for delete to public using (oligroup.puede_acceder_empresa(empresa_id));
create policy push_suscripciones_insert_2 on "oligroup".push_suscripciones for insert to public with check (oligroup.puede_acceder_empresa(empresa_id));
create policy push_suscripciones_select_3 on "oligroup".push_suscripciones for select to public using (oligroup.puede_acceder_empresa(empresa_id));
create policy push_suscripciones_update_4 on "oligroup".push_suscripciones for update to public using (oligroup.puede_acceder_empresa(empresa_id)) with check (oligroup.puede_acceder_empresa(empresa_id));

-- Garantizar un solo aviso push por pedido de asesor
create table if not exists oligroup.push_avisos_enviados (id uuid primary key default gen_random_uuid(), empresa_id uuid not null, conversation_id uuid not null, clave text not null, motivo text, created_at timestamptz not null default now(), unique (conversation_id, clave));
grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on "oligroup".push_avisos_enviados to anon;
grant INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on "oligroup".push_avisos_enviados to authenticated;
grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on "oligroup".push_avisos_enviados to service_role;
alter table "oligroup".push_avisos_enviados enable row level security;
create policy push_avisos_enviados_delete_1 on "oligroup".push_avisos_enviados for delete to public using (oligroup.puede_acceder_empresa(empresa_id));
create policy push_avisos_enviados_insert_2 on "oligroup".push_avisos_enviados for insert to public with check (oligroup.puede_acceder_empresa(empresa_id));
create policy push_avisos_enviados_select_3 on "oligroup".push_avisos_enviados for select to public using (oligroup.puede_acceder_empresa(empresa_id));
create policy push_avisos_enviados_update_4 on "oligroup".push_avisos_enviados for update to public using (oligroup.puede_acceder_empresa(empresa_id)) with check (oligroup.puede_acceder_empresa(empresa_id));
