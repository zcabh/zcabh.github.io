import {
  EXPIRY_BUCKETS,
  TYPE_COLORS,
  cloneSnapshot,
  daysUntilExpiry,
  decrementItem,
  deleteItem,
  deleteType,
  emptySnapshot,
  formatDDayLabel,
  formatDateTimeLabel,
  formatExpiresOnLabel,
  groupItemsByBucket,
  isGitHubConfigValid,
  itemCountForType,
  itemsFilteredByType,
  normalizeSnapshot,
  todayDateKey,
  trimmedGitHubConfig,
  typeByID,
  typeColorMeta,
  upsertItem,
  upsertType,
} from "./domain.js";
import { fetchSnapshot, pushSnapshot } from "./github.js";
import {
  clearLegacyTokenEnvelope,
  loadPersistedState,
  persistToken,
  persistSettings,
  persistSnapshot,
} from "./storage.js";

const root = document.querySelector("#app");

const state = {
  snapshot: emptySnapshot(),
  settings: defaultSettings(),
  token: null,
  hasLegacyTokenEnvelope: false,
  isBootstrapping: false,
  isSyncing: false,
  errorMessage: "",
  selectedTypeFilter: "all",
  modal: null,
  illustrationDataUrl: "",
};

root.addEventListener("click", handleClick);
root.addEventListener("submit", handleSubmit);
root.addEventListener("change", handleChange);
window.addEventListener("keydown", handleKeyDown);

void initialize();

async function initialize() {
  state.illustrationDataUrl = createPantryIllustration();

  try {
    const persisted = await loadPersistedState();
    state.settings = mergeSettings(persisted.settings);
    state.token = persisted.token ?? null;
    state.hasLegacyTokenEnvelope = Boolean(persisted.hasLegacyTokenEnvelope);

    if (persisted.snapshot) {
      state.snapshot = normalizeSnapshot(persisted.snapshot);
    }
  } catch (error) {
    console.error(error);
    state.errorMessage = "저장된 로컬 데이터를 읽지 못했습니다. 빈 상태로 시작합니다.";
    state.snapshot = emptySnapshot();
    state.settings = defaultSettings();
    state.token = null;
    state.hasLegacyTokenEnvelope = false;
  }

  normalizeFilterSelection();
  render();

  if (hasStoredConnection()) {
    void bootstrapFromRemote().catch((error) => {
      state.errorMessage = error instanceof Error ? error.message : "GitHub에서 데이터를 불러오지 못했습니다.";
      render();
    });
  }
}

function defaultSettings() {
  return {
    gitHubConfig: {
      owner: "",
      repo: "",
      branch: "main",
      filePath: "track-your-pantry.json",
    },
    remoteSHA: null,
    lastFetchedAt: null,
    lastSyncedAt: null,
  };
}

function mergeSettings(value) {
  const defaults = defaultSettings();
  const nextValue = value && typeof value === "object" ? value : {};
  return {
    gitHubConfig: {
      ...defaults.gitHubConfig,
      ...(nextValue.gitHubConfig && typeof nextValue.gitHubConfig === "object"
        ? nextValue.gitHubConfig
        : {}),
    },
    remoteSHA: nextValue.remoteSHA ?? null,
    lastFetchedAt: nextValue.lastFetchedAt ?? null,
    lastSyncedAt: nextValue.lastSyncedAt ?? null,
  };
}

function hasStoredConnection() {
  return isGitHubConfigValid(state.settings.gitHubConfig) && Boolean(state.token);
}

function hasLegacyTokenMigrationPending() {
  return !state.token && state.hasLegacyTokenEnvelope;
}

function isBusy() {
  return state.isBootstrapping || state.isSyncing;
}

function requiresOnboarding() {
  return !isGitHubConfigValid(state.settings.gitHubConfig) || (!state.token && !state.hasLegacyTokenEnvelope);
}

function canRunRemoteAction() {
  return Boolean(
    isGitHubConfigValid(state.settings.gitHubConfig) &&
      state.token &&
      !isBusy()
  );
}

function canEditSnapshot() {
  return canRunRemoteAction();
}

function disabledAttr(disabled) {
  return disabled ? "disabled" : "";
}

function lockedMutationMessage() {
  if (isBusy()) {
    return "GitHub 작업이 끝난 뒤 다시 시도하세요.";
  }
  if (hasLegacyTokenMigrationPending()) {
    return "보안 방식 변경으로 GitHub token을 한 번 다시 입력해야 수정할 수 있습니다.";
  }
  return "GitHub 연결을 먼저 설정하세요.";
}

function assertEditableSnapshot() {
  if (!canEditSnapshot()) {
    throw new Error(lockedMutationMessage());
  }
}

function gitHubConfigEquals(left, right) {
  const normalizedLeft = trimmedGitHubConfig(left);
  const normalizedRight = trimmedGitHubConfig(right);
  return (
    normalizedLeft.owner === normalizedRight.owner &&
    normalizedLeft.repo === normalizedRight.repo &&
    normalizedLeft.branch === normalizedRight.branch &&
    normalizedLeft.filePath === normalizedRight.filePath
  );
}

