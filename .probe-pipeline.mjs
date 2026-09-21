// Trace the FULL translateRequest pipeline for the antigravity path,
// exactly as the live gateway runs it.
const idx = await import("/data/projects/dev/OmniRoute/open-sse/translator/index.ts");

const body = {
  model: "antigravity/gemini-3.8-flash-tiered",
  messages: [{ role: "user", content: "ping" }],
  stream: false,
  max_tokens: 16,
  reasoning_effort: "none",
};

const creds = { projectId: "aicode-consumers", _provider: "antigravity" };

const out = idx.translateRequest(
  "openai", // sourceFormat
  "antigravity", // targetFormat
  "gemini-3.8-flash-tiered", // model
  body,
  false, // stream
  creds,
  "antigravity" // provider
);

const env = (out?.request ?? out?.generationConfig) ? out : (out?.body ?? out);
const gc = out?.request?.generationConfig ?? out?.generationConfig ?? env?.generationConfig ?? null;
console.log("TRANSLATED generationConfig:", JSON.stringify(gc, null, 2));
console.log("top-level keys:", Object.keys(out ?? {}).slice(0, 15));
