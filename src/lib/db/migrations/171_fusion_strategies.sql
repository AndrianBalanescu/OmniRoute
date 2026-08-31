-- Migration 171 (renamed from colliding 165; table creation is idempotent): Add fusion_strategies table for multi-engine AI search and reasoning synthesis
CREATE TABLE IF NOT EXISTS fusion_strategies (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  engines TEXT NOT NULL,
  synthesizer TEXT NOT NULL,
  system_prompt TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO fusion_strategies (id, name, description, engines, synthesizer, system_prompt, enabled)
VALUES 
(
  'fusion_web_research_pro',
  'fusion/web-research-pro',
  'Parallel web search across multi-engines synthesized by Claude 3.5 Sonnet',
  '["sonar", "felo"]',
  'anthropic/claude-3-5-sonnet',
  'You are an expert search synthesis engine. Synthesize the multi-engine search results into a concise, accurate, structured answer.',
  1
),
(
  'fusion_code_audit',
  'fusion/code-audit',
  'Multi-angle deep code review and audit synthesis',
  '["deepseek/deepseek-reasoner", "claude-3-5-sonnet"]',
  'anthropic/claude-3-5-sonnet',
  'Synthesize the code reviews into a clear, prioritize list of findings, root causes, and actionable fixes.',
  1
),
(
  'fusion_deep_reasoning',
  'fusion/deep-reasoning',
  'Multi-model cross-reasoning fusion',
  '["deepseek/deepseek-reasoner", "openai/gpt-4o"]',
  'anthropic/claude-3-5-sonnet',
  'Synthesize the reasoning paths into a definitive conclusion.',
  1
);
