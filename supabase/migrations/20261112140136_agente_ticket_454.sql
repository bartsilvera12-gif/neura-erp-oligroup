-- Cambios de estructura aplicados por el Agente IA (ticket #454, neura-erp-oligroup). Ya están en la base.

-- Guardar boletas anuladas (comprador, motivo) y bloquear sus números para que no se reasignen
create table if not exists oligroup.sorteo_cupones_anulados (id uuid primary key default gen_random_uuid(), empresa_id uuid not null, sorteo_id uuid not null, numero_cupon text not null, coupon_number_value integer, entrada_id_original uuid, numero_orden integer, nombre_participante text, whatsapp_numero text, documento text, cantidad_boletos integer, monto_total numeric, estado_pago_al_anular text, motivo text, anulado_por text, anulado_at timestamptz not null default now(), created_at timestamptz not null default now());
grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on "oligroup".sorteo_cupones_anulados to anon;
grant INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on "oligroup".sorteo_cupones_anulados to authenticated;
grant TRIGGER, REFERENCES, TRUNCATE, DELETE, UPDATE, SELECT, INSERT on "oligroup".sorteo_cupones_anulados to service_role;
alter table "oligroup".sorteo_cupones_anulados enable row level security;
create policy sorteo_cupones_anulados_delete_1 on "oligroup".sorteo_cupones_anulados for delete to public using (oligroup.puede_acceder_empresa(empresa_id));
create policy sorteo_cupones_anulados_insert_2 on "oligroup".sorteo_cupones_anulados for insert to public with check (oligroup.puede_acceder_empresa(empresa_id));
create policy sorteo_cupones_anulados_select_3 on "oligroup".sorteo_cupones_anulados for select to public using (oligroup.puede_acceder_empresa(empresa_id));
create policy sorteo_cupones_anulados_update_4 on "oligroup".sorteo_cupones_anulados for update to public using (oligroup.puede_acceder_empresa(empresa_id)) with check (oligroup.puede_acceder_empresa(empresa_id));

-- Evitar bloquear dos veces el mismo número
create unique index if not exists sorteo_cupones_anulados_sorteo_numero_uq on oligroup.sorteo_cupones_anulados (sorteo_id, numero_cupon);
