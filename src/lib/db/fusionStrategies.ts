/**
 * @file fusionStrategies.ts
 * @description DB module for Fusion Engine strategies (multi-engine AI search and synthesis).
 */

import { getDbInstance } from "./core";

export interface FusionEngineStep {
  model: string;
  fallback?: string;
}

export type FusionEngineItem = string | FusionEngineStep;

export interface FusionStrategy {
  id: string;
  name: string;
  description: string;
  engines: FusionEngineItem[];
  synthesizer: string;
  synthesizerFallback?: string;
  systemPrompt?: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface RawStrategyRow {
  id: string;
  name: string;
  description: string | null;
  engines: string;
  synthesizer: string;
  system_prompt: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function parseRow(row: RawStrategyRow): FusionStrategy {
  let engines: FusionEngineItem[] = [];
  try {
    engines = JSON.parse(row.engines);
  } catch {
    engines = [];
  }

  // Handle optional synthesizer fallback encoding (e.g. "synthesizer|fallback")
  let synthesizer = row.synthesizer;
  let synthesizerFallback: string | undefined = undefined;
  if (synthesizer.includes("->")) {
    const parts = synthesizer.split("->").map((p) => p.trim());
    synthesizer = parts[0];
    synthesizerFallback = parts[1];
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    engines,
    synthesizer,
    synthesizerFallback,
    systemPrompt: row.system_prompt || undefined,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getFusionStrategies(onlyEnabled = true): FusionStrategy[] {
  const db = getDbInstance();
  try {
    const query = onlyEnabled
      ? "SELECT * FROM fusion_strategies WHERE enabled = 1 ORDER BY name ASC"
      : "SELECT * FROM fusion_strategies ORDER BY name ASC";
    const rows = db.prepare(query).all() as RawStrategyRow[];
    return rows.map(parseRow);
  } catch {
    return [];
  }
}

export function getFusionStrategyByName(name: string): FusionStrategy | null {
  const db = getDbInstance();
  try {
    const row = db.prepare("SELECT * FROM fusion_strategies WHERE name = ? LIMIT 1").get(name) as
      RawStrategyRow | undefined;
    return row ? parseRow(row) : null;
  } catch {
    return null;
  }
}

export function saveFusionStrategy(strategy: {
  id?: string;
  name: string;
  description?: string;
  engines: FusionEngineItem[];
  synthesizer: string;
  synthesizerFallback?: string;
  systemPrompt?: string;
  enabled?: boolean;
}): FusionStrategy {
  const db = getDbInstance();
  const id = strategy.id || `fusion_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const enabled = strategy.enabled !== undefined ? (strategy.enabled ? 1 : 0) : 1;
  const enginesJson = JSON.stringify(strategy.engines);
  const synthesizerFull = strategy.synthesizerFallback
    ? `${strategy.synthesizer} -> ${strategy.synthesizerFallback}`
    : strategy.synthesizer;
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT id FROM fusion_strategies WHERE id = ? OR name = ? LIMIT 1")
    .get(id, strategy.name) as RawStrategyRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE fusion_strategies 
       SET name = ?, description = ?, engines = ?, synthesizer = ?, system_prompt = ?, enabled = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      strategy.name,
      strategy.description || "",
      enginesJson,
      synthesizerFull,
      strategy.systemPrompt || null,
      enabled,
      now,
      existing.id
    );
    return getFusionStrategyByName(strategy.name)!;
  } else {
    db.prepare(
      `INSERT INTO fusion_strategies (id, name, description, engines, synthesizer, system_prompt, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      strategy.name,
      strategy.description || "",
      enginesJson,
      synthesizerFull,
      strategy.systemPrompt || null,
      enabled,
      now,
      now
    );
    return getFusionStrategyByName(strategy.name)!;
  }
}

export function deleteFusionStrategy(idOrName: string): boolean {
  const db = getDbInstance();
  try {
    const result = db
      .prepare("DELETE FROM fusion_strategies WHERE id = ? OR name = ?")
      .run(idOrName, idOrName);
    return result.changes > 0;
  } catch {
    return false;
  }
}
