-- Claves VAPID del servidor para Web Push. Se generan solas la primera vez que se usan
-- (src/lib/push/web-push.ts → loadVapidConfig). Solo el service role las lee: RLS sin políticas.
create table if not exists oligroup.push_vapid_claves (
  id smallint primary key default 1 check (id = 1),
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);
revoke all on oligroup.push_vapid_claves from anon, authenticated;
grant select, insert on oligroup.push_vapid_claves to service_role;
alter table oligroup.push_vapid_claves enable row level security;
