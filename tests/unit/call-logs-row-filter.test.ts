import test from "node:test";
import assert from "node:assert/strict";

// Pure-function coverage for rowMatchesFilter (src/app/api/usage/call-logs/route.ts):
// the GET handler applies the active filter predicates over the MERGED rows (DB +
// in-memory active/completed entries) so search/provider/model/account/apiKey/status/
// combo behave consistently. Previously in-memory entries bypassed every filter except
// correlationId, so typing "BAAI" in the logs search still surfaced unrelated rows
// (e.g. antigravity) that were in-flight or just completed.
import { rowMatchesFilter } from "../../src/app/api/usage/call-logs/route.ts";

const baseRow = {
  id: "row-1",
  status: 200,
  model: "embedding-model",
  requestedModel: null,
  provider: "baai",
  providerDisplay: null,
  account: "alice@example.com",
  connectionId: "conn-1",
  apiKeyId: "key-1",
  apiKeyName: "main-key",
  comboName: null,
  error: null,
  correlationId: null,
};

test("rowMatchesFilter: no filter matches every row", () => {
  assert.equal(rowMatchesFilter(baseRow, {}), true);
  assert.equal(rowMatchesFilter(baseRow, undefined as any), true);
});

test("rowMatchesFilter: search filters in-memory rows by model", () => {
  // Regression for the BAAI/antigravity bug: a search for the model must exclude
  // unrelated in-memory rows, not just persisted DB rows.
  assert.equal(rowMatchesFilter(baseRow, { search: "embedding" }), true);
  assert.equal(rowMatchesFilter(baseRow, { search: "BAAI" }), true);
  assert.equal(rowMatchesFilter(baseRow, { search: "antigravity" }), false);
});

test("rowMatchesFilter: search matches provider and providerDisplay", () => {
  const withDisplay = { ...baseRow, provider: "p-antigravity", providerDisplay: "Antigravity" };
  assert.equal(rowMatchesFilter(withDisplay, { search: "antigravity" }), true);
  assert.equal(rowMatchesFilter(withDisplay, { search: "baai" }), false);
});

test("rowMatchesFilter: provider filter excludes in-memory rows of other providers", () => {
  assert.equal(rowMatchesFilter(baseRow, { provider: "baai" }), true);
  assert.equal(rowMatchesFilter(baseRow, { provider: "antigravity" }), false);
});

test("rowMatchesFilter: model filter checks both model and requestedModel", () => {
  assert.equal(rowMatchesFilter(baseRow, { model: "embedding-model" }), true);
  const requested = { ...baseRow, model: null, requestedModel: "text-embedding-3" };
  assert.equal(rowMatchesFilter(requested, { model: "text-embedding" }), true);
  assert.equal(rowMatchesFilter(baseRow, { model: "gpt-4o" }), false);
});

test("rowMatchesFilter: account filter matches account or connectionId", () => {
  assert.equal(rowMatchesFilter(baseRow, { account: "alice" }), true);
  assert.equal(rowMatchesFilter(baseRow, { account: "conn-1" }), true);
  assert.equal(rowMatchesFilter(baseRow, { account: "bob" }), false);
});

test("rowMatchesFilter: apiKey filter matches apiKeyName or apiKeyId", () => {
  assert.equal(rowMatchesFilter(baseRow, { apiKey: "main-key" }), true);
  assert.equal(rowMatchesFilter(baseRow, { apiKey: "key-1" }), true);
  assert.equal(rowMatchesFilter(baseRow, { apiKey: "other-key" }), false);
});

test("rowMatchesFilter: status error matches status>=400 or error set", () => {
  assert.equal(rowMatchesFilter({ ...baseRow, status: 502 }, { status: "error" }), true);
  assert.equal(rowMatchesFilter({ ...baseRow, status: 200 }, { status: "error" }), false);
  assert.equal(rowMatchesFilter({ ...baseRow, status: 200, error: "boom" }, { status: "error" }), true);
  assert.equal(rowMatchesFilter({ ...baseRow, status: 200 }, { status: "ok" }), true);
  assert.equal(rowMatchesFilter({ ...baseRow, status: 500 }, { status: "ok" }), false);
});

test("rowMatchesFilter: numeric status filter", () => {
  assert.equal(rowMatchesFilter({ ...baseRow, status: 404 }, { status: "404" }), true);
  assert.equal(rowMatchesFilter({ ...baseRow, status: 200 }, { status: "404" }), false);
});

test("rowMatchesFilter: combo filter requires comboName", () => {
  assert.equal(rowMatchesFilter(baseRow, { combo: "1" }), false);
  assert.equal(rowMatchesFilter({ ...baseRow, comboName: "priority" }, { combo: "1" }), true);
});

test("rowMatchesFilter: correlationId filter", () => {
  assert.equal(rowMatchesFilter({ ...baseRow, correlationId: "corr-abc" }, { correlationId: "corr" }), true);
  assert.equal(rowMatchesFilter(baseRow, { correlationId: "corr" }), false);
});
