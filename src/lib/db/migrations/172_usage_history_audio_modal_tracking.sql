-- Migration 172 (renamed from colliding 166): Add duration_seconds and
-- input_characters to usage_history. Enables accurate per-second (STT) and
-- per-character (TTS) cost tracking in usage analytics. Previously audio
-- requests stored tokens=0 and showed $0.00. Backward compatible: existing
-- rows default to 0; cost calculations fall back to token-based pricing when
-- these fields are 0. Idempotent for DBs that already have the columns
-- (retroactive guard for pre-rename 166 applications).
ALTER TABLE usage_history ADD COLUMN duration_seconds REAL DEFAULT 0;
ALTER TABLE usage_history ADD COLUMN input_characters INTEGER DEFAULT 0;
