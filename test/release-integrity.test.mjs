import assert from "node:assert/strict";
import test from "node:test";
import {
  assertVersionContract,
  skillMetadataVersion,
} from "../scripts/release-integrity.mjs";

function skill(version = "0.1.5") {
  return `---
name: multi-email
description: Test fixture.
metadata:
  version: "${version}"
---

# Multi Email
`;
}

test("version contract accepts one matching quoted Skill metadata version", () => {
  assert.equal(skillMetadataVersion(skill()), "0.1.5");
  assert.equal(
    assertVersionContract({
      packageVersion: "0.1.5",
      pluginVersion: "0.1.5",
      skillSource: skill(),
      runtimeVersion: "0.1.5",
      buildVersion: "0.1.5",
    }),
    "0.1.5",
  );
});

test("version contract identifies the mismatched component", async (context) => {
  const cases = [
    ["plugin", { pluginVersion: "0.1.4" }],
    ["Skill", { skillSource: skill("0.1.4") }],
    ["runtime", { runtimeVersion: "0.1.4" }],
    ["build", { buildVersion: "0.1.4" }],
  ];
  for (const [component, override] of cases) {
    await context.test(component, () => {
      assert.throws(
        () =>
          assertVersionContract({
            packageVersion: "0.1.5",
            pluginVersion: "0.1.5",
            skillSource: skill(),
            runtimeVersion: "0.1.5",
            buildVersion: "0.1.5",
            ...override,
          }),
        new RegExp(`version mismatch: ${component} reports`, "u"),
      );
    });
  }
});

test("Skill version parsing ignores body decoys and rejects ambiguous metadata", () => {
  assert.throws(
    () =>
      skillMetadataVersion(`---
name: multi-email
description: Test fixture.
---

metadata:
  version: "0.1.5"
`),
    /exactly one metadata block/u,
  );
  assert.throws(
    () =>
      skillMetadataVersion(`---
name: multi-email
description: Test fixture.
metadata:
  version: "0.1.5"
  version: "0.1.5"
---
`),
    /exactly one quoted metadata\.version/u,
  );
  assert.throws(
    () =>
      skillMetadataVersion(`---
name: multi-email
description: Test fixture.
metadata:
  version: 0.1.5
---
`),
    /metadata\.version is missing or invalid/u,
  );
});

test("a requested build-version check cannot be skipped with an undefined value", () => {
  assert.throws(
    () =>
      assertVersionContract({
        packageVersion: "0.1.5",
        pluginVersion: "0.1.5",
        skillSource: skill(),
        runtimeVersion: "0.1.5",
        buildVersion: undefined,
      }),
    /version mismatch: build reports 'undefined'/u,
  );
});
