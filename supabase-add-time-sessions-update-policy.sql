-- TinyApe: allow users to EDIT their own time sessions (2026-10-29)
-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- The original schema only had select/insert/delete policies on time_sessions.
-- With RLS on and no UPDATE policy, every edit matched 0 rows: a plain UPDATE
-- "succeeded" with nothing changed (edits silently reverted), and an upsert
-- onto an existing row is rejected with error 42501.

drop policy if exists "Users can update own time sessions" on public.time_sessions;
create policy "Users can update own time sessions"
  on public.time_sessions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Check: should return one row named "Users can update own time sessions".
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'time_sessions' and cmd = 'UPDATE';
