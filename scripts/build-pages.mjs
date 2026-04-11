import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectSiteEntries } from "./validate-pages.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedRoot = path.join(repoRoot, "shared");
const distRoot = path.join(repoRoot, "dist");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPortal(siteEntries) {
  const cards =
    siteEntries.length === 0
      ? `
        <section class="empty-state">
          아직 공개 목록에 포함된 페이지가 없습니다.
        </section>
      `
      : `
        <section class="portal-grid" aria-label="공개 페이지 목록">
          ${siteEntries
            .map(
              (site) => `
                <a class="site-card" href="./${encodeURIComponent(site.slug)}/">
                  <div class="site-thumbnail" aria-hidden="true"></div>
                  <div class="site-meta">
                    <div class="site-path">/${escapeHtml(site.slug)}/</div>
                    <h2 class="site-title">${escapeHtml(site.title)}</h2>
                    <p class="site-description">${escapeHtml(site.description)}</p>
                    <div class="site-cta">페이지 열기</div>
                  </div>
                </a>
              `
            )
            .join("")}
        </section>
      `;

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>zcabh.github.io</title>
    <meta
      name="description"
      content="GitHub Pages에 공개된 정적 웹 페이지 목록"
    />
    <link rel="stylesheet" href="./shared/styles/portal.css" />
  </head>
  <body>
    <main class="portal-shell">
      <header class="portal-header">
        <div class="eyebrow">GitHub Pages</div>
        <h1 class="portal-title">필요한 페이지로 바로 이동</h1>
        <p class="portal-copy">
          현재 공개된 페이지를 한곳에서 정리합니다. 원하는 페이지를 선택하면 해당 경로로 이동합니다.
        </p>
      </header>
      ${cards}
    </main>
  </body>
</html>
`;
}

async function copySharedAssets() {
  try {
    await cp(sharedRoot, path.join(distRoot, "shared"), { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function copySite(siteEntry) {
  await cp(siteEntry.siteDir, path.join(distRoot, siteEntry.slug), {
    recursive: true,
    filter: (source) => path.basename(source) !== "site.json",
  });
}

const siteEntries = await collectSiteEntries();

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });
await copySharedAssets();

for (const siteEntry of siteEntries) {
  await copySite(siteEntry);
}

await writeFile(path.join(distRoot, ".nojekyll"), "", "utf8");
await writeFile(
  path.join(distRoot, "index.html"),
  renderPortal(siteEntries.filter((siteEntry) => siteEntry.listed)),
  "utf8"
);

console.log(`Built ${siteEntries.length} site(s) into ${distRoot}.`);
