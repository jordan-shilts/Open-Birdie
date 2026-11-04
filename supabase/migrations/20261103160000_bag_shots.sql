-- The player's bag (lib/bag.js, lib/bag-supabase.js): every full launch-monitor shot,
-- kept for good, and the bag's resets. The game never updates or deletes a row.
--
--   shots       one row per shot. The game makes the id (a hash of the shot), so a
--               row it sends twice is stored once.
--   bag_resets  "forget the bag" markers: the bag is what was shot after the latest.
--   bag_shots   the bag: a player's shots after their latest reset, each ranked within
--               its club (1 = newest). The game reads rank <= 30.
--
-- The game has no sign-in. It calls the REST API with the project's publishable key
-- (role anon), which may read and insert and nothing else; signed-in users
-- (authenticated) get nothing.

create table public.shots (
  id uuid primary key default gen_random_uuid(),
  player text not null default 'default',
  club text not null,
  speed_mph double precision not null,
  vla double precision not null,
  hla double precision not null,
  total_spin integer not null,
  spin_axis double precision not null,
  at timestamptz not null default now(),
  course text,
  hole smallint,
  lie text,
  practice text,
  club_name text,
  created_at timestamptz not null default now(),
  constraint shots_player check (player ~ '^[A-Za-z0-9_.-]{1,64}$'),
  constraint shots_club check (club in ('DR', 'W3', 'H3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'PW', 'SW', 'LW')),
  -- physical ranges, far wider than any real launch; NaN and infinity fail them too
  constraint shots_speed check (speed_mph > 0 and speed_mph < 500),
  constraint shots_angles check (vla between -90 and 90 and hla between -180 and 180 and spin_axis between -180 and 180),
  constraint shots_spin check (total_spin between -50000 and 50000),
  constraint shots_hole check (hole between 1 and 999),
  constraint shots_text check (
    char_length(course) between 1 and 120 and char_length(lie) between 1 and 120
    and char_length(practice) between 1 and 120 and char_length(club_name) between 1 and 120
  )
);

comment on table public.shots is 'Every full launch-monitor shot (Open-Birdie lib/bag.js). Insert-only for the game.';
comment on column public.shots.at is 'When the shot was hit (the game''s clock).';
comment on column public.shots.created_at is 'When Supabase received it (later than at for a shot sent after a time offline).';

create index shots_bag on public.shots (player, club, at desc);

create table public.bag_resets (
  id uuid primary key default gen_random_uuid(),
  player text not null default 'default',
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint bag_resets_player check (player ~ '^[A-Za-z0-9_.-]{1,64}$')
);

comment on table public.bag_resets is 'Bag resets (Open-Birdie): the bag holds only shots after a player''s latest reset.';

create index bag_resets_player_at on public.bag_resets (player, at desc);

create view public.bag_shots with (security_invoker = true) as
select s.id, s.player, s.club, s.speed_mph, s.vla, s.hla, s.total_spin, s.spin_axis, s.at,
       s.course, s.hole, s.lie, s.practice, s.club_name,
       row_number() over (partition by s.player, s.club order by s.at desc, s.id desc) as rank
from public.shots s
where s.at > coalesce((select max(r.at) from public.bag_resets r where r.player = s.player), '-infinity');

comment on view public.bag_shots is 'The bag: each player''s shots after their latest reset, ranked within the club (1 = newest).';

-- Row-level security, with policies for the game's key alone.
alter table public.shots enable row level security;
alter table public.bag_resets enable row level security;

create policy "the game reads shots" on public.shots
  for select to anon using (true);
-- A shot dated ahead would outlive the next reset, so no more than a day of clock skew.
create policy "the game adds shots, dated up to a day ahead" on public.shots
  for insert to anon with check (at <= now() + interval '1 day');

create policy "the game reads resets" on public.bag_resets
  for select to anon using (true);
-- A reset dated ahead would hide the shots hit before that date.
create policy "the game adds resets, dated up to a day ahead" on public.bag_resets
  for insert to anon with check (at <= now() + interval '1 day');

-- Supabase's default privileges give anon and authenticated everything on a new table.
-- The game's key reads and inserts (never created_at, which stays the server's clock).
revoke all on public.shots, public.bag_resets, public.bag_shots from anon, authenticated;
grant select on public.shots, public.bag_resets, public.bag_shots to anon;
grant insert (id, player, club, speed_mph, vla, hla, total_spin, spin_axis, at, course, hole, lie, practice, club_name)
  on public.shots to anon;
grant insert (id, player, at) on public.bag_resets to anon;
