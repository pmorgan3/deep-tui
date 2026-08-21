import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesRoot = join(root, "packages");
const repositoryUrl = "git+https://github.com/pmorgan3/deep-tui.git";

const entries = await readdir(packagesRoot, { withFileTypes: true });
const packageDirectories = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesRoot, entry.name))
  .sort();

for (const packageDirectory of packageDirectories) {
  const manifestPath = join(packageDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  if (!manifest.name?.startsWith("@deep-tui/")) {
    throw new Error(`Unexpected package name in ${manifestPath}: ${manifest.name}`);
  }

  manifest.repository = {
    type: "git",
    url: repositoryUrl,
    directory: relative(root, packageDirectory),
  };
  manifest.homepage = "https://github.com/pmorgan3/deep-tui#readme";
  manifest.bugs = { url: "https://github.com/pmorgan3/deep-tui/issues" };
  manifest.engines = { ...manifest.engines, node: ">=22.0.0" };
  manifest.publishConfig = {
    ...manifest.publishConfig,
    access: "public",
    registry: "https://registry.npmjs.org/",
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`Synchronized npm metadata for ${packageDirectories.length} packages.`);
