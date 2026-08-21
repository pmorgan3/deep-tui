import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const registry = "https://registry.npmjs.org/";
const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
const tag = tagIndex === -1 ? "next" : args[tagIndex + 1];
const dryRun = args.includes("--dry-run");

if (!tag || !/^[a-z][a-z0-9._-]*$/i.test(tag)) {
  throw new Error(`Invalid npm distribution tag: ${tag ?? "<missing>"}`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error) throw result.error;
  return result;
}

const packageEntries = await readdir(join(root, "packages"), {
  withFileTypes: true,
});
const packages = [];

for (const entry of packageEntries) {
  if (!entry.isDirectory()) continue;
  const directory = join(root, "packages", entry.name);
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (manifest.private) continue;
  packages.push({ directory, manifest });
}

const packagesByName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
const visiting = new Set();
const visited = new Set();
const orderedPackages = [];

function visit(pkg) {
  const name = pkg.manifest.name;
  if (visited.has(name)) return;
  if (visiting.has(name)) throw new Error(`Circular workspace dependency at ${name}`);
  visiting.add(name);

  const dependencies = {
    ...pkg.manifest.dependencies,
    ...pkg.manifest.optionalDependencies,
    ...pkg.manifest.peerDependencies,
  };
  for (const dependencyName of Object.keys(dependencies).sort()) {
    const dependency = packagesByName.get(dependencyName);
    if (dependency) visit(dependency);
  }

  visiting.delete(name);
  visited.add(name);
  orderedPackages.push(pkg);
}

for (const pkg of packages.toSorted((a, b) => a.manifest.name.localeCompare(b.manifest.name))) {
  visit(pkg);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "deep-tui-publish-"));
const npmrcPath = join(temporaryDirectory, "npmrc");
await writeFile(
  npmrcPath,
  `registry=${registry}\n//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}\n`,
);

const publishEnvironment = {
  ...process.env,
  NODE_AUTH_TOKEN:
    process.env.NODE_AUTH_TOKEN ??
    process.env.NPM_TOKEN ??
    (dryRun ? "npm-dry-run-placeholder" : ""),
  NPM_CONFIG_CACHE: join(temporaryDirectory, "npm-cache"),
  NPM_CONFIG_USERCONFIG: npmrcPath,
};

function isAlreadyPublished(name, version) {
  const result = run(
    "npm",
    ["view", `${name}@${version}`, "version", "--json", "--registry", registry],
    { capture: true, env: publishEnvironment },
  );
  if (result.status === 0) return true;
  if (`${result.stdout}\n${result.stderr}`.includes("E404")) return false;
  throw new Error(
    `Could not check ${name}@${version}:\n${result.stderr || result.stdout}`,
  );
}

try {
  console.log(
    `${dryRun ? "Checking" : "Publishing"} ${orderedPackages.length} packages with tag ${tag}.`,
  );

  for (const [index, pkg] of orderedPackages.entries()) {
    const { name, version } = pkg.manifest;
    const position = `[${index + 1}/${orderedPackages.length}]`;

    if (!dryRun && isAlreadyPublished(name, version)) {
      console.log(`${position} ${name}@${version} already exists; skipping.`);
      continue;
    }

    const tarballName = `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
    const tarballPath = join(temporaryDirectory, tarballName);
    console.log(`${position} Packing ${name}@${version}.`);
    const pack = run("pnpm", ["pack", "--out", tarballPath], { cwd: pkg.directory });
    if (pack.status !== 0) throw new Error(`Failed to pack ${name}@${version}.`);

    const publishArgs = [
      "publish",
      tarballPath,
      "--access",
      "public",
      "--tag",
      tag,
      "--registry",
      registry,
    ];
    if (dryRun) publishArgs.push("--dry-run");
    if (process.env.GITHUB_ACTIONS === "true") publishArgs.push("--provenance");

    const publish = run("npm", publishArgs, { env: publishEnvironment });
    if (publish.status !== 0) throw new Error(`Failed to publish ${name}@${version}.`);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(`${dryRun ? "Package dry run" : "Package publish"} completed.`);
