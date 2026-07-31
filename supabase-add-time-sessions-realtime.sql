-- ============================================
-- TinyApe — Enable Realtime for time_sessions
-- Run this ONCE in the Supabase SQL Editor.
-- ============================================
--
-- Why: logging time on one device never appeared on another until a full
-- refresh happened to run (boot, tab-focus after 30s+, or the ~10-minute
-- deep-check poll). time_sessions was never added to the realtime publication,
-- and DB.saveTimeSession only writes the session row, so nothing pushed the
-- new session to other devices. Same root cause as the creature_unlocks gap
-- fixed on 2026-03-26.
--
-- The tasks row IS re-saved on a session change (persistTask), so a tasks
-- UPDATE did broadcast — but that payload has no session data (time_sessions
-- is a separate table), so the receiving device merged an empty/stale session
-- list and the new entry stayed invisible. Subscribing to the actual table
-- carries the session in the payload, with ZERO extra database queries.
--
-- REPLICA IDENTITY FULL: by default Postgres sends only the primary key in a
-- DELETE payload, which means Supabase cannot evaluate RLS on delete events
-- (it broadcasts them unfiltered) and the client gets no task_id. FULL makes
-- RLS work correctly on deletes and puts the whole old row in the payload.
-- The table is small and write-light, so the extra WAL volume is negligible.

alter table public.time_sessions replica identity full;

alter publication supabase_realtime add table public.time_sessions;

-- Safe to run once. If the publication line errors with
-- "table is already member of publication" it's already enabled — ignore it.
