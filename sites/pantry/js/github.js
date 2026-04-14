import { encodeSnapshot, emptySnapshot, isGitHubConfigValid, normalizeSnapshot, trimmedGitHubConfig } from "./domain.js";

export async function fetchSnapshot(config, token) {
  const normalizedConfig = trimmedGitHubConfig(config);

  if (!isGitHubConfigValid(normalizedConfig)) {
    throw new Error("GitHub 저장소 설정이 올바르지 않습니다.");
  }

  const response = await fetch(makeContentsUrl(normalizedConfig, true), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 404) {
    return {
      snapshot: emptySnapshot(),
      sha: null,
    };
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("GitHub 저장소를 읽거나 쓸 권한이 없습니다.");
  }

  if (!response.ok) {
    throw await decodeGitHubError(response, "GitHub에서 데이터를 불러오지 못했습니다.");
  }

  const payload = await response.json();
  const rawContent = String(payload?.content ?? "").replace(/\n/g, "");

  if (!rawContent) {
    throw new Error("GitHub 파일 내용을 해석하지 못했습니다.");
  }

  const decodedText = base64ToText(rawContent);
  const parsed = JSON.parse(decodedText);

  return {
    snapshot: normalizeSnapshot(parsed),
    sha: payload?.sha ?? null,
  };
}

export async function pushSnapshot(config, token, snapshot, sha) {
  const normalizedConfig = trimmedGitHubConfig(config);

  if (!isGitHubConfigValid(normalizedConfig)) {
    throw new Error("GitHub 저장소 설정이 올바르지 않습니다.");
  }

  const response = await fetch(makeContentsUrl(normalizedConfig, false), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Sync pantry at ${new Date().toISOString()}`,
      content: textToBase64(encodeSnapshot(snapshot)),
      sha: sha ?? undefined,
      branch: normalizedConfig.branch,
    }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("GitHub 저장소를 읽거나 쓸 권한이 없습니다.");
  }

  if (response.status === 409 || response.status === 422) {
    throw new Error("원격 파일이 변경되어 동기화가 충돌했습니다. 먼저 다시 불러오세요.");
  }

  if (!response.ok) {
    throw await decodeGitHubError(response, "GitHub에 동기화하지 못했습니다.");
  }

  const payload = await response.json();
  const nextSHA = payload?.content?.sha;
  if (!nextSHA) {
    throw new Error("GitHub 응답에서 새 SHA를 읽지 못했습니다.");
  }
  return nextSHA;
}

function makeContentsUrl(config, includeRef) {
  const encodedPath = config.filePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const url = new URL(`https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodedPath}`);
  if (includeRef) {
    url.searchParams.set("ref", config.branch);
  }
  return url.toString();
}

async function decodeGitHubError(response, fallback) {
  try {
    const payload = await response.json();
    if (payload?.message) {
      return new Error(String(payload.message));
    }
  } catch (error) {
    console.error("GitHub 오류 응답을 해석하지 못했습니다.", error);
  }

  return new Error(fallback);
}

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function base64ToText(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}
