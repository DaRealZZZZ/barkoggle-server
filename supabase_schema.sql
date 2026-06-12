-- BarkOggle: Cloud-Save Tabelle
-- Im Supabase Dashboard -> SQL Editor einfuegen und "Run" druecken.

create table if not exists public.profiles (
  device_id   text primary key,
  nick        text,
  coat        text,
  overall_elo integer not null default 1000,
  data        jsonb   not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- v1: Geraet-ID-basiert (kein Login noetig). Fuer Spass-Daten ok.
-- WICHTIG: Sobald es um echtes Geld geht (VIP/Skins per Stripe),
-- duerfen diese Felder NICHT mehr vom Client schreibbar sein -
-- dann setzt der Stripe-Webhook (Server, Service-Key) die Rechte.

drop policy if exists "read all"   on public.profiles;
drop policy if exists "insert any" on public.profiles;
drop policy if exists "update any" on public.profiles;

create policy "read all"   on public.profiles for select to anon using (true);
create policy "insert any" on public.profiles for insert to anon with check (true);
create policy "update any" on public.profiles for update to anon using (true) with check (true);

-- Optional: schnelle Bestenliste spaeter
create index if not exists profiles_elo_idx on public.profiles (overall_elo desc);

-- ---- Echtgeld-Rechte (vom Server/Stripe-Webhook gesetzt) ----
alter table public.profiles
  add column if not exists paid_noads boolean not null default false,
  add column if not exists paid_vip boolean not null default false,
  add column if not exists paid_supporter boolean not null default false;

-- Browser (anon) darf diese Rechte-Spalten NICHT schreiben:
revoke insert on public.profiles from anon, authenticated;
revoke update on public.profiles from anon, authenticated;
grant insert (device_id, nick, coat, overall_elo, data, updated_at) on public.profiles to anon, authenticated;
grant update (nick, coat, overall_elo, data, updated_at) on public.profiles to anon, authenticated;
