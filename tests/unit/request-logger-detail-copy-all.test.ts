import test from "node:test";
import assert from "node:assert/strict";

// Pure-function coverage for buildCopyAllText (src/shared/components/RequestLoggerDetail.tsx):
// the "Copy all" button composes every visible payload section + stream chunk into a single
// block so users can copy the whole request/response transcript with one click.
import { buildCopyAllText } from "../../src/shared/components/RequestLoggerDetail.tsx";

test("buildCopyAllText: joins sections in order with section separators", () => {
  const text = buildCopyAllText({
    sections: [
      { title: "Provider Request", json: '{"a":1}' },
      { title: "Provider Response", json: '{"b":2}' },
    ],
  });
  assert.match(text, /^### Provider Request\n\{"a":1\}\n\n---\n\n### Provider Response\n\{"b":2\}$/);
});

test("buildCopyAllText: includes provider/client/openai stream chunks before sections", () => {
  const text = buildCopyAllText({
    sections: [{ title: "Payload", json: "{}" }],
    streamChunks: {
      provider: ["data: {", '"x":1}', "\n\n"],
      client: "data: done",
    },
  });
  assert.match(text, /^### PROVIDER STREAM\ndata: \{"x":1\}/);
  assert.ok(text.indexOf("### PROVIDER STREAM") < text.indexOf("### CLIENT STREAM"));
  assert.ok(text.indexOf("### CLIENT STREAM") < text.indexOf("### Payload"));
});

test("buildCopyAllText: array stream chunks are joined", () => {
  const text = buildCopyAllText({
    sections: [],
    streamChunks: { provider: ["a", "b", "c"] },
  });
  assert.equal(text, "### PROVIDER STREAM\nabc");
});

test("buildCopyAllText: empty stream chunks are skipped", () => {
  const text = buildCopyAllText({
    sections: [],
    streamChunks: { provider: [], client: "" },
  });
  assert.equal(text, "");
});

test("buildCopyAllText: legacy request/response only when no payload sections", () => {
  const withSections = buildCopyAllText({
    sections: [{ title: "Payload", json: "{}" }],
    legacyResponse: "RESP",
    legacyRequest: "REQ",
  });
  assert.ok(!withSections.includes("RESP"));
  assert.ok(!withSections.includes("REQ"));

  const legacyOnly = buildCopyAllText({
    sections: [],
    legacyResponse: "RESP",
    legacyRequest: "REQ",
    legacyResponseTitle: "Response",
    legacyRequestTitle: "Request",
  });
  assert.match(legacyOnly, /### Response\nRESP/);
  assert.match(legacyOnly, /### Request\nREQ/);
});

test("buildCopyAllText: returns empty string when nothing to copy", () => {
  assert.equal(buildCopyAllText({ sections: [] }), "");
});
