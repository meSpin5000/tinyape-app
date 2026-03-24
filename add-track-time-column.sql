-- Add track_time column to tasks table
-- Run this in Supabase SQL Editor before deploying time tracking for any task
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS track_time BOOLEAN DEFAULT false;
