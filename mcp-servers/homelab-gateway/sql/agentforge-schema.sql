-- AgentForge Schema
-- Run against pgvector-18 to create experiment tracking tables

-- Experiments: top-level entity for an AgentForge run
CREATE TABLE IF NOT EXISTS forge_experiments (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES pipeline_projects(id),
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'created' CHECK (status IN (
    'created', 'researching', 'building_kg', 'optimizing', 'scaffolding', 'complete', 'failed'
  )),
  config JSONB DEFAULT '{}',
  results JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Discoveries: HF models, datasets, web pages, papers found during research
CREATE TABLE IF NOT EXISTS forge_discoveries (
  id SERIAL PRIMARY KEY,
  experiment_id INTEGER REFERENCES forge_experiments(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'hf_model', 'hf_dataset', 'hf_space', 'web_page', 'paper'
  )),
  source_id TEXT NOT NULL,
  name TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  raw_text TEXT,
  processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forge_discoveries_experiment ON forge_discoveries(experiment_id);

-- Triples: entity-relation-entity facts extracted from discoveries
CREATE TABLE IF NOT EXISTS forge_triples (
  id SERIAL PRIMARY KEY,
  experiment_id INTEGER REFERENCES forge_experiments(id) ON DELETE CASCADE,
  discovery_id INTEGER REFERENCES forge_discoveries(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  imported_to_neo4j BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forge_triples_experiment ON forge_triples(experiment_id);

-- Prompt experiments: optimization runs for specific prompts
CREATE TABLE IF NOT EXISTS forge_prompt_experiments (
  id SERIAL PRIMARY KEY,
  experiment_id INTEGER REFERENCES forge_experiments(id) ON DELETE CASCADE,
  prompt_name TEXT NOT NULL,
  base_prompt TEXT NOT NULL,
  evaluation_criteria JSONB DEFAULT '{}',
  test_cases JSONB DEFAULT '[]',
  status TEXT DEFAULT 'created' CHECK (status IN (
    'created', 'generating', 'evaluating', 'complete'
  )),
  winner_variant_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Prompt variants: generated alternatives for A/B testing
CREATE TABLE IF NOT EXISTS forge_prompt_variants (
  id SERIAL PRIMARY KEY,
  prompt_experiment_id INTEGER REFERENCES forge_prompt_experiments(id) ON DELETE CASCADE,
  variant_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  generation_method TEXT DEFAULT 'llm',
  scores JSONB DEFAULT '{}',
  avg_score REAL,
  evaluated BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forge_variants_experiment ON forge_prompt_variants(prompt_experiment_id);

-- PM resource evaluations: 5-step checklist for project resource decisions
CREATE TABLE IF NOT EXISTS forge_resource_evaluations (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES pipeline_projects(id),
  reusable_prompts JSONB DEFAULT '[]',
  new_tools JSONB DEFAULT '[]',
  lightrag_score INTEGER DEFAULT 0,
  lightrag_details JSONB DEFAULT '{}',
  lightrag_recommended BOOLEAN DEFAULT FALSE,
  prompts_to_create INTEGER DEFAULT 0,
  prompt_details JSONB DEFAULT '[]',
  estimated_cost REAL DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN (
    'pending', 'awaiting_approval', 'approved', 'modified', 'skipped'
  )),
  user_response TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
