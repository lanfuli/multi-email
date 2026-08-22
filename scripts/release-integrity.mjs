import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

function portable(relativePath) {
  return relativePath.split(path.sep).join("/");
}

async function sourceFiles(directory, root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute, root)));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files;
}

async function regularArtifactFiles(directory, root, excluded) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = portable(path.relative(root, absolute));
    if (entry.isDirectory()) {
      files.push(...(await regularArtifactFiles(absolute, root, excluded)));
    } else if (entry.isFile()) {
      if (!excluded.has(relative)) files.push(relative);
    } else {
      throw new Error(`Unexpected non-regular build artifact: ${relative}`);
    }
  }
  return files;
}

export async function artifactFiles(
  distDirectory,
  { exclude = ["build-manifest.json"] } = {},
) {
  return (await regularArtifactFiles(distDirectory, distDirectory, new Set(exclude))).sort();
}

export async function buildInputFiles(pluginRoot) {
  const files = [
    "package.json",
    "package-lock.json",
    "scripts/build.mjs",
    "scripts/release-entry.cjs",
    "scripts/release-integrity.mjs",
    ...(await sourceFiles(path.join(pluginRoot, "src"), pluginRoot)),
  ];
  return files.sort();
}

export async function digestFiles(pluginRoot, relativeFiles) {
  const hash = createHash("sha256");
  for (const relative of [...relativeFiles].sort()) {
    const contents = await readFile(path.join(pluginRoot, relative));
    const name = Buffer.from(relative, "utf8");
    hash.update(Buffer.from(`${name.length}:`, "ascii"));
    hash.update(name);
    hash.update(Buffer.from(`:${contents.length}:`, "ascii"));
    hash.update(contents);
  }
  return hash.digest("hex");
}

export async function digestFile(absolutePath) {
  return createHash("sha256").update(await readFile(absolutePath)).digest("hex");
}
