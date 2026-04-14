import {
  addMonths,
  amountInKRW,
  colorForSource,
  compareYearMonths,
  defaultMonthForCreation,
  deleteExpense,
  deleteMonthPage,
  deleteSource,
  emptyExchangeRates,
  emptySnapshot,
  expenseOccursInMonth,
  firstDateOfYearMonth,
  formatAmount,
  formatDateLabel,
  formatDateTimeLabel,
  formatInputAmount,
  formattedKRWEquivalent,
  fromDateInputValue,
  hasExchangeRate,
  insertMonthPage,
  isGitHubConfigValid,
  issueMessage,
  materializedDisplayDate,
  monthDeletionImpact,
  nextFundingSourceId,
  normalizeSnapshot,
  normalizeYearMonth,
  occurrencesForMonth,
  parseDateInputToYearMonth,
  parseMinorUnits,
  sourceById,
  sourceKindMeta,
  toDateInputValue,
  toMonthInputValue,
  totalAmountForMonth,
  totalsForMonth,
  trimmedGitHubConfig,
  upsertExchangeRates,
  upsertExpense,
  upsertSource,
  validateExpenseMonths,
  yearMonthFromDate,
  yearMonthKey,
  yearMonthTitle,
  currencyMeta,
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
const expenseKindFilterMeta = {
  all: {
    label: "전체",
    summaryTitle: "전체 지출",
    listTitle: "전체 지출 내역",
  },
  recurring: {
    label: "정기",
    summaryTitle: "정기 지출",
    listTitle: "정기 지출 내역",
  },
  oneOff: {
    label: "일회성",
    summaryTitle: "일회성 지출",
    listTitle: "일회성 지출 내역",
  },
};

const state = {
  snapshot: emptySnapshot(),
  settings: defaultSettings(),
  token: null,
  hasLegacyTokenEnvelope: false,
  isBootstrapping: false,
  isSyncing: false,
  errorMessage: "",
  selectedMonthKey: null,
  selectedSourceId: null,
  selectedExpenseKindFilter: "all",
  modal: null,
  illustrationDataUrl: "",
};

root.addEventListener("click", handleClick);
root.addEventListener("submit", handleSubmit);
root.addEventListener("change", handleChange);
window.addEventListener("keydown", handleKeyDown);

void initialize();

async function initialize() {
  state.illustrationDataUrl = createLedgerIllustration();

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

  normalizeSelection();
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
      filePath: "track-your-expense.json",
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

function currentMonth() {
  return months().find((month) => yearMonthKey(month) === state.selectedMonthKey) ?? null;
}

function months() {
  return state.snapshot.monthPages.map((entry) => entry.yearMonth).sort(compareYearMonths);
}

function currentTotals() {
  const month = currentMonth();
  return month ? totalsForMonth(month, state.snapshot, state.selectedExpenseKindFilter) : [];
}

function currentOccurrences() {
  const month = currentMonth();
  if (!month) {
    return [];
  }
  return occurrencesForMonth(
    month,
    state.selectedSourceId,
    state.snapshot,
    state.selectedExpenseKindFilter
  );
}

function selectedSource() {
  if (state.selectedSourceId == null) {
    return null;
  }
  return sourceById(state.snapshot, state.selectedSourceId);
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
  normalizeSelection();
}

function normalizeSelection() {
  const availableMonths = months();

  if (availableMonths.length === 0) {
    state.selectedMonthKey = null;
    state.selectedSourceId = null;
    return;
  }

  if (!availableMonths.some((month) => yearMonthKey(month) === state.selectedMonthKey)) {
    state.selectedMonthKey = yearMonthKey(availableMonths[availableMonths.length - 1]);
  }

  const visibleTotals = currentTotals();
  if (!visibleTotals.some((entry) => entry.source.id === state.selectedSourceId)) {
    state.selectedSourceId = null;
  }
}

function currentExpenseKindFilterMeta() {
  return expenseKindFilterMeta[state.selectedExpenseKindFilter] ?? expenseKindFilterMeta.all;
}

function isExpenseKindFilter(value) {
  return Boolean(expenseKindFilterMeta[value]);
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
  const showTokenFields = true;

  return `
    <div class="app-frame">
      ${renderStatusBar()}
      <section class="onboarding-shell">
        <div class="onboarding-copy">
          <div class="brand-block">
            <h1 class="brand-title">Track Your Expense Web</h1>
            <p class="brand-copy">
              GitHub Pages에 올릴 수 있는 정적 웹 앱입니다. 실제 지출 데이터는 별도 private
              repository의 JSON 파일 하나를 브라우저에서 직접 읽고 씁니다.
            </p>
          </div>
          <div class="onboarding-media">
            <img src="${state.illustrationDataUrl}" alt="가계부와 월별 지출 흐름을 그린 이미지" />
          </div>
          <div class="stack">
            <div class="badge badge-success">정적 호스팅 가능</div>
            <div class="muted">public web repo + private data repo 조합을 기준으로 설계했습니다.</div>
            <div class="muted">입력한 GitHub PAT는 이 브라우저에 저장되어 이후 재입력 없이 바로 사용합니다.</div>
          </div>
        </div>
        <div class="onboarding-form-wrap">
          <form class="form-grid" data-form="settings-onboarding">
            ${renderSettingsFields(config, {
              tokenValue: "",
              showTokenFields,
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
  const month = currentMonth();
  const totals = currentTotals();
  const source = selectedSource();
  const occurrences = currentOccurrences();
  const filterMeta = currentExpenseKindFilterMeta();
  const totalAmount = month
    ? totalAmountForMonth(month, state.snapshot, state.selectedExpenseKindFilter)
    : 0;
  const todayDateKey = toDateInputValue(new Date());
  const editable = canEditSnapshot();
  const busy = disabledAttr(isBusy());

  return `
    <div class="app-frame">
      <div class="topbar">
        <div class="brand-block">
          <h1 class="brand-title">Track Your Expense Web</h1>
          <p class="brand-copy">
            저장된 GitHub PAT로 최신 JSON을 다시 확인하고, 이후 변경 사항은 저장할 때마다 GitHub에 즉시 반영합니다.
          </p>
        </div>
        <div class="header-actions">
          <button class="button-ghost" type="button" data-action="open-settings" ${busy}>GitHub 설정</button>
        </div>
      </div>

      ${renderStatusBar()}

      <div class="toolbar">
        <button class="button-ghost" type="button" data-action="open-sources" ${disabledAttr(!editable)}>카드/계좌</button>
        <button class="button-ghost" type="button" data-action="open-rates" ${disabledAttr(!editable)}>환율 설정</button>
        <button
          class="button-ghost"
          type="button"
          data-action="open-add-expense"
          ${disabledAttr(!editable || months().length === 0 || state.snapshot.sources.length === 0)}
        >
          지출 추가
        </button>
        <button class="button-ghost" type="button" data-action="open-add-month" ${disabledAttr(!editable)}>월 추가</button>
      </div>

      ${
        months().length === 0
          ? renderEmptyDashboard()
          : `
            <div class="dashboard-grid">
              <section class="panel">
                <div class="panel-head">
                  <div>
                    <div class="form-section-title">월 목록</div>
                    <div class="muted">기본 선택은 최신 월입니다.</div>
                  </div>
                  <button class="button-ghost" type="button" data-action="open-add-month" ${disabledAttr(!editable)}>추가</button>
                </div>
                <div class="panel-body month-list">
                  ${months()
                    .map(
                      (entry) => `
                        <button
                          class="month-button ${yearMonthKey(entry) === state.selectedMonthKey ? "is-selected" : ""}"
                          type="button"
                          data-action="select-month"
                          data-month-key="${yearMonthKey(entry)}"
                        >
                          <strong>${yearMonthTitle(entry)}</strong>
                          <span class="muted">${
                            yearMonthKey(entry) === state.selectedMonthKey ? "현재 선택됨" : "선택"
                          }</span>
                        </button>
                      `
                    )
                    .join("")}
                </div>
              </section>

              <section class="panel">
                <div class="panel-head">
                  <div class="summary-panel-head">
                    <div class="summary-block">
                      <div class="form-section-title">${yearMonthTitle(month)}</div>
                      <p class="summary-amount">${formatAmount(totalAmount, "krw")}</p>
                      <div class="muted">
                        월 bar는 ${filterMeta.summaryTitle}의 source별 월 합계를 기준으로 계산합니다.
                      </div>
                    </div>
                    ${renderExpenseKindFilterControl()}
                  </div>
                  <button
                    class="button-danger"
                    type="button"
                    data-action="delete-month"
                    data-month-key="${yearMonthKey(month)}"
                    ${disabledAttr(!editable)}
                  >
                    월 삭제
                  </button>
                </div>
                <div class="panel-body">
                  ${
                    totals.length === 0
                      ? `
                        <section class="empty-state">
                          <div class="empty-state-copy">
                            <h2 class="modal-title">표시할 지출이 없습니다</h2>
                            <p class="muted">${escapeHtml(buildTotalsEmptyMessage(month))}</p>
                          </div>
                        </section>
                      `
                      : `
                        <div class="source-total-grid">
                          ${totals
                            .map(
                              (entry) => `
                                <button
                                  class="source-total-button ${
                                    entry.source.id === state.selectedSourceId ? "is-selected" : ""
                                  }"
                                  type="button"
                                  data-action="select-source"
                                  data-source-id="${entry.source.id}"
                                >
                                  <div class="source-total-head">
                                    <span
                                      class="source-dot"
                                      style="background:${colorForSource(entry.source.id)}"
                                    ></span>
                                    <div class="stack">
                                      <span class="source-name">${escapeHtml(entry.source.name)}</span>
                                      <span class="muted">${sourceKindMeta[entry.source.kind].title}</span>
                                    </div>
                                  </div>
                                  <div class="source-total-amount">${formatAmount(entry.total, "krw")}</div>
                                </button>
                              `
                            )
                            .join("")}
                        </div>
                      `
                  }
                </div>
              </section>

              <section class="panel">
                <div class="panel-head">
                  <div>
                    <div class="form-section-title">
                      ${source ? escapeHtml(source.name) : filterMeta.listTitle}
                    </div>
                    <div class="muted">
                      ${
                        source
                          ? `${yearMonthTitle(month)}에서 선택한 source의 ${filterMeta.summaryTitle}을 최신순으로 표시합니다.`
                          : `${yearMonthTitle(month)}의 ${filterMeta.summaryTitle}을 최신순으로 표시합니다.`
                      }
                    </div>
                  </div>
                  ${
                    source
                      ? `
                        <button
                          class="button-ghost"
                          type="button"
                          data-action="open-add-expense"
                          ${disabledAttr(!editable)}
                        >
                          이 source에 지출 추가
                        </button>
                      `
                      : ""
                  }
                </div>
                <div class="panel-body">
                  ${
                    occurrences.length === 0
                        ? `
                          <section class="empty-state">
                            <div class="empty-state-copy">
                              <h2 class="modal-title">표시할 지출이 없습니다</h2>
                              <p class="muted">${escapeHtml(buildOccurrencesEmptyMessage(month, source))}</p>
                            </div>
                          </section>
                        `
                        : `
                          <div class="expense-list">
                            ${occurrences
                              .map(
                                (entry) => `
                                  <article class="expense-row ${
                                    toDateInputValue(entry.displayDate) > todayDateKey
                                      ? "expense-row-future"
                                      : "expense-row-current-or-past"
                                  }">
                                    <div class="expense-main">
                                      <div class="stack">
                                        <div class="expense-title">${
                                          escapeHtml(entry.expense.description ?? "설명 없음")
                                        }</div>
                                        <div class="expense-meta">
                                          <span>${formatDateLabel(entry.displayDate)}</span>
                                          <span>
                                            ${escapeHtml(entry.source.name)} · ${
                                              sourceKindMeta[entry.source.kind].title
                                            }
                                          </span>
                                          <span>${entry.expense.recurrence ? "반복 지출" : "일회성"}</span>
                                          <span>${currencyMeta[entry.expense.currency].code}</span>
                                        </div>
                                      </div>
                                      <div class="stack" style="text-align:right;">
                                        <strong>${formatAmount(entry.expense.amountMinorUnits, entry.expense.currency)}</strong>
                                        ${
                                          formattedKRWEquivalent(
                                            entry.expense,
                                            state.snapshot.exchangeRates ?? emptyExchangeRates()
                                          )
                                            ? `<span class="muted">${formattedKRWEquivalent(
                                                entry.expense,
                                                state.snapshot.exchangeRates ?? emptyExchangeRates()
                                              )}</span>`
                                            : ""
                                        }
                                      </div>
                                    </div>
                                    <div class="expense-meta">
                                      <button
                                        class="button-subtle"
                                        type="button"
                                        data-action="edit-expense"
                                        data-expense-id="${entry.expense.id}"
                                        ${disabledAttr(!editable)}
                                      >
                                        수정
                                      </button>
                                      <button
                                        class="button-danger"
                                        type="button"
                                        data-action="delete-expense"
                                        data-expense-id="${entry.expense.id}"
                                        ${disabledAttr(!editable)}
                                      >
                                        삭제
                                      </button>
                                    </div>
                                  </article>
                                `
                              )
                              .join("")}
                          </div>
                        `
                  }
                </div>
              </section>
            </div>
          `
      }
      ${renderModal()}
    </div>
  `;
}

function renderExpenseKindFilterControl() {
  return `
    <div class="segmented-control" role="group" aria-label="지출 유형 필터">
      ${Object.entries(expenseKindFilterMeta)
        .map(
          ([filter, meta]) => `
            <button
              class="segmented-control-button ${
                state.selectedExpenseKindFilter === filter ? "is-selected" : ""
              }"
              type="button"
              data-action="select-expense-kind-filter"
              data-filter-kind="${filter}"
              aria-pressed="${state.selectedExpenseKindFilter === filter}"
            >
              ${meta.label}
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function buildTotalsEmptyMessage(month) {
  if (state.selectedExpenseKindFilter === "all") {
    return "이 월에는 입력된 지출이 아직 없습니다.";
  }

  return `${yearMonthTitle(month)}에는 ${currentExpenseKindFilterMeta().summaryTitle}이 아직 없습니다.`;
}

function buildOccurrencesEmptyMessage(month, source) {
  if (source) {
    if (state.selectedExpenseKindFilter === "all") {
      return "선택한 월과 source 조합에는 표시할 항목이 아직 없습니다.";
    }

    return `선택한 월과 source 조합에는 ${currentExpenseKindFilterMeta().summaryTitle} 항목이 아직 없습니다.`;
  }

  return buildTotalsEmptyMessage(month);
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

function renderEmptyDashboard() {
  const editable = canEditSnapshot();

  return `
    <section class="empty-state">
      <div class="empty-state-media">
        <img src="${state.illustrationDataUrl}" alt="월별 합계와 결제 수단을 그린 이미지" />
      </div>
      <div class="empty-state-copy">
        <h2 class="modal-title">생성된 월이 없습니다</h2>
        <p class="muted">
          월 페이지는 사용자가 명시적으로 만듭니다. 먼저 월을 하나 추가하고, 필요하면 카드나 계좌를 등록한 다음 지출을 입력하세요.
        </p>
      </div>
      <div class="form-actions" style="justify-content:flex-start;">
        <button class="button-primary" type="button" data-action="open-add-month" ${disabledAttr(!editable)}>월 추가</button>
        <button class="button-ghost" type="button" data-action="open-sources" ${disabledAttr(!editable)}>카드/계좌 관리</button>
      </div>
    </section>
  `;
}

function renderModal() {
  if (!state.modal) {
    return "";
  }

  if (state.modal.type === "settings") {
    return renderSettingsModal();
  }

  if (state.modal.type === "sources") {
    return renderSourcesModal();
  }

  if (state.modal.type === "source-editor") {
    return renderSourceEditorModal();
  }

  if (state.modal.type === "month-editor") {
    return renderMonthEditorModal();
  }

  if (state.modal.type === "expense-editor") {
    return renderExpenseEditorModal();
  }

  if (state.modal.type === "rates") {
    return renderRatesModal();
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
              web app 코드는 public Pages repo에 두고, 실제 지출 데이터는 별도 private repository의 JSON 파일을 가리키는 구성을 권장합니다.
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

function renderSourcesModal() {
  const sources = state.snapshot.sources.slice().sort((left, right) => left.id - right.id);
  const editable = canEditSnapshot();
  const busy = disabledAttr(isBusy());

  return `
    <div class="modal-backdrop">
      <section class="modal wide">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">카드/계좌 관리</h2>
            <p class="modal-copy">source 삭제 시 연결된 모든 지출도 함께 삭제됩니다.</p>
          </div>
          <div class="header-actions">
            <button class="button-ghost" type="button" data-action="add-source" ${disabledAttr(!editable)}>추가</button>
            <button class="button-subtle" type="button" data-action="close-modal" ${busy}>닫기</button>
          </div>
        </div>
        <div class="modal-body">
          ${
            sources.length === 0
              ? `
                <section class="empty-state">
                  <div class="empty-state-copy">
                    <h3 class="modal-title">등록된 카드/계좌가 없습니다</h3>
                    <p class="muted">지출을 기록하기 전에 카드나 계좌를 먼저 등록하세요.</p>
                  </div>
                </section>
              `
              : `
                <div class="source-list">
                  ${sources
                    .map(
                      (source) => `
                        <article class="source-list-item">
                          <div class="source-list-head">
                            <div class="stack">
                              <div class="source-name">${escapeHtml(source.name)}</div>
                              <div class="inline-copy">
                                <span>${sourceKindMeta[source.kind].title}</span>
                                <span>연결 지출 ${linkedExpenseCount(source.id)}개</span>
                              </div>
                            </div>
                            <div class="inline-copy">
                              <button
                                class="button-subtle"
                                type="button"
                                data-action="edit-source"
                                data-source-id="${source.id}"
                                ${disabledAttr(!editable)}
                              >
                                수정
                              </button>
                              <button
                                class="button-danger"
                                type="button"
                                data-action="delete-source"
                                data-source-id="${source.id}"
                                ${disabledAttr(!editable)}
                              >
                                삭제
                              </button>
                            </div>
                          </div>
                        </article>
                      `
                    )
                    .join("")}
                </div>
              `
          }
        </div>
      </section>
    </div>
  `;
}

function renderSourceEditorModal() {
  const draft = state.modal?.draft ?? { id: null, kind: "card", name: "" };
  const isEditing = Boolean(draft.id);
  const busy = disabledAttr(isBusy());

  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">${isEditing ? "카드/계좌 수정" : "카드/계좌 추가"}</h2>
            <p class="modal-copy">정렬 순서는 항상 source ID 오름차순입니다.</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal" ${busy}>닫기</button>
        </div>
        <div class="modal-body">
          <form class="form-grid" data-form="source-editor">
            <input type="hidden" name="id" value="${escapeAttr(draft.id ?? "")}" />
            <div class="field-grid">
              <span class="form-section-title">종류</span>
              <div class="radio-row">
                ${["card", "account"]
                  .map(
                    (kind) => `
                      <label class="pill-radio">
                        <input
                          type="radio"
                          name="kind"
                          value="${kind}"
                          ${draft.kind === kind ? "checked" : ""}
                          ${busy}
                        />
                        <span>${sourceKindMeta[kind].title}</span>
                      </label>
                    `
                  )
                  .join("")}
              </div>
            </div>
            <div class="field-grid">
              <label for="source-name">이름</label>
              <input id="source-name" name="name" value="${escapeAttr(draft.name)}" required ${busy} />
            </div>
            <div class="form-actions">
              <button class="button-ghost" type="button" data-action="close-modal" ${busy}>취소</button>
              <button class="button-primary" type="submit" ${busy}>저장</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderMonthEditorModal() {
  const draft = state.modal?.draft ?? {
    month: toMonthInputValue(defaultMonthForCreation(months(), currentMonth() ?? yearMonthFromDate(new Date()))),
  };
  const busy = disabledAttr(isBusy());

  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">월 추가</h2>
            <p class="modal-copy">월 페이지는 자동 생성되지 않고 사용자가 명시적으로 생성합니다.</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal" ${busy}>닫기</button>
        </div>
        <div class="modal-body">
          <form class="form-grid" data-form="month-editor">
            <div class="field-grid">
              <label for="month-value">월</label>
              <input id="month-value" name="month" type="month" value="${escapeAttr(draft.month)}" required ${busy} />
              <small class="form-note">저장 시 ${escapeHtml(yearMonthTitle(parseDateInputToYearMonth(draft.month)))} 페이지가 생성됩니다.</small>
            </div>
            <div class="form-actions">
              <button class="button-ghost" type="button" data-action="close-modal" ${busy}>취소</button>
              <button class="button-primary" type="submit" ${busy}>저장</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderRatesModal() {
  const exchangeRates = state.snapshot.exchangeRates ?? emptyExchangeRates();
  const draft = state.modal?.draft ?? {
    usdToKRWPer1: exchangeRates.usdToKRWPer1 ? String(exchangeRates.usdToKRWPer1) : "",
    jpyToKRWPer100: exchangeRates.jpyToKRWPer100 ? String(exchangeRates.jpyToKRWPer100) : "",
  };
  const busy = disabledAttr(isBusy());

  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">환율 설정</h2>
            <p class="modal-copy">저장한 환율은 GitHub JSON에 즉시 반영되고, 월별 KRW 합계 계산에도 바로 반영됩니다.</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal" ${busy}>닫기</button>
        </div>
        <div class="modal-body">
          <form class="form-grid" data-form="rates-editor">
            <div class="split-fields">
              <div class="field-grid">
                <label for="usd-rate">1 USD</label>
                <input id="usd-rate" name="usdToKRWPer1" inputmode="numeric" value="${escapeAttr(draft.usdToKRWPer1)}" required ${busy} />
              </div>
              <div class="field-grid">
                <label for="jpy-rate">100 JPY</label>
                <input id="jpy-rate" name="jpyToKRWPer100" inputmode="numeric" value="${escapeAttr(draft.jpyToKRWPer100)}" required ${busy} />
              </div>
            </div>
            <div class="form-actions">
              <button class="button-ghost" type="button" data-action="close-modal" ${busy}>취소</button>
              <button class="button-primary" type="submit" ${busy}>저장</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderExpenseEditorModal() {
  const draft = state.modal?.draft ?? defaultExpenseDraft();
  const exchangeRates = state.snapshot.exchangeRates ?? emptyExchangeRates();
  const amountValue = parseMinorUnits(draft.amountText, draft.currency);
  const monthIssues = buildExpenseValidationIssuesFromDraft(draft);
  const amountValidationText = buildAmountValidationText(draft.amountText, draft.currency);
  const rateHelp = buildRateHelpText(draft.currency, exchangeRates);
  const busy = disabledAttr(isBusy());

  return `
    <div class="modal-backdrop">
      <section class="modal wide">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">${draft.id ? "지출 수정" : "지출 추가"}</h2>
            <p class="modal-copy">반복 지출 수정은 특정 월 예외가 아니라 전체 규칙 수정입니다.</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal" ${busy}>닫기</button>
        </div>
        <div class="modal-body">
          ${
            state.snapshot.sources.length === 0
              ? `
                <section class="empty-state">
                  <div class="empty-state-copy">
                    <h3 class="modal-title">카드/계좌가 없습니다</h3>
                    <p class="muted">지출을 기록하기 전에 카드나 계좌를 먼저 등록하세요.</p>
                  </div>
                </section>
              `
              : `
                <form class="form-grid" data-form="expense-editor">
                  <input type="hidden" name="id" value="${escapeAttr(draft.id ?? "")}" />
                  <div class="split-fields">
                    <div class="field-grid">
                      <label for="expense-source">카드/계좌</label>
                      <select id="expense-source" name="sourceID" ${busy}>
                        ${state.snapshot.sources
                          .map(
                            (source) => `
                              <option value="${source.id}" ${
                                String(source.id) === String(draft.sourceID) ? "selected" : ""
                              }>
                                ${escapeHtml(source.name)} · ${sourceKindMeta[source.kind].title}
                              </option>
                            `
                          )
                          .join("")}
                      </select>
                    </div>
                    <div class="field-grid">
                      <label for="expense-description">설명</label>
                      <input id="expense-description" name="description" value="${escapeAttr(draft.description)}" ${busy} />
                    </div>
                  </div>

                  <div class="split-fields">
                    <div class="field-grid">
                      <label for="expense-currency">통화</label>
                      <select id="expense-currency" name="currency" ${busy}>
                        ${Object.entries(currencyMeta)
                          .map(
                            ([key, meta]) => `
                              <option value="${key}" ${draft.currency === key ? "selected" : ""}>
                                ${meta.title} · ${meta.code}
                              </option>
                            `
                          )
                          .join("")}
                      </select>
                    </div>
                    <div class="field-grid">
                      <label for="expense-amount">금액 (${currencyMeta[draft.currency].code})</label>
                      <input
                        id="expense-amount"
                        name="amountText"
                        inputmode="${draft.currency === "usd" ? "decimal" : "numeric"}"
                        value="${escapeAttr(draft.amountText)}"
                        required
                        ${busy}
                      />
                    </div>
                  </div>

                  <div class="split-fields">
                    <div class="field-grid">
                      <label for="expense-date">지출 일자</label>
                      <input id="expense-date" name="spentAt" type="date" value="${escapeAttr(draft.spentAt)}" required ${busy} />
                    </div>
                    <div class="field-grid">
                      <span class="form-section-title">반복 여부</span>
                      <label class="check-row">
                        <input type="checkbox" name="isRecurring" ${draft.isRecurring ? "checked" : ""} ${busy} />
                        <span>매달 반복</span>
                      </label>
                    </div>
                  </div>

                  ${
                    draft.isRecurring
                      ? `
                        <div class="split-fields">
                          <div class="field-grid">
                            <label for="recurrence-start">시작 월</label>
                            <input
                              id="recurrence-start"
                              name="recurrenceStartMonth"
                              type="month"
                              value="${escapeAttr(draft.recurrenceStartMonth)}"
                              required
                              ${busy}
                            />
                          </div>
                          <div class="field-grid">
                            <span class="form-section-title">종료 월</span>
                            <label class="check-row">
                              <input type="checkbox" name="hasEndMonth" ${draft.hasEndMonth ? "checked" : ""} ${busy} />
                              <span>종료 월 설정</span>
                            </label>
                            ${
                              draft.hasEndMonth
                                ? `
                                  <input
                                    name="recurrenceEndMonth"
                                    type="month"
                                    value="${escapeAttr(draft.recurrenceEndMonth)}"
                                    required
                                    ${busy}
                                  />
                                `
                                : ""
                            }
                          </div>
                        </div>
                        <div class="form-note">
                          반복 기간에서는 월만 저장되고, 선택한 날짜의 일자는 각 달에 그대로 materialize 됩니다.
                        </div>
                      `
                      : ""
                  }

                  ${
                    rateHelp
                      ? `<div class="${hasExchangeRate(exchangeRates, draft.currency) ? "form-note" : "form-warning"}">${escapeHtml(rateHelp)}</div>`
                      : ""
                  }
                  ${amountValidationText ? `<div class="form-warning">${escapeHtml(amountValidationText)}</div>` : ""}
                  ${
                    draft.isRecurring && draft.hasEndMonth && draft.recurrenceStartMonth > draft.recurrenceEndMonth
                      ? '<div class="form-warning">종료 월은 시작 월보다 빠를 수 없습니다.</div>'
                      : ""
                  }
                  ${
                    monthIssues.length > 0
                      ? `<div class="form-warning">${monthIssues.map(issueMessage).map(escapeHtml).join("<br />")}</div>`
                      : ""
                  }
                  ${
                    amountValue != null && draft.currency !== "krw" && hasExchangeRate(exchangeRates, draft.currency)
                      ? `<div class="form-note">KRW 환산: ${escapeHtml(
                          formatAmount(
                            amountInKRW(
                              {
                                amountMinorUnits: amountValue,
                                currency: draft.currency,
                              },
                              exchangeRates
                            ),
                            "krw"
                          )
                        )}</div>`
                      : ""
                  }

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
              modal.monthKey
                ? `<input type="hidden" name="monthKey" value="${escapeAttr(modal.monthKey)}" />`
                : ""
            }
            ${
              modal.sourceId != null
                ? `<input type="hidden" name="sourceId" value="${escapeAttr(modal.sourceId)}" />`
                : ""
            }
            ${
              modal.expenseId
                ? `<input type="hidden" name="expenseId" value="${escapeAttr(modal.expenseId)}" />`
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

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const editActions = new Set([
    "open-sources",
    "add-source",
    "edit-source",
    "delete-source",
    "open-add-month",
    "open-add-expense",
    "open-rates",
    "edit-expense",
    "delete-expense",
    "delete-month",
  ]);

  if (editActions.has(action) && !canEditSnapshot()) {
    state.errorMessage = lockedMutationMessage();
    render();
    return;
  }

  if (action === "open-settings") {
    openModal("settings");
  } else if (action === "select-expense-kind-filter") {
    const nextFilter = String(button.dataset.filterKind ?? "all");
    if (!isExpenseKindFilter(nextFilter)) {
      return;
    }
    state.selectedExpenseKindFilter = nextFilter;
    normalizeSelection();
    render();
  } else if (action === "open-sources") {
    openModal("sources");
  } else if (action === "add-source") {
    openModal("source-editor", {
      draft: {
        id: null,
        kind: "card",
        name: "",
      },
    });
  } else if (action === "edit-source") {
    const source = sourceById(state.snapshot, Number(button.dataset.sourceId));
    if (!source) {
      return;
    }
    openModal("source-editor", {
      draft: {
        id: source.id,
        kind: source.kind,
        name: source.name,
      },
    });
  } else if (action === "delete-source") {
    const source = sourceById(state.snapshot, Number(button.dataset.sourceId));
    if (!source) {
      return;
    }
    openModal("confirm-delete-source", {
      title: "카드/계좌를 삭제할까요?",
      message: `${source.name}에 연결된 지출 ${linkedExpenseCount(source.id)}개도 함께 삭제됩니다.`,
      confirmLabel: "삭제",
      destructive: true,
      sourceId: source.id,
    });
  } else if (action === "open-add-month") {
    openModal("month-editor", {
      draft: {
        month: toMonthInputValue(
          defaultMonthForCreation(months(), currentMonth() ?? yearMonthFromDate(new Date()))
        ),
      },
    });
  } else if (action === "open-add-expense") {
    openModal("expense-editor", {
      draft: defaultExpenseDraft(),
    });
  } else if (action === "open-rates") {
    openModal("rates");
  } else if (action === "select-month") {
    state.selectedMonthKey = button.dataset.monthKey ?? state.selectedMonthKey;
    normalizeSelection();
    render();
  } else if (action === "select-source") {
    const nextSourceId = Number(button.dataset.sourceId);
    state.selectedSourceId = state.selectedSourceId === nextSourceId ? null : nextSourceId;
    render();
  } else if (action === "edit-expense") {
    const expense = findExpense(button.dataset.expenseId);
    if (!expense) {
      return;
    }
    openModal("expense-editor", {
      draft: expenseDraftFromRecord(expense),
    });
  } else if (action === "delete-expense") {
    const expense = findExpense(button.dataset.expenseId);
    if (!expense) {
      return;
    }
    openModal("confirm-delete-expense", {
      title: "지출을 삭제할까요?",
      message: buildDeleteExpenseMessage(expense),
      confirmLabel: "삭제",
      destructive: true,
      expenseId: expense.id,
    });
  } else if (action === "delete-month") {
    const month = normalizeYearMonth(button.dataset.monthKey);
    const impact = monthDeletionImpact(state.snapshot, month);
    openModal("confirm-delete-month", {
      title: `${yearMonthTitle(month)} 페이지를 삭제할까요?`,
      message: buildDeleteMonthMessage(month, impact),
      confirmLabel: "삭제",
      destructive: true,
      monthKey: yearMonthKey(month),
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

    if (form.dataset.form === "source-editor") {
      await saveSource(form);
      return;
    }

    if (form.dataset.form === "month-editor") {
      await saveMonth(form);
      return;
    }

    if (form.dataset.form === "rates-editor") {
      await saveRates(form);
      return;
    }

    if (form.dataset.form === "expense-editor") {
      await saveExpense(form);
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

  if (form.dataset.form === "expense-editor") {
    state.modal = {
      type: "expense-editor",
      draft: readExpenseDraftFromForm(form),
    };
    render();
  } else if (form.dataset.form === "month-editor") {
    state.modal = {
      type: "month-editor",
      draft: {
        month: form.elements.month.value,
      },
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

async function saveSource(form) {
  assertEditableSnapshot();
  const formData = new FormData(form);
  const id = String(formData.get("id") ?? "").trim();
  const kind = String(formData.get("kind") ?? "card");
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    throw new Error("카드/계좌 이름을 입력하세요.");
  }

  const nextSource = {
    id: id ? Number(id) : nextFundingSourceId(state.snapshot),
    kind,
    name,
  };

  await commitSnapshot(upsertSource(state.snapshot, nextSource));
  openModal("sources");
}

async function saveMonth(form) {
  assertEditableSnapshot();
  const monthValue = String(new FormData(form).get("month") ?? "").trim();
  const month = parseDateInputToYearMonth(monthValue);
  const exists = months().some((entry) => yearMonthKey(entry) === yearMonthKey(month));

  if (exists) {
    throw new Error("이미 생성된 월입니다.");
  }

  await commitSnapshot(insertMonthPage(state.snapshot, month));
  closeModal();
}

async function saveRates(form) {
  assertEditableSnapshot();
  const formData = new FormData(form);
  const usdToKRWPer1 = Number.parseInt(String(formData.get("usdToKRWPer1") ?? "").replace(/,/g, ""), 10);
  const jpyToKRWPer100 = Number.parseInt(
    String(formData.get("jpyToKRWPer100") ?? "").replace(/,/g, ""),
    10
  );

  if (!(usdToKRWPer1 > 0) || !(jpyToKRWPer100 > 0)) {
    throw new Error("환율은 둘 다 0보다 큰 정수여야 합니다.");
  }

  await commitSnapshot(
    upsertExchangeRates(state.snapshot, {
      usdToKRWPer1,
      jpyToKRWPer100,
    })
  );
  closeModal();
}

async function saveExpense(form) {
  assertEditableSnapshot();
  const draft = readExpenseDraftFromForm(form);
  const sourceID = Number.parseInt(String(draft.sourceID), 10);
  const amountMinorUnits = parseMinorUnits(draft.amountText, draft.currency);

  if (!Number.isInteger(sourceID)) {
    throw new Error("카드/계좌를 선택하세요.");
  }

  if (!(amountMinorUnits > 0)) {
    throw new Error("올바른 금액을 입력하세요.");
  }

  if (draft.currency !== "krw" && !hasExchangeRate(state.snapshot.exchangeRates ?? emptyExchangeRates(), draft.currency)) {
    throw new Error("선택한 외화 통화를 저장하려면 먼저 환율을 설정하세요.");
  }

  if (draft.isRecurring && draft.hasEndMonth && draft.recurrenceStartMonth > draft.recurrenceEndMonth) {
    throw new Error("종료 월은 시작 월보다 빠를 수 없습니다.");
  }

  const expense = {
    id: draft.id || crypto.randomUUID(),
    sourceID,
    description: draft.description.trim() || null,
    amountMinorUnits,
    currency: draft.currency,
    spentAt: fromDateInputValue(draft.spentAt).toISOString(),
    recurrence: draft.isRecurring
      ? {
          startMonth: parseDateInputToYearMonth(draft.recurrenceStartMonth),
          endMonth: draft.hasEndMonth ? parseDateInputToYearMonth(draft.recurrenceEndMonth) : null,
        }
      : null,
  };

  await commitSnapshot(upsertExpense(state.snapshot, expense));
  closeModal();
}

async function performConfirm(form) {
  assertEditableSnapshot();
  const formData = new FormData(form);
  const confirmType = String(formData.get("confirmType"));

  if (confirmType === "confirm-delete-source") {
    await commitSnapshot(deleteSource(state.snapshot, Number(formData.get("sourceId"))));
    openModal("sources");
    return;
  }

  if (confirmType === "confirm-delete-expense") {
    await commitSnapshot(deleteExpense(state.snapshot, String(formData.get("expenseId"))));
    closeModal();
    return;
  }

  if (confirmType === "confirm-delete-month") {
    const result = deleteMonthPage(state.snapshot, normalizeYearMonth(String(formData.get("monthKey"))));
    await commitSnapshot(result.snapshot);
    closeModal();
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
    normalizeSelection();
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

function linkedExpenseCount(sourceID) {
  return state.snapshot.expenses.filter((expense) => expense.sourceID === sourceID).length;
}

function findExpense(expenseID) {
  return state.snapshot.expenses.find((expense) => expense.id === expenseID) ?? null;
}

function defaultExpenseDraft() {
  const selectedMonth = currentMonth() ?? months()[months().length - 1] ?? yearMonthFromDate(new Date());
  const selectedSourceId = state.selectedSourceId ?? state.snapshot.sources[0]?.id ?? "";
  const today = new Date();
  const todayMonthKey = yearMonthKey(yearMonthFromDate(today));
  const hasTodayMonthPage = state.snapshot.monthPages.some(
    (entry) => yearMonthKey(entry.yearMonth) === todayMonthKey
  );
  const baseDate = hasTodayMonthPage ? today : firstDateOfYearMonth(selectedMonth);

  return {
    id: "",
    sourceID: String(selectedSourceId),
    description: "",
    currency: "krw",
    amountText: "",
    spentAt: toDateInputValue(baseDate),
    isRecurring: false,
    recurrenceStartMonth: toMonthInputValue(selectedMonth),
    hasEndMonth: false,
    recurrenceEndMonth: toMonthInputValue(selectedMonth),
  };
}

function expenseDraftFromRecord(expense) {
  const spentAt = new Date(expense.spentAt);
  const recurrenceStart = expense.recurrence?.startMonth ?? yearMonthFromDate(spentAt);
  const recurrenceEnd = expense.recurrence?.endMonth ?? recurrenceStart;

  return {
    id: expense.id,
    sourceID: String(expense.sourceID),
    description: expense.description ?? "",
    currency: expense.currency,
    amountText: formatInputAmount(expense.amountMinorUnits, expense.currency),
    spentAt: toDateInputValue(spentAt),
    isRecurring: Boolean(expense.recurrence),
    recurrenceStartMonth: toMonthInputValue(recurrenceStart),
    hasEndMonth: Boolean(expense.recurrence?.endMonth),
    recurrenceEndMonth: toMonthInputValue(recurrenceEnd),
  };
}

function readExpenseDraftFromForm(form) {
  const formData = new FormData(form);
  const currentMonthValue =
    String(formData.get("recurrenceStartMonth") ?? "") ||
    toMonthInputValue(currentMonth() ?? yearMonthFromDate(new Date()));

  return {
    id: String(formData.get("id") ?? ""),
    sourceID: String(formData.get("sourceID") ?? ""),
    description: String(formData.get("description") ?? ""),
    currency: String(formData.get("currency") ?? "krw"),
    amountText: String(formData.get("amountText") ?? ""),
    spentAt: String(formData.get("spentAt") ?? toDateInputValue(new Date())),
    isRecurring: formData.get("isRecurring") != null,
    recurrenceStartMonth: currentMonthValue,
    hasEndMonth: formData.get("hasEndMonth") != null,
    recurrenceEndMonth:
      String(formData.get("recurrenceEndMonth") ?? "") || currentMonthValue,
  };
}

function buildExpenseValidationIssuesFromDraft(draft) {
  if (!draft.spentAt || !draft.sourceID) {
    return [];
  }

  const amountMinorUnits = parseMinorUnits(draft.amountText || "1", draft.currency) ?? 1;
  const expense = {
    id: draft.id || crypto.randomUUID(),
    sourceID: Number.parseInt(String(draft.sourceID), 10) || 0,
    description: draft.description,
    amountMinorUnits,
    currency: draft.currency,
    spentAt: fromDateInputValue(draft.spentAt).toISOString(),
    recurrence: draft.isRecurring
      ? {
          startMonth: parseDateInputToYearMonth(draft.recurrenceStartMonth),
          endMonth: draft.hasEndMonth ? parseDateInputToYearMonth(draft.recurrenceEndMonth) : null,
        }
      : null,
  };

  return validateExpenseMonths(
    expense,
    new Set(state.snapshot.monthPages.map((entry) => yearMonthKey(entry.yearMonth)))
  );
}

function buildAmountValidationText(amountText, currency) {
  const trimmed = String(amountText ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (parseMinorUnits(trimmed, currency) != null) {
    return null;
  }

  if (currency === "usd") {
    return "USD 금액은 소수 둘째 자리까지 입력하세요. 예: 12.34";
  }

  return `${currencyMeta[currency].code} 금액은 숫자만 입력하세요.`;
}

function buildRateHelpText(currency, exchangeRates) {
  if (currency === "krw") {
    return null;
  }

  if (currency === "usd") {
    const rate = exchangeRates.usdToKRWPer1;
    if (!(rate > 0)) {
      return "USD 지출을 저장하려면 먼저 환율 설정에서 1 USD 기준 KRW 값을 입력하세요.";
    }
    return `현재 환율: 1 USD = ${formatAmount(rate, "krw")}`;
  }

  const rate = exchangeRates.jpyToKRWPer100;
  if (!(rate > 0)) {
    return "JPY 지출을 저장하려면 먼저 환율 설정에서 100 JPY 기준 KRW 값을 입력하세요.";
  }
  return `현재 환율: 100 JPY = ${formatAmount(rate, "krw")}`;
}

function buildDeleteExpenseMessage(expense) {
  const month = currentMonth();
  const displayDate = month ? materializedDisplayDate(expense, month) : new Date(expense.spentAt);
  const dateText = formatDateLabel(displayDate ?? expense.spentAt);
  const amountText = formatAmount(expense.amountMinorUnits, expense.currency);
  const krwText = formattedKRWEquivalent(expense, state.snapshot.exchangeRates ?? emptyExchangeRates());

  if (expense.description) {
    return krwText
      ? `${dateText} 지출 "${expense.description}" (${amountText}, 약 ${krwText}) 항목을 삭제합니다.`
      : `${dateText} 지출 "${expense.description}" (${amountText}) 항목을 삭제합니다.`;
  }

  return krwText
    ? `${dateText} 지출 ${amountText} (약 ${krwText}) 항목을 삭제합니다.`
    : `${dateText} 지출 ${amountText} 항목을 삭제합니다.`;
}

function buildDeleteMonthMessage(month, impact) {
  const lines = [`${yearMonthTitle(month)} 페이지를 삭제합니다.`];

  if (impact.deletedOneOffExpenseCount > 0) {
    lines.push(`일회성 지출 ${impact.deletedOneOffExpenseCount}개를 삭제합니다.`);
  }

  if (impact.deletedRecurringExpenseCount > 0) {
    lines.push(`반복 지출 ${impact.deletedRecurringExpenseCount}개를 완전히 삭제합니다.`);
  }

  if (impact.shiftedRecurringStartCount > 0) {
    lines.push(`반복 지출 ${impact.shiftedRecurringStartCount}개의 시작 월을 다음 생성 월로 옮깁니다.`);
  }

  if (impact.shiftedRecurringEndCount > 0) {
    lines.push(`반복 지출 ${impact.shiftedRecurringEndCount}개의 종료 월을 이전 생성 월로 조정합니다.`);
  }

  lines.push("이 작업은 되돌릴 수 없습니다.");
  return lines.join("\n");
}

function createLedgerIllustration() {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const context = canvas.getContext("2d");

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#f0fdfa");
  gradient.addColorStop(0.55, "#eff6ff");
  gradient.addColorStop(1, "#fff7ed");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  drawRoundedRect(context, 78, 82, 804, 376, 24, "#ffffff", "#d6e3ea", 2);
  drawRoundedRect(context, 124, 128, 248, 284, 18, "#0f172a", "#0f172a", 0);
  drawRoundedRect(context, 410, 128, 426, 78, 16, "#f8fafc", "#d6e3ea", 2);
  drawRoundedRect(context, 410, 226, 426, 88, 16, "#f8fafc", "#d6e3ea", 2);
  drawRoundedRect(context, 410, 334, 426, 78, 16, "#f8fafc", "#d6e3ea", 2);

  context.fillStyle = "#e2e8f0";
  context.fillRect(164, 164, 168, 22);
  context.fillRect(164, 206, 132, 16);
  context.fillStyle = "#0d9488";
  context.fillRect(164, 252, 108, 84);
  context.fillStyle = "#ea580c";
  context.fillRect(290, 232, 42, 104);
  context.fillStyle = "#14b8a6";
  context.fillRect(164, 356, 168, 18);

  const cardColors = ["#0d9488", "#ea580c", "#15803d"];
  [438, 546, 654].forEach((x, index) => {
    drawRoundedRect(context, x, 248, 74, 42, 10, cardColors[index], cardColors[index], 0);
  });

  context.fillStyle = "#334155";
  context.font = "600 30px Inter, sans-serif";
  context.fillText("2026년 4월", 438, 174);
  context.fillStyle = "#0f172a";
  context.font = "700 34px Inter, sans-serif";
  context.fillText("₩1,284,000", 438, 286);
  context.fillText("₩93,000", 438, 392);
  context.fillStyle = "#64748b";
  context.font = "500 20px Inter, sans-serif";
  context.fillText("총 지출", 720, 174);
  context.fillText("선택 source", 720, 286);
  context.fillText("자동 저장 활성", 690, 392);

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
