import test from "node:test";
import assert from "node:assert/strict";
import { isFusionModel, getAllFusionModelNames } from "../../src/lib/fusion/fusionEngine";

test("isFusionModel identifies fusion model names", () => {
  assert.equal(isFusionModel("fusion/web-research-pro"), true);
  assert.equal(isFusionModel("fusion/custom-model"), true);
  assert.equal(isFusionModel("openai/gpt-4o"), false);
  assert.equal(isFusionModel(""), false);
});

test("getAllFusionModelNames returns default virtual models", () => {
  const names = getAllFusionModelNames();
  assert.ok(names.includes("fusion/web-research-pro"));
  assert.ok(names.includes("fusion/code-audit"));
  assert.ok(names.includes("fusion/deep-reasoning"));
});

test("handleFusionChat produces live SSE streaming events when stream: true", async () => {
  const { handleFusionChat } = await import("../../src/lib/fusion/fusionEngine");

  const req = new Request("http://127.0.0.1:20128/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion/web-research-pro",
      messages: [{ role: "user", content: "Test live preview query" }],
      stream: true,
    }),
  });

  const res = await handleFusionChat(
    req,
    {
      model: "fusion/web-research-pro",
      messages: [{ role: "user", content: "Test live preview query" }],
      stream: true,
    },
    "fusion/web-research-pro"
  );

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

  const reader = res.body?.getReader();
  assert.ok(reader);

  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }

  assert.ok(text.includes("fusion_progress"));
  assert.ok(text.includes('"type":"start"') || text.includes('"type": "start"'));
});
