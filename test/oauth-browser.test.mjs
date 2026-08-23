import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { normalizeOAuthBrowser, openOAuthBrowser } from "../src/oauth-browser.mjs";

function recordingSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
}

test("OAuth browser selection uses only fixed macOS application arguments", async () => {
  const calls = [];
  const spawnImpl = recordingSpawn(calls);
  const url = "https://accounts.example.test/oauth?opaque=value";

  await openOAuthBrowser(url, "default", { spawnImpl });
  await openOAuthBrowser(url, "safari", { spawnImpl });
  await openOAuthBrowser(url, "chrome", { spawnImpl });

  assert.deepEqual(calls, [
    { command: "/usr/bin/open", args: [url], options: { stdio: "ignore" } },
    {
      command: "/usr/bin/open",
      args: ["-a", "Safari", url],
      options: { stdio: "ignore" },
    },
    {
      command: "/usr/bin/open",
      args: ["-a", "Google Chrome", url],
      options: { stdio: "ignore" },
    },
  ]);
});

test("OAuth browser values outside the fixed allowlist are rejected", async () => {
  assert.equal(normalizeOAuthBrowser("Safari"), "safari");
  assert.throws(() => normalizeOAuthBrowser("firefox"), { code: "INVALID_BROWSER" });
  assert.throws(() => openOAuthBrowser("https://example.test", "firefox"), {
    code: "INVALID_BROWSER",
  });
});
