-- Overwatch Agent + Modular Pipeline Routing
-- Migration: Add project classification columns and module_runs table

-- 1. New columns on pipeline_projects
-- Note: 'software' included for backward compat with existing rows
ALTER TABLE pipeline_projects ADD COLUMN IF NOT EXISTS project_type TEXT DEFAULT 'software';
-- Add constraint separately to avoid issues with existing rows
-- ALTER TABLE pipeline_projects ADD CONSTRAINT pipeline_projects_project_type_check
--   CHECK (project_type IN ('personal-tool','client-work','market-product','automation','hybrid','software'));

ALTER TABLE pipeline_projects ADD COLUMN IF NOT EXISTS revenue_model TEXT
  DEFAULT 'none'
  CHECK (revenue_model IN ('none','subscription','one-time','client-billing','freemium'));

ALTER TABLE pipeline_projects ADD COLUMN IF NOT EXISTS deliverable_type TEXT
  DEFAULT 'software'
  CHECK (deliverable_type IN ('software','automation','integration','content-system','hybrid'));

ALTER TABLE pipeline_projects ADD COLUMN IF NOT EXISTS active_modules JSONB DEFAULT '[]';
ALTER TABLE pipeline_projects ADD COLUMN IF NOT EXISTS overwatch_classification JSONB DEFAULT NULL;
ALTER TABLE pipeline_projects ADD COLUMN IF NOT EXISTS overwatch_approved BOOLEAN DEFAULT FALSE;
ALTER TABLE pipeline_projects ADD COLUMN IF NOT EXISTS module_progress JSONB DEFAULT '{}';

-- 2. New table: pipeline_module_runs
CREATE TABLE IF NOT EXISTS pipeline_module_runs (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES pipeline_projects(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','complete','skipped','failed','blocked')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result_summary JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, module_id)
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_module_runs_project ON pipeline_module_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_module_runs_status ON pipeline_module_runs(status);