function applyFetchedSnapshot(envelope, overrides = {}) {
  const fetchedAt = new Date().toISOString();
  state.snapshot = envelope.snapshot;
  state.settings = {
    ...state.settings,
    ...overrides,
    remoteSHA: envelope.sha,
    lastFetchedAt: fetchedAt,
  };
  normalizeFilterSelection();
}

function normalizeFilterSelection() {
  if (state.selectedTypeFilter === "all") {
    return;
  }
  const typeID = Number(state.selectedTypeFilter);
  if (!Number.isInteger(typeID) || !state.snapshot.types.some((type) => type.id === typeID)) {
    state.selectedTypeFilter = "all";
  }
}

function render() {
  if (requiresOnboarding()) {
    root.innerHTML = renderOnboarding();
    return;
  }

  root.innerHTML = renderDashboard();
}

function renderOnboarding() {
  const config = mergeSettings(state.settings).gitHubConfig;

  return `
    <div class="app-frame">
      ${renderStatusBar()}
      <section class="onboarding-shell">
        <div class="onboarding-copy">
          <div class="brand-block">
            <h1 class="brand-title">Track Your Pantry Web</h1>
            <p class="brand-copy">
              GitHub Pages에 올릴 수 있는 정적 웹 앱입니다. 실제 물품 재고 데이터는 별도 private repository의
              JSON 파일 하나를 브라우저에서 직접 읽고 씁니다.
            </p>
          </div>
          <div class="onboarding-media">
            <img src="${state.illustrationDataUrl}" alt="유통기한 카드 목록을 그린 이미지" />
          </div>
          <div class="stack">
            <div class="badge badge-success">정적 호스팅 가능</div>
            <div class="muted">web repo + data repo 조합을 기준으로 설계했습니다.</div>
            <div class="muted">입력한 GitHub PAT는 이 브라우저에 저장되어 이후 재입력 없이 바로 사용합니다.</div>
          </div>
        </div>
        <div class="onboarding-form-wrap">
          <form class="form-grid" data-form="settings-onboarding">
            ${renderSettingsFields(config, {
              tokenValue: "",
              showTokenFields: true,
              showCloseButton: false,
              isOnboarding: true,
              submitLabel: "연결하고 시작",
            })}
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderDashboard() {
  const editable = canEditSnapshot();
  const busy = disabledAttr(isBusy());
  const filteredItems = itemsFilteredByType(state.snapshot, state.selectedTypeFilter);
  const groups = groupItemsByBucket(filteredItems);
  const hasAnyItems = state.snapshot.items.length > 0;
  const hasFilteredItems = filteredItems.length > 0;

  return `
    <div class="app-frame">
      <div class="topbar">
        <div class="brand-block">
          <h1 class="brand-title">Track Your Pantry Web</h1>
          <p class="brand-copy">
            유통기한이 있는 물품을 기록하고, 기한이 임박한 순으로 한 눈에 관리합니다.
            저장된 GitHub PAT로 최신 JSON을 다시 확인하고, 이후 변경 사항은 저장할 때마다 GitHub JSON에 즉시 반영합니다.
          </p>
        </div>
        <div class="header-actions">
          <button class="button-ghost" type="button" data-action="open-settings" ${busy}>GitHub 설정</button>
        </div>
      </div>

      ${renderStatusBar()}

      <div class="toolbar">
        <button class="button-primary" type="button" data-action="open-add-item" ${disabledAttr(!editable || state.snapshot.types.length === 0)}>+ 새 물품</button>
        <button class="button-ghost" type="button" data-action="open-type-manager" ${disabledAttr(!editable)}>타입 관리</button>
      </div>

      ${renderFilterChipRow()}

      ${
        !hasAnyItems
          ? renderEmptyDashboard()
          : !hasFilteredItems
            ? renderFilteredEmpty()
            : `
              <section class="panel">
                <div class="panel-body">
                  ${renderBucketSections(groups)}
                </div>
              </section>
            `
      }
      ${renderModal()}
    </div>
  `;
}

function renderFilterChipRow() {
  const currentFilter = state.selectedTypeFilter;
  const totalCount = state.snapshot.items.length;
  const chips = [
    `
      <button
        class="filter-chip ${currentFilter === "all" ? "is-selected" : ""}"
        type="button"
        data-action="set-filter"
        data-filter-value="all"
      >
        전체 <span class="muted">${totalCount}</span>
      </button>
    `,
    ...state.snapshot.types.map((type) => {
      const count = itemCountForType(state.snapshot, type.id);
      const selected = String(currentFilter) === String(type.id);
      return `
        <button
          class="filter-chip ${selected ? "is-selected" : ""}"
          type="button"
          data-action="set-filter"
          data-filter-value="${type.id}"
        >
          <span class="type-dot color-${escapeAttr(type.color)}"></span>
          ${escapeHtml(type.name)} <span class="muted">${count}</span>
        </button>
      `;
    }),
  ];

  return `<div class="filter-chip-row" role="group" aria-label="타입 필터">${chips.join("")}</div>`;
}

function renderBucketSections(groups) {
  const editable = canEditSnapshot();

  return EXPIRY_BUCKETS.filter((bucket) => groups[bucket.id].length > 0)
    .map((bucket) => {
      const entries = groups[bucket.id];
      return `
        <section class="expiry-section">
          <header class="section-header is-${bucket.id}">
            <span class="section-title">${escapeHtml(bucket.title)} (${entries.length})</span>
            <span class="muted">${escapeHtml(bucket.description)}</span>
          </header>
          <div class="item-list">
            ${entries.map((entry) => renderItemCard(entry, editable)).join("")}
          </div>
        </section>
      `;
    })
    .join("");
}

function renderItemCard(entry, editable) {
  const { item, days } = entry;
  const type = typeByID(state.snapshot, item.typeID);
  const typeDot = type
    ? `<span class="type-dot color-${escapeAttr(type.color)}" title="${escapeAttr(type.name)}"></span>`
    : `<span class="type-dot"></span>`;
  const ddayClass =
    days == null
      ? ""
      : days < 0
        ? "is-expired"
        : days <= 7
          ? "is-soon"
          : days <= 30
            ? "is-month"
            : "";
  const cardClass =
    days == null
      ? ""
      : days < 0
        ? "is-expired"
        : days <= 7
          ? "is-soon"
          : "";
  const locationText = item.location ? `<span>보관: <strong>${escapeHtml(item.location)}</strong></span>` : "";
  const notesText = item.notes ? `<div class="muted">${escapeHtml(item.notes)}</div>` : "";
  const typeLabel = type ? escapeHtml(type.name) : "알 수 없음";

  return `
    <article class="item-card ${cardClass}">
      <div class="item-main">
        <div class="stack">
          <div class="item-heading">
            ${typeDot}
            <div class="item-name">${escapeHtml(item.name)}</div>
          </div>
          <div class="item-meta">
            <span class="dday-badge ${ddayClass}">${escapeHtml(formatDDayLabel(days))}</span>
            <span>${escapeHtml(formatExpiresOnLabel(item.expiresOn))}</span>
            <span>${typeLabel}</span>
            ${locationText}
          </div>
          ${notesText}
        </div>
        <div class="stack" style="align-items:flex-end;">
          <div class="quantity-control">
            <strong>${item.quantity}개</strong>
            <button
              class="button-subtle"
              type="button"
              data-action="decrement-item"
              data-item-id="${escapeAttr(item.id)}"
              ${disabledAttr(!editable)}
              title="1개 줄이기"
            >
              −1
            </button>
          </div>
        </div>
      </div>
      <div class="item-actions">
        <button
          class="button-subtle"
          type="button"
          data-action="edit-item"
          data-item-id="${escapeAttr(item.id)}"
          ${disabledAttr(!editable)}
        >
          수정
        </button>
        <button
          class="button-danger"
          type="button"
          data-action="delete-item"
          data-item-id="${escapeAttr(item.id)}"
          ${disabledAttr(!editable)}
        >
          삭제
        </button>
      </div>
    </article>
  `;
}

function renderFilteredEmpty() {
  return `
    <section class="empty-state">
      <div class="empty-state-copy">
        <h2 class="modal-title">선택한 타입에 물품이 없습니다</h2>
        <p class="muted">필터를 "전체"로 바꾸거나 이 타입으로 새 물품을 추가하세요.</p>
      </div>
    </section>
  `;
}

function renderEmptyDashboard() {
  const editable = canEditSnapshot();

  return `
    <section class="empty-state">
      <div class="empty-state-media">
        <img src="${state.illustrationDataUrl}" alt="유통기한이 임박한 물품들을 그린 이미지" />
      </div>
      <div class="empty-state-copy">
        <h2 class="modal-title">등록된 물품이 아직 없습니다</h2>
        <p class="muted">
          타입 관리에서 분류를 먼저 다듬은 뒤 "새 물품"으로 유통기한을 기록하세요.
          저장된 항목은 기한이 가까운 순으로 자동 정렬됩니다.
        </p>
      </div>
      <div class="form-actions" style="justify-content:flex-start;">
        <button class="button-primary" type="button" data-action="open-add-item" ${disabledAttr(!editable || state.snapshot.types.length === 0)}>+ 새 물품</button>
        <button class="button-ghost" type="button" data-action="open-type-manager" ${disabledAttr(!editable)}>타입 관리</button>
      </div>
    </section>
  `;
}

function renderStatusBar() {
  const descriptor = statusDescriptor();

  return `
    <section class="status-bar status-bar-${descriptor.tone}">
      <div class="status-main">
        <div class="status-copy">
          <div class="status-summary">${escapeHtml(descriptor.summary)}</div>
          <div class="status-detail">${escapeHtml(descriptor.detail)}</div>
        </div>
        <div class="status-badges">
          ${descriptor.badges
            .map((badge) => `<span class="badge ${badge.className ?? ""}">${escapeHtml(badge.label)}</span>`)
            .join("")}
        </div>
      </div>
      ${
        state.errorMessage
          ? `<div class="error-banner">${escapeHtml(state.errorMessage)}</div>`
          : ""
      }
    </section>
  `;
}

function statusDescriptor() {
  if (state.isSyncing) {
    return {
      tone: "progress",
      summary: "변경 사항을 GitHub에 저장하는 중입니다.",
      detail: "저장이 끝나면 브라우저와 GitHub JSON이 다시 일치합니다.",
      badges: [{ label: "자동 저장 중", className: "badge-success" }],
    };
  }

  if (state.isBootstrapping) {
    return {
      tone: "progress",
      summary: "GitHub에서 최신 데이터를 확인하는 중입니다.",
      detail: "저장된 GitHub PAT로 저장소 연결과 최신 remote snapshot을 다시 확인하고 있습니다.",
      badges: [{ label: "연결 확인 중" }],
    };
  }

  if (hasLegacyTokenMigrationPending()) {
    return {
      tone: "danger",
      summary: "보안 방식 변경으로 GitHub token을 한 번 다시 입력해야 합니다.",
      detail: state.settings.lastFetchedAt
        ? `마지막 remote 확인: ${formatDateTimeLabel(state.settings.lastFetchedAt)}. GitHub 설정에서 PAT를 다시 저장하면 이후에는 새로고침 후에도 바로 사용합니다.`
        : "GitHub 설정에서 PAT를 다시 저장하면 이후에는 새로고침 후에도 바로 사용합니다.",
      badges: [
        { label: "조회 전용", className: "badge-danger" },
        { label: "1회 재입력 필요" },
      ],
    };
  }

  if (!hasStoredConnection()) {
    return {
      tone: "neutral",
      summary: "GitHub 연결을 설정하세요.",
      detail: "토큰과 저장소를 저장하면 이후 재입력 없이 최신 remote 확인과 자동 저장을 사용할 수 있습니다.",
      badges: [],
    };
  }

  const details = [];
  if (state.settings.lastFetchedAt) {
    details.push(`마지막 remote 확인: ${formatDateTimeLabel(state.settings.lastFetchedAt)}`);
  }
  if (state.settings.lastSyncedAt) {
    details.push(`마지막 자동 저장: ${formatDateTimeLabel(state.settings.lastSyncedAt)}`);
  }
  return {
    tone: "success",
    summary: "GitHub 연결이 준비되었습니다.",
    detail:
      details.join(" · ") || "변경 사항은 저장할 때마다 GitHub JSON에 즉시 반영됩니다.",
    badges: [
      { label: "자동 저장 활성", className: "badge-success" },
      { label: "PAT 저장됨" },
    ],
  };
}

function renderModal() {
  if (!state.modal) {
    return "";
  }

  if (state.modal.type === "settings") {
    return renderSettingsModal();
  }

  if (state.modal.type === "type-manager") {
    return renderTypeManagerModal();
  }

  if (state.modal.type === "item-editor") {
    return renderItemEditorModal();
  }

  return renderConfirmModal();
}

function renderSettingsModal() {
  const config = mergeSettings(state.settings).gitHubConfig;
  const busy = disabledAttr(isBusy());

  return `
    <div class="modal-backdrop">
      <section class="modal wide">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">GitHub 설정</h2>
            <p class="modal-copy">
              web app 코드는 public Pages repo에 두고, 실제 재고 데이터는 별도 private repository의 JSON 파일을 가리키는 구성을 권장합니다.
            </p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal" ${busy}>닫기</button>
        </div>
        <div class="modal-body">
          <form class="form-grid" data-form="settings-modal">
            ${renderSettingsFields(config, {
              tokenValue: "",
              showTokenFields: true,
              showCloseButton: true,
              isOnboarding: false,
              submitLabel: "저장하고 확인",
            })}
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderSettingsFields(config, options) {
  const busy = disabledAttr(isBusy());

  return `
    <div class="form-grid">
      <div class="split-fields">
        <div class="field-grid">
          <label for="github-owner">Owner</label>
          <input id="github-owner" name="owner" value="${escapeAttr(config.owner)}" autocomplete="off" required ${busy} />
        </div>
        <div class="field-grid">
          <label for="github-repo">Repository</label>
          <input id="github-repo" name="repo" value="${escapeAttr(config.repo)}" autocomplete="off" required ${busy} />
        </div>
      </div>

      <div class="split-fields">
        <div class="field-grid">
          <label for="github-branch">Branch</label>
          <input id="github-branch" name="branch" value="${escapeAttr(config.branch)}" autocomplete="off" required ${busy} />
        </div>
        <div class="field-grid">
          <label for="github-path">File Path</label>
          <input id="github-path" name="filePath" value="${escapeAttr(config.filePath)}" autocomplete="off" required ${busy} />
          <small class="form-note">expense와 같은 레포를 쓰려면 파일 이름만 달리 두세요. 예: <code>track-your-pantry.json</code></small>
        </div>
      </div>

      ${
        options.showTokenFields
          ? `
            ${
              hasLegacyTokenMigrationPending()
                ? '<div class="form-note">이전 방식으로 저장된 토큰은 읽을 수 없어 GitHub PAT를 한 번 다시 입력해야 합니다.</div>'
                : ""
            }
            <div class="field-grid">
              <label for="github-token">${
                state.token && !options.isOnboarding
                  ? "새 GitHub Personal Access Token 또는 비워두기"
                  : "GitHub Personal Access Token"
              }</label>
              <input
                id="github-token"
                name="token"
                type="password"
                value="${escapeAttr(options.tokenValue)}"
                autocomplete="new-password"
                ${!state.token ? "required" : ""}
                ${busy}
              />
              <small class="form-note">
                private repo 1개만 선택하고 <strong>Contents: Read and write</strong> 권한만 주는 fine-grained PAT를 권장합니다. 입력한 PAT는 이 브라우저에 저장되어 이후 재입력 없이 사용합니다.
              </small>
            </div>
          `
          : ""
      }

      <div class="field-grid">
        <div class="form-section-title">동작 방식</div>
        <div class="readout muted">
          저장된 PAT로 GitHub JSON을 바로 확인하고, 이후 내역 변경은 저장할 때마다 GitHub JSON에 즉시 반영합니다.
        </div>
      </div>

      <div class="form-actions">
        ${
          options.showCloseButton
            ? `<button class="button-ghost" type="button" data-action="close-modal" ${busy}>취소</button>`
            : ""
        }
        <button class="button-primary" type="submit" ${busy}>${escapeHtml(options.submitLabel ?? "저장")}</button>
      </div>
    </div>
  `;
}

function renderTypeManagerModal() {
  const editable = canEditSnapshot();
  const busy = disabledAttr(isBusy());
  const draft = state.modal?.draft ?? defaultTypeDraft();
  const types = state.snapshot.types;

  return `
    <div class="modal-backdrop">
      <section class="modal wide">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">타입 관리</h2>
            <p class="modal-copy">물품의 분류를 추가하거나 정리합니다. 속한 물품이 있는 타입은 삭제할 수 없습니다.</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal" ${busy}>닫기</button>
        </div>
        <div class="modal-body">
          ${
            types.length === 0
              ? `
                <section class="empty-state">
                  <div class="empty-state-copy">
                    <h3 class="modal-title">등록된 타입이 없습니다</h3>
                    <p class="muted">아래 폼에서 첫 번째 타입을 추가하세요.</p>
                  </div>
                </section>
              `
              : `
                <div class="type-list">
                  ${types
                    .map((type) => {
                      const count = itemCountForType(state.snapshot, type.id);
                      const canDelete = editable && count === 0;
                      return `
                        <div class="type-list-item">
                          <div class="type-list-head">
                            <span class="type-dot color-${escapeAttr(type.color)}"></span>
                            <div class="stack">
                              <span class="type-list-name">${escapeHtml(type.name)}</span>
                              <span class="muted">물품 ${count}개 · ${escapeHtml(typeColorMeta[type.color]?.title ?? type.color)}</span>
                            </div>
                          </div>
                          <button
                            class="button-danger"
                            type="button"
                            data-action="delete-type"
                            data-type-id="${type.id}"
                            ${disabledAttr(!canDelete)}
                            title="${canDelete ? "타입 삭제" : "속한 물품을 먼저 정리하세요"}"
                          >
                            삭제
                          </button>
                        </div>
                      `;
                    })
                    .join("")}
                </div>
              `
          }

          <form class="form-grid" data-form="type-editor" style="margin-top: 22px;">
            <div class="form-section-title">새 타입 추가</div>
            <div class="split-fields">
              <div class="field-grid">
                <label for="type-name">이름</label>
                <input
                  id="type-name"
                  name="name"
                  value="${escapeAttr(draft.name)}"
                  placeholder="예: 반려동물 용품"
                  required
                  ${disabledAttr(!editable)}
                />
              </div>
              <div class="field-grid">
                <span class="form-section-title">색상</span>
                <div class="color-swatch-row" role="radiogroup" aria-label="타입 색상">
                  ${TYPE_COLORS.map(
                    (color) => `
                      <label class="color-swatch" title="${escapeAttr(typeColorMeta[color]?.title ?? color)}">
                        <input
                          type="radio"
                          name="color"
                          value="${color}"
                          ${draft.color === color ? "checked" : ""}
                          ${disabledAttr(!editable)}
                        />
                        <span class="swatch-dot" style="background: var(--type-color-${color});"></span>
                      </label>
                    `
                  ).join("")}
                </div>
              </div>
            </div>
            <div class="form-actions">
              <button class="button-primary" type="submit" ${disabledAttr(!editable)}>타입 추가</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function defaultTypeDraft() {
  const usedColors = new Set(state.snapshot.types.map((type) => type.color));
  const nextColor = TYPE_COLORS.find((color) => !usedColors.has(color)) ?? TYPE_COLORS[0];
  return { name: "", color: nextColor };
}

function renderItemEditorModal() {
  const draft = state.modal?.draft ?? defaultItemDraft();
  const busy = disabledAttr(isBusy());
  const types = state.snapshot.types;

  return `
    <div class="modal-backdrop">
      <section class="modal wide">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">${draft.id ? "물품 수정" : "새 물품"}</h2>
            <p class="modal-copy">사용기한이 가까운 순으로 정렬되며, 0개가 되면 자동으로 삭제됩니다.</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal" ${busy}>닫기</button>
        </div>
        <div class="modal-body">
          ${
            types.length === 0
              ? `
                <section class="empty-state">
                  <div class="empty-state-copy">
                    <h3 class="modal-title">먼저 타입을 만드세요</h3>
                    <p class="muted">"타입 관리" 에서 최소 한 개의 분류를 추가한 뒤 물품을 등록할 수 있습니다.</p>
                  </div>
                </section>
              `
              : `
                <form class="form-grid" data-form="item-editor">
                  <input type="hidden" name="id" value="${escapeAttr(draft.id ?? "")}" />
                  <div class="split-fields">
                    <div class="field-grid">
                      <label for="item-type">타입</label>
                      <select id="item-type" name="typeID" ${busy}>
                        ${types
                          .map(
                            (type) => `
                              <option value="${type.id}" ${
                                String(type.id) === String(draft.typeID) ? "selected" : ""
                              }>
                                ${escapeHtml(type.name)}
                              </option>
                            `
                          )
                          .join("")}
                      </select>
                    </div>
                    <div class="field-grid">
                      <label for="item-name">이름</label>
                      <input id="item-name" name="name" value="${escapeAttr(draft.name)}" required ${busy} />
                    </div>
                  </div>

                  <div class="split-fields">
                    <div class="field-grid">
                      <label for="item-expires">사용기한</label>
                      <input id="item-expires" name="expiresOn" type="date" value="${escapeAttr(draft.expiresOn)}" required ${busy} />
                    </div>
                    <div class="field-grid">
                      <label for="item-quantity">개수</label>
                      <input id="item-quantity" name="quantity" type="number" min="1" step="1" value="${escapeAttr(draft.quantity)}" required ${busy} />
                    </div>
                  </div>

                  <div class="field-grid">
                    <label for="item-location">보관 위치 (선택)</label>
                    <input id="item-location" name="location" value="${escapeAttr(draft.location)}" placeholder="예: 냉장고, 화장대 서랍" ${busy} />
                  </div>

                  <div class="field-grid">
                    <label for="item-notes">메모 (선택)</label>
                    <textarea id="item-notes" name="notes" placeholder="브랜드, 구매처 등 자유롭게 기록" ${busy}>${escapeHtml(draft.notes)}</textarea>
                  </div>

                  <div class="form-actions">
                    <button class="button-ghost" type="button" data-action="close-modal" ${busy}>취소</button>
                    <button class="button-primary" type="submit" ${busy}>저장</button>
                  </div>
                </form>
              `
          }
        </div>
      </section>
    </div>
  `;
}

function defaultItemDraft() {
  const firstType = state.snapshot.types[0];
  return {
    id: "",
    typeID: firstType ? String(firstType.id) : "",
    name: "",
    expiresOn: todayDateKey(),
    quantity: "1",
    location: "",
    notes: "",
  };
}

function itemDraftFromRecord(item) {
  return {
    id: item.id,
    typeID: String(item.typeID),
    name: item.name,
    expiresOn: item.expiresOn,
    quantity: String(item.quantity),
    location: item.location ?? "",
    notes: item.notes ?? "",
  };
}

function readItemDraftFromForm(form) {
  const formData = new FormData(form);
  return {
    id: String(formData.get("id") ?? ""),
    typeID: String(formData.get("typeID") ?? ""),
    name: String(formData.get("name") ?? ""),
    expiresOn: String(formData.get("expiresOn") ?? ""),
    quantity: String(formData.get("quantity") ?? "1"),
    location: String(formData.get("location") ?? ""),
    notes: String(formData.get("notes") ?? ""),
  };
}

function readTypeDraftFromForm(form) {
  const formData = new FormData(form);
  return {
    name: String(formData.get("name") ?? ""),
    color: String(formData.get("color") ?? TYPE_COLORS[0]),
  };
}

function renderConfirmModal() {
  const modal = state.modal;
  const busy = disabledAttr(isBusy());

  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">${escapeHtml(modal.title)}</h2>
            <p class="modal-copy confirm-copy">${escapeHtml(modal.message)}</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal" ${busy}>닫기</button>
        </div>
        <div class="modal-body">
          <form class="form-grid" data-form="confirm-action">
            <input type="hidden" name="confirmType" value="${escapeAttr(modal.type)}" />
            ${
              modal.itemId
                ? `<input type="hidden" name="itemId" value="${escapeAttr(modal.itemId)}" />`
                : ""
            }
            ${
              modal.typeId != null
                ? `<input type="hidden" name="typeId" value="${escapeAttr(modal.typeId)}" />`
                : ""
            }
            <div class="form-actions">
              <button class="button-ghost" type="button" data-action="close-modal" ${busy}>취소</button>
              <button class="${modal.destructive ? "button-danger" : "button-primary"}" type="submit" ${busy}>
                ${escapeHtml(modal.confirmLabel)}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const editActions = new Set([
    "open-add-item",
    "edit-item",
    "delete-item",
    "decrement-item",
    "open-type-manager",
    "delete-type",
  ]);

  if (editActions.has(action) && !canEditSnapshot()) {
    state.errorMessage = lockedMutationMessage();
    render();
    return;
  }

  if (action === "open-settings") {
    openModal("settings");
  } else if (action === "set-filter") {
    const value = String(button.dataset.filterValue ?? "all");
    state.selectedTypeFilter = value === "all" ? "all" : Number(value);
    normalizeFilterSelection();
    render();
  } else if (action === "open-add-item") {
    if (state.snapshot.types.length === 0) {
      state.errorMessage = "먼저 타입 관리에서 분류를 만드세요.";
      render();
      return;
    }
    openModal("item-editor", { draft: defaultItemDraft() });
  } else if (action === "edit-item") {
    const item = findItem(button.dataset.itemId);
    if (!item) {
      return;
    }
    openModal("item-editor", { draft: itemDraftFromRecord(item) });
  } else if (action === "delete-item") {
    const item = findItem(button.dataset.itemId);
    if (!item) {
      return;
    }
    openModal("confirm-delete-item", {
      title: "물품을 삭제할까요?",
      message: `${item.name} (${item.quantity}개, ${formatExpiresOnLabel(item.expiresOn)}) 항목을 삭제합니다.`,
      confirmLabel: "삭제",
      destructive: true,
      itemId: item.id,
    });
  } else if (action === "decrement-item") {
    const item = findItem(button.dataset.itemId);
    if (!item) {
      return;
    }
    void performDecrement(item.id);
  } else if (action === "open-type-manager") {
    openModal("type-manager", { draft: defaultTypeDraft() });
  } else if (action === "delete-type") {
    const typeID = Number(button.dataset.typeId);
    const type = typeByID(state.snapshot, typeID);
    if (!type) {
      return;
    }
    openModal("confirm-delete-type", {
      title: "타입을 삭제할까요?",
      message: `${type.name} 타입을 삭제합니다. 이 타입에는 현재 연결된 물품이 없습니다.`,
      confirmLabel: "삭제",
      destructive: true,
      typeId: typeID,
    });
  } else if (action === "close-modal") {
    closeModal();
  }
}

async function handleSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) {
    return;
  }

  event.preventDefault();
  clearError();

  try {
    if (form.dataset.form === "settings-onboarding" || form.dataset.form === "settings-modal") {
      await saveSettings(form, form.dataset.form === "settings-modal");
      return;
    }

    if (form.dataset.form === "item-editor") {
      await saveItem(form);
      return;
    }

    if (form.dataset.form === "type-editor") {
      await saveType(form);
      return;
    }

    if (form.dataset.form === "confirm-action") {
      await performConfirm(form);
    }
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : "작업을 처리하지 못했습니다.";
    render();
  }
}

function handleChange(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) {
    return;
  }

  if (form.dataset.form === "item-editor") {
    state.modal = {
      type: "item-editor",
      draft: readItemDraftFromForm(form),
    };
    render();
  } else if (form.dataset.form === "type-editor") {
    state.modal = {
      type: "type-manager",
      draft: readTypeDraftFromForm(form),
    };
    render();
  }
}

function handleKeyDown(event) {
  if (event.key === "Escape" && state.modal && !isBusy()) {
    closeModal();
  }
}

async function saveSettings(form, closeOnSuccess) {
  const formData = new FormData(form);
  const gitHubConfig = trimmedGitHubConfig({
    owner: formData.get("owner"),
    repo: formData.get("repo"),
    branch: formData.get("branch"),
    filePath: formData.get("filePath"),
  });
  const currentConfig = trimmedGitHubConfig(state.settings.gitHubConfig);
  const configChanged = !gitHubConfigEquals(currentConfig, gitHubConfig);
  const token = String(formData.get("token") ?? "").trim();

  if (!isGitHubConfigValid(gitHubConfig)) {
    throw new Error("GitHub 저장소 설정을 모두 입력하세요.");
  }

  const nextToken = token || state.token;
  if (!nextToken) {
    if (hasLegacyTokenMigrationPending()) {
      throw new Error("보안 방식이 바뀌어 GitHub token을 한 번 다시 입력해야 합니다.");
    }
    throw new Error("GitHub token을 입력하세요.");
  }

  state.isBootstrapping = true;
  clearError();
  render();

  try {
    const envelope = await fetchSnapshot(gitHubConfig, nextToken);
    state.token = nextToken;
    applyFetchedSnapshot(envelope, {
      gitHubConfig,
      lastSyncedAt: configChanged ? null : state.settings.lastSyncedAt,
    });
    await persistConnectionToken(state.token);
    await persistSnapshot(state.snapshot);
    await persistSettings(state.settings);

    if (closeOnSuccess) {
      closeModal(false);
    }
  } finally {
    state.isBootstrapping = false;
    render();
  }
}

async function persistConnectionToken(token) {
  await persistToken(token);
  await clearLegacyTokenStorage();
}

async function clearLegacyTokenStorage() {
  if (!state.hasLegacyTokenEnvelope) {
    return;
  }

  await clearLegacyTokenEnvelope();
  state.hasLegacyTokenEnvelope = false;
}

async function saveItem(form) {
  assertEditableSnapshot();
  const draft = readItemDraftFromForm(form);
  const typeID = Number.parseInt(draft.typeID, 10);
  const quantity = Number.parseInt(draft.quantity, 10);

  if (!Number.isInteger(typeID) || !state.snapshot.types.some((type) => type.id === typeID)) {
    throw new Error("타입을 선택하세요.");
  }

  if (!draft.name.trim()) {
    throw new Error("물품 이름을 입력하세요.");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.expiresOn)) {
    throw new Error("사용기한을 올바르게 입력하세요.");
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("개수는 1 이상의 정수여야 합니다.");
  }

  const record = {
    id: draft.id || crypto.randomUUID(),
    typeID,
    name: draft.name.trim(),
    expiresOn: draft.expiresOn,
    quantity,
    location: draft.location.trim() || null,
    notes: draft.notes.trim() || null,
  };

  await commitSnapshot(upsertItem(state.snapshot, record));
  closeModal();
}

async function saveType(form) {
  assertEditableSnapshot();
  const draft = readTypeDraftFromForm(form);

  await commitSnapshot(
    upsertType(state.snapshot, {
      id: null,
      name: draft.name,
      color: draft.color,
    })
  );

  state.modal = { type: "type-manager", draft: defaultTypeDraft() };
  render();
}

async function performDecrement(itemID) {
  assertEditableSnapshot();
  try {
    await commitSnapshot(decrementItem(state.snapshot, itemID));
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : "개수 차감에 실패했습니다.";
    render();
  }
}

async function performConfirm(form) {
  assertEditableSnapshot();
  const formData = new FormData(form);
  const confirmType = String(formData.get("confirmType"));

  if (confirmType === "confirm-delete-item") {
    await commitSnapshot(deleteItem(state.snapshot, String(formData.get("itemId"))));
    closeModal();
    return;
  }

  if (confirmType === "confirm-delete-type") {
    const typeID = Number(formData.get("typeId"));
    await commitSnapshot(deleteType(state.snapshot, typeID));
    state.modal = { type: "type-manager", draft: defaultTypeDraft() };
    render();
  }
}

async function bootstrapFromRemote() {
  if (!canRunRemoteAction()) {
    return;
  }

  state.isBootstrapping = true;
  clearError();
  render();

  try {
    const envelope = await fetchSnapshot(state.settings.gitHubConfig, state.token);
    applyFetchedSnapshot(envelope);
    await clearLegacyTokenStorage();
    await persistSnapshot(state.snapshot);
    await persistSettings(state.settings);
  } catch (error) {
    throw error instanceof Error ? error : new Error("GitHub에서 데이터를 불러오지 못했습니다.");
  } finally {
    state.isBootstrapping = false;
    render();
  }
}

async function commitSnapshot(nextSnapshot) {
  assertEditableSnapshot();
  const normalizedSnapshot = normalizeSnapshot(nextSnapshot);

  state.isSyncing = true;
  clearError();
  render();

  try {
    const nextSHA = await pushSnapshot(
      state.settings.gitHubConfig,
      state.token,
      normalizedSnapshot,
      state.settings.remoteSHA
    );
    state.snapshot = normalizedSnapshot;
    state.settings = {
      ...state.settings,
      remoteSHA: nextSHA,
      lastSyncedAt: new Date().toISOString(),
    };
    await persistSnapshot(state.snapshot);
    await persistSettings(state.settings);
    normalizeFilterSelection();
  } catch (error) {
    throw error instanceof Error ? error : new Error("GitHub에 저장하지 못했습니다.");
  } finally {
    state.isSyncing = false;
    render();
  }
}

function openModal(type, payload = {}) {
  state.modal = { type, ...payload };
  render();
}

function closeModal(renderAfterClose = true) {
  state.modal = null;
  if (renderAfterClose) {
    render();
  }
}

function clearError() {
  state.errorMessage = "";
}

function findItem(itemID) {
  return state.snapshot.items.find((item) => item.id === itemID) ?? null;
}

function createPantryIllustration() {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const context = canvas.getContext("2d");

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#ecfeff");
  gradient.addColorStop(0.55, "#fff7ed");
  gradient.addColorStop(1, "#fef3c7");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  drawRoundedRect(context, 78, 82, 804, 376, 24, "#ffffff", "#d6e3ea", 2);

  const cardY = [128, 228, 328];
  const cardColors = ["#be123c", "#ea580c", "#0d9488"];
  const cardLabels = ["D+2 · 기한 지남", "D-4 · 임박", "D-18 · 이번 달"];
  const cardItems = ["우유 1L", "선크림 50ml", "종합 비타민"];

  for (let index = 0; index < cardY.length; index += 1) {
    const y = cardY[index];
    drawRoundedRect(context, 124, y, 712, 76, 14, "#f8fafc", "#e2e8f0", 2);
    context.fillStyle = cardColors[index];
    context.fillRect(124, y, 8, 76);
    context.fillStyle = "#0f172a";
    context.font = "700 22px Inter, sans-serif";
    context.fillText(cardItems[index], 154, y + 34);
    context.fillStyle = "#64748b";
    context.font = "500 18px Inter, sans-serif";
    context.fillText(cardLabels[index], 154, y + 58);
    context.fillStyle = cardColors[index];
    drawRoundedRect(context, 680, y + 22, 130, 32, 16, cardColors[index], cardColors[index], 0);
    context.fillStyle = "#ffffff";
    context.font = "600 14px Inter, sans-serif";
    context.fillText(cardLabels[index].split(" · ")[0], 715, y + 43);
  }

  context.fillStyle = "#0f172a";
  context.font = "700 28px Inter, sans-serif";
  context.fillText("가장 가까운 순으로", 124, 430);
  context.fillStyle = "#64748b";
  context.font = "500 18px Inter, sans-serif";
  context.fillText("타입별 필터, 개수 관리, 자동 동기화", 124, 456);

  return canvas.toDataURL("image/png");
}

function drawRoundedRect(context, x, y, width, height, radius, fill, stroke, strokeWidth) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  if (strokeWidth > 0) {
    context.strokeStyle = stroke;
    context.lineWidth = strokeWidth;
    context.stroke();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
