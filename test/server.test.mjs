import assert from "node:assert/strict";
import test from "node:test";
import { safeMcpOperation } from "../src/server.mjs";

test("the MCP operation deadline is returned as a safe structured tool error", async (context) => {
  context.mock.method(console, "error", () => {});
  const result = await safeMcpOperation(
    () => new Promise(() => {}),
    { timeoutMs: 10 },
  );

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    ok: false,
    error: "The MCP operation deadline expired.",
    code: "OPERATION_DEADLINE_EXCEEDED",
    details: undefined,
  });
  assert.deepEqual(JSON.parse(result.content[0].text), {
    error: "The MCP operation deadline expired.",
    code: "OPERATION_DEADLINE_EXCEEDED",
  });
});
