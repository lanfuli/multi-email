import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "../src/constants.mjs";
import {
  RuntimeIntegrityError,
  safeRuntimeFailure,
  verifyRuntimeBundle,
} from "../src/runtime-integrity.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runtimeFixture({ boundary = "commonjs", chunk = "valid" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "multi-email-runtime-test-"));
  const dist = path.join(root, "dist");
  await mkdir(dist);
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ version: APP_VERSION })}\n`,
  );

  const files = {
    "101.index.cjs.js": chunk === "valid"
      ? "module.exports={ids:[101],modules:{101:function(){}}};\n"
      : "module.exports={};\n",
    [`keyring.darwin-${process.arch}.node`]: "native-test-placeholder",
    "package.json": `${JSON.stringify({ type: boundary }, null, 2)}\n`,
    "server.cjs": "module.exports={startServer(){}};\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(dist, name), contents);
  }
  await writeFile(
    path.join(dist, "build-manifest.json"),
    `${JSON.stringify(
      {
        entry: "server.cjs",
        appVersion: APP_VERSION,
        sourceSha256: "a".repeat(64),
        artifacts: Object.fromEntries(
          Object.entries(files)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, contents]) => [name, digest(contents)]),
        ),
        nativeAssets: [`keyring.darwin-${process.arch}.node`],
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

async function expectReason(root, reason) {
  await assert.rejects(
    verifyRuntimeBundle(root, { nativeLoader: () => ({ Entry: class Entry {} }) }),
    (error) =>
      error instanceof RuntimeIntegrityError &&
      error.code === "RUNTIME_INTEGRITY_ERROR" &&
      error.reason === reason,
  );
}

test("runtime verification authenticates the complete artifact set and lazy chunks", async () => {
  const root = await runtimeFixture();
  try {
    const result = await verifyRuntimeBundle(root, {
      nativeLoader: () => ({ Entry: class Entry {} }),
    });
    assert.deepEqual(result, {
      ok: true,
      appVersion: APP_VERSION,
      buildId: "a".repeat(64),
      integrity: "verified",
      artifactsVerified: 4,
      lazyChunksVerified: 1,
      nativeRuntime: "verified",
      architecture: process.arch,
      installChannel: "local_package",
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime verification rejects package-boundary, hash, lazy-chunk, and file-set drift", async (context) => {
  await context.test("wrong package boundary", async () => {
    const root = await runtimeFixture({ boundary: "module" });
    try {
      await expectReason(root, "PACKAGE_BOUNDARY_INVALID");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await context.test("artifact hash mismatch", async () => {
    const root = await runtimeFixture();
    try {
      await writeFile(path.join(root, "dist", "server.cjs"), "tampered\n");
      await expectReason(root, "ARTIFACT_HASH_MISMATCH");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await context.test("invalid lazy chunk", async () => {
    const root = await runtimeFixture({ chunk: "invalid" });
    try {
      await expectReason(root, "LAZY_CHUNK_INVALID");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await context.test("unrecorded artifact", async () => {
    const root = await runtimeFixture();
    try {
      await writeFile(path.join(root, "dist", "unexpected.js"), "unexpected\n");
      await expectReason(root, "ARTIFACT_SET_MISMATCH");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("runtime failure output is allowlisted and contains no local path", () => {
  const error = new RuntimeIntegrityError("ARTIFACT_HASH_MISMATCH");
  error.stack = "/private/path/that-must-not-leak";
  assert.deepEqual(safeRuntimeFailure(error), {
    ok: false,
    code: "RUNTIME_INTEGRITY_ERROR",
    reason: "ARTIFACT_HASH_MISMATCH",
    requiredAction: "reinstall_or_rebuild",
  });
  assert.doesNotMatch(JSON.stringify(safeRuntimeFailure(error)), /private|path/iu);
  assert.equal(
    safeRuntimeFailure(new RuntimeIntegrityError("/private/provider-token")).reason,
    "RUNTIME_CHECK_FAILED",
  );
});

test("the production launcher fails closed instead of falling back to source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multi-email-launch-test-"));
  const scripts = path.join(root, "scripts");
  const source = path.join(root, "src");
  const fallbackMarker = path.join(root, "source-entry-loaded");
  try {
    await mkdir(scripts);
    await mkdir(source);
    await copyFile(path.join(projectRoot, "scripts", "launch-mcp"), path.join(scripts, "launch-mcp"));
    await copyFile(
      path.join(projectRoot, "src", "runtime-integrity.mjs"),
      path.join(source, "runtime-integrity.mjs"),
    );
    await copyFile(path.join(projectRoot, "src", "constants.mjs"), path.join(source, "constants.mjs"));
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ version: APP_VERSION })}\n`);
    await writeFile(
      path.join(source, "server.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(fallbackMarker)}, "loaded");\n`,
    );

    const result = spawnSync(process.execPath, [path.join(scripts, "launch-mcp")], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "[multi-email] RUNTIME_INTEGRITY_ERROR: BUILD_MANIFEST_INVALID. reinstall_or_rebuild.\n",
    );
    await assert.rejects(readFile(fallbackMarker), { code: "ENOENT" });
    assert.doesNotMatch(result.stderr, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the packaged setup CLI self-test reports bundle failure without loading source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multi-email-cli-test-"));
  const scripts = path.join(root, "scripts");
  const source = path.join(root, "src");
  const fallbackMarker = path.join(root, "setup-source-loaded");
  try {
    await mkdir(scripts);
    await mkdir(source);
    await copyFile(path.join(projectRoot, "scripts", "multi-email"), path.join(scripts, "multi-email"));
    await copyFile(
      path.join(projectRoot, "src", "runtime-integrity.mjs"),
      path.join(source, "runtime-integrity.mjs"),
    );
    await copyFile(path.join(projectRoot, "src", "constants.mjs"), path.join(source, "constants.mjs"));
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ version: APP_VERSION })}\n`);
    await writeFile(
      path.join(source, "setup.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(fallbackMarker)}, "loaded");\n`,
    );

    const selfTest = spawnSync(
      process.execPath,
      [path.join(scripts, "multi-email"), "self-test", "--json"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal(selfTest.status, 1);
    assert.deepEqual(JSON.parse(selfTest.stdout), {
      ok: false,
      code: "RUNTIME_INTEGRITY_ERROR",
      reason: "BUILD_MANIFEST_INVALID",
      requiredAction: "reinstall_or_rebuild",
    });
    assert.equal(selfTest.stderr, "");

    const doctor = spawnSync(
      process.execPath,
      [path.join(scripts, "multi-email"), "doctor", "--json"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal(doctor.status, 1);
    assert.equal(
      doctor.stderr,
      "Multi Email setup could not be loaded [BUILD_MANIFEST_INVALID]. Reinstall or rebuild the package.\n",
    );
    await assert.rejects(readFile(fallbackMarker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
