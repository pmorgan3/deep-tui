import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesRoot = join(root, "packages");
const entries = await readdir(packagesRoot, { withFileTypes: true });
const packageNames = [];

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const manifest = JSON.parse(
    await readFile(join(packagesRoot, entry.name, "package.json"), "utf8"),
  );
  if (!manifest.private) packageNames.push(manifest.name);
}

packageNames.sort();
console.log(`Configuring publish.yml as the trusted publisher for ${packageNames.length} packages.`);

for (const [index, packageName] of packageNames.entries()) {
  console.log(`[${index + 1}/${packageNames.length}] ${packageName}`);
  const result = spawnSync(
    "npm",
    [
      "trust",
      "github",
      packageName,
      "--file",
      "publish.yml",
      "--repo",
      "pmorgan3/deep-tui",
      "--allow-publish",
      "--yes",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

console.log("Trusted publishing is configured for every package.");
