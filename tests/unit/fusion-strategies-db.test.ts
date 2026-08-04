import test from "node:test";
import assert from "node:assert/strict";
import {
  getFusionStrategies,
  saveFusionStrategy,
  deleteFusionStrategy,
  getFusionStrategyByName,
} from "../../src/lib/db/fusionStrategies";

test("fusionStrategies DB CRUD works correctly", () => {
  const newStrat = saveFusionStrategy({
    name: "fusion/unit-test-strat",
    description: "Unit test strategy",
    engines: ["engine-a", "engine-b"],
    synthesizer: "synth-a",
    systemPrompt: "Test prompt",
    enabled: true,
  });

  assert.equal(newStrat.name, "fusion/unit-test-strat");
  assert.deepEqual(newStrat.engines, ["engine-a", "engine-b"]);

  const fetched = getFusionStrategyByName("fusion/unit-test-strat");
  assert.ok(fetched);
  assert.equal(fetched.synthesizer, "synth-a");

  const deleted = deleteFusionStrategy("fusion/unit-test-strat");
  assert.equal(deleted, true);

  const afterDelete = getFusionStrategyByName("fusion/unit-test-strat");
  assert.equal(afterDelete, null);
});
