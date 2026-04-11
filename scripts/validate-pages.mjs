import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function valueType(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  return value === null ? "null" : typeof value;
}

function expectField(errors, manifest, field, type, context) {
  if (!(field in manifest)) {
    errors.push(`${context}: missing \`${field}\` in site.json`);
    return;
  }

  if (type === "number") {
    if (typeof manifest[field] !== "number" || !Number.isFinite(manifest[field])) {
      errors.push(
        `${context}: expected \`${field}\` to be a finite number, received ${valueType(manifest[field])}`
      );
    }
    return;
  }

  if (typeof manifest[field] !== type) {
    errors.push(
      `${context}: expected \`${field}\` to be ${type}, received ${valueType(manifest[field])}`
    );
  }
}

async function readManifest(manifestPath, context, errors) {
  let source;

  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    errors.push(`${context}: missing site.json`);
    return null;
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    errors.push(`${context}: invalid JSON in site.json (${error.message})`);
    return null;
  }
}

export async function collectSiteEntries(rootDir = repoRoot) {
  const sitesDir = path.join(rootDir, "sites");
  let directoryEntries;

  try {
    directoryEntries = await readdir(sitesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Missing `sites/` directory.");
    }
    throw error;
  }

  const siteDirectories = directoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));

  if (siteDirectories.length === 0) {
    throw new Error("No page directories found under `sites/`.");
  }

  const errors = [];
  const seenSlugs = new Set();
  const siteEntries = [];

  for (const directoryName of siteDirectories) {
    const siteDir = path.join(sitesDir, directoryName);
    const manifestPath = path.join(siteDir, "site.json");
    const indexPath = path.join(siteDir, "index.html");
    const context = `sites/${directoryName}`;
    const manifest = await readManifest(manifestPath, context, errors);

    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      continue;
    }

    expectField(errors, manifest, "slug", "string", context);
    expectField(errors, manifest, "title", "string", context);
    expectField(errors, manifest, "description", "string", context);
    expectField(errors, manifest, "order", "number", context);
    expectField(errors, manifest, "listed", "boolean", context);

    if (typeof manifest.slug === "string") {
      if (manifest.slug !== directoryName) {
        errors.push(
          `${context}: \`slug\` must match the directory name (\`${directoryName}\`)`
        );
      }

      if (seenSlugs.has(manifest.slug)) {
        errors.push(`${context}: duplicate slug \`${manifest.slug}\``);
      } else {
        seenSlugs.add(manifest.slug);
      }
    }

    try {
      await access(indexPath);
    } catch (error) {
      errors.push(`${context}: missing index.html`);
    }

    siteEntries.push({
      ...manifest,
      directoryName,
      siteDir,
      indexPath,
      manifestPath,
    });
  }

  if (errors.length > 0) {
    throw new Error(`Site validation failed:\n${errors.map((entry) => `- ${entry}`).join("\n")}`);
  }

  siteEntries.sort((left, right) => {
    const orderDelta = left.order - right.order;
    if (orderDelta !== 0) {
      return orderDelta;
    }

    return left.slug.localeCompare(right.slug, "en");
  });

  return siteEntries;
}

if (isDirectRun()) {
  try {
    const siteEntries = await collectSiteEntries();
    console.log(`Validated ${siteEntries.length} site(s).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
