-- ============================================
-- TinyApe — Enable Supabase Realtime
-- Run this in the Supabase SQL Editor
-- ============================================

-- Add tables to the realtime publication so clients
-- receive push notifications on row changes
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.completion_events;
alter publication supabase_realtime add table public.drawer_categories;

-- Add missing DELETE policy on completion_events
-- (needed for the "uncomplete" feature — deleting completion events)
create policy "Users can delete own completion events"
  on public.completion_events for delete using (auth.uid() = user_id);
