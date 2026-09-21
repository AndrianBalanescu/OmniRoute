const m =
  await import("/data/projects/dev/OmniRoute/open-sse/translator/request/openai-to-gemini.ts");
const base = {
  messages: [{ role: "user", content: "ping" }],
  stream: false,
  max_tokens: 16,
  temperature: 0,
};
const cases = [
  ["enable_thinking=false (what iBrowse sends)", { enable_thinking: false }],
  ["reasoning_effort=none", { reasoning_effort: "none" }],
  ["reasoning_effort=low", { reasoning_effort: "low" }],
  ["nothing at all", {}],
];
for (const [label, extra] of cases) {
  // The antigravity path
  const out = m.openaiToCloudCodeGeminiRequest(
    "gemini-3.8-flash-tiered",
    { ...base, ...extra },
    false,
    {}
  );
  const gc = out?.generationConfig ?? {};
  console.log(`\n${label}`);
  console.log("   antigravity thinkingConfig:", JSON.stringify(gc.thinkingConfig));
  console.log("   antigravity maxOutputTokens:", gc.maxOutputTokens);
}
