-- Flight Viewer — initial schema
-- Creates: aircraft_states, user_preferences, RLS policies, realtime publication.

-- ------------------------------------------------------------------
-- aircraft_states — one row per aircraft, keyed on icao24.
-- Fields mirror OpenSky state-vector layout (so the worker can upsert directly).
-- ------------------------------------------------------------------
create table if not exists aircraft_states (
  icao24 text primary key,
  callsign text,
  origin_country text,
  time_position bigint,
  last_contact bigint not null,
  longitude double precision,
  latitude double precision,
  baro_altitude real,
  on_ground boolean not null default false,
  velocity real,
  true_track real,
  vertical_rate real,
  geo_altitude real,
  squawk text,
  spi boolean not null default false,
  position_source smallint,
  category smallint,
  updated_at timestamptz not null default now()
);

create index if not exists aircraft_states_last_contact_idx
  on aircraft_states (last_contact desc);
create index if not exists aircraft_states_origin_country_idx
  on aircraft_states (origin_country);
create index if not exists aircraft_states_lat_lon_idx
  on aircraft_states (latitude, longitude);

-- ------------------------------------------------------------------
-- user_preferences — keyed on Clerk user_id (string).
-- ------------------------------------------------------------------
create table if not exists user_preferences (
  user_id text primary key,
  favorites text[] not null default '{}',
  filter_countries text[] not null default '{}',
  filter_airlines text[] not null default '{}',
  altitude_min real,
  altitude_max real,
  show_on_ground boolean not null default true,
  region_lat double precision,
  region_lon double precision,
  region_radius_km real,
  theme text not null default 'day' check (theme in ('day', 'night', 'blue-marble')),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------
-- Row-level security
-- ------------------------------------------------------------------
alter table aircraft_states enable row level security;
alter table user_preferences enable row level security;

-- Everyone can read aircraft; writes are service-role only (RLS blocks anon/authed writes by default).
drop policy if exists "aircraft readable by all" on aircraft_states;
create policy "aircraft readable by all" on aircraft_states
  for select using (true);

-- Users can read/write only their own preferences row. Clerk JWT "sub" claim
-- is mapped to user_id by the Supabase JWT verifier.
drop policy if exists "users read own prefs" on user_preferences;
create policy "users read own prefs" on user_preferences
  for select using ((auth.jwt() ->> 'sub') = user_id);

drop policy if exists "users insert own prefs" on user_preferences;
create policy "users insert own prefs" on user_preferences
  for insert with check ((auth.jwt() ->> 'sub') = user_id);

drop policy if exists "users update own prefs" on user_preferences;
create policy "users update own prefs" on user_preferences
  for update using ((auth.jwt() ->> 'sub') = user_id);

-- ------------------------------------------------------------------
-- Realtime publication — so the browser receives upsert events for aircraft_states.
-- ------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'aircraft_states'
  ) then
    alter publication supabase_realtime add table aircraft_states;
  end if;
end $$;
