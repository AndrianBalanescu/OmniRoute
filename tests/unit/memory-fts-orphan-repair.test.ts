import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDbInstance } from "../../src/lib/db/core";
import { cleanupMemoryEntries } from "../../src/lib/db/cleanup";
import { repairMemoryFtsOrphan } from "../../src/lib/db/migrationRunner";

describe("memory_fts orphan repair and cleanup resilience", () => {
  it("repairs orphaned FTS5 shadow tables and missing memory_fts parent table", async () => {
    const db = getDbInstance();

    // 1. Create a reproducible orphaned state:
    // Create base memories table if needed
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        memory_id INTEGER UNIQUE,
        content TEXT,
        key TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Ensure memory_id column exists
    const pragma = db.pragma("table_info(memories)") as Array<{ name: string }>;
    if (!pragma.some((c) => c.name === "memory_id")) {
      db.exec("ALTER TABLE memories ADD COLUMN memory_id INTEGER UNIQUE;");
    }

    // Insert a test memory row (schema per migration 015: api_key_id and type NOT NULL)
    db.exec(`
      INSERT OR REPLACE INTO memories (id, memory_id, api_key_id, type, content, key, created_at)
      VALUES ('test-uuid-1', 101, 'test-key', 'factual', 'Test content about artificial intelligence', 'ai_fact', datetime('now', '-40 days'));
    `);

    // Simulate broken state: shadow tables and triggers exist, but parent virtual table is missing
    db.exec(`
      DROP TABLE IF EXISTS memory_fts;
      CREATE TABLE IF NOT EXISTS memory_fts_data(id INTEGER PRIMARY KEY, block BLOB);
      CREATE TABLE IF NOT EXISTS memory_fts_idx(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS memory_fts_docsize(id INTEGER PRIMARY KEY, sz BLOB);
      CREATE TABLE IF NOT EXISTS memory_fts_config(k PRIMARY KEY, v) WITHOUT ROWID;
      DROP TRIGGER IF EXISTS memory_fts_ad;
      CREATE TRIGGER memory_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, content, key) VALUES('delete', old.memory_id, old.content, old.key);
      END;
    `);

    // Verify parent is absent and triggers/shadow tables exist
    const hasParentBefore = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'")
        .get() as { name?: string }
    )?.name;
    assert.equal(
      hasParentBefore,
      undefined,
      "Parent memory_fts must be missing in simulated broken state"
    );

    // 2. Run the repair function
    const repaired = repairMemoryFtsOrphan(db);
    assert.equal(repaired, true, "repairMemoryFtsOrphan should report repaired=true");

    // 3. Verify memory_fts is now a healthy virtual table
    const hasParentAfter = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'")
        .get() as { name?: string }
    )?.name;
    assert.equal(hasParentAfter, "memory_fts", "Parent memory_fts virtual table must now exist");

    // 4. Verify DELETE triggers work without throwing SqliteError
    const cleanupResult = await cleanupMemoryEntries();
    assert.equal(cleanupResult.errors, 0, "cleanupMemoryEntries should have 0 errors after repair");

    // Clean up test row
    db.exec("DELETE FROM memories WHERE id='test-uuid-1';");
  });
});
