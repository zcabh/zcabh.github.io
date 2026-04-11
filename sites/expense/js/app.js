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
import { decryptToken, encryptToken } from "./crypto.js";
import { fetchSnapshot, pushSnapshot } from "./github.js";
import {
  clearTokenEnvelope,
  loadPersistedState,
  persistSettings,
  persistSnapshot,
  persistTokenEnvelope,
} from "./storage.js";

const root = document.querySelector("#app");

const state = {
  snapshot: emptySnapshot(),
  settings: defaultSettings(),
  tokenEnvelope: null,
  sessionToken: null,
  isDirty: false,
  isBootstrapping: false,
  isSyncing: false,
  errorMessage: "",
  selectedMonthKey: null,
  selectedSourceId: null,
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
    state.tokenEnvelope = persisted.tokenEnvelope ?? null;

    if (persisted.snapshot) {
      state.snapshot = normalizeSnapshot(persisted.snapshot);
    }
  } catch (error) {
    console.error(error);
    state.errorMessage = "저장된 로컬 데이터를 읽지 못했습니다. 빈 상태로 시작합니다.";
    state.snapshot = emptySnapshot();
    state.settings = defaultSettings();
    state.tokenEnvelope = null;
  }

  normalizeSelection();
  render();

  if (hasStoredConnection() && !state.sessionToken) {
    openModal("unlock");
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
  return isGitHubConfigValid(state.settings.gitHubConfig) && Boolean(state.tokenEnvelope);
}

function requiresOnboarding() {
  return !isGitHubConfigValid(state.settings.gitHubConfig) || !state.tokenEnvelope;
}

function currentMonth() {
  return months().find((month) => yearMonthKey(month) === state.selectedMonthKey) ?? null;
}

function months() {
  return state.snapshot.monthPages.map((entry) => entry.yearMonth).sort(compareYearMonths);
}

function currentTotals() {
  const month = currentMonth();
  return month ? totalsForMonth(month, state.snapshot) : [];
}

function currentOccurrences() {
  const month = currentMonth();
  if (!month || state.selectedSourceId == null) {
    return [];
  }
  return occurrencesForMonth(month, state.selectedSourceId, state.snapshot);
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
      state.sessionToken &&
      !state.isBootstrapping &&
      !state.isSyncing
  );
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
            <div class="muted">토큰은 브라우저에 암호화 저장되고, 다시 방문하면 passphrase로 잠금 해제합니다.</div>
          </div>
        </div>
        <div class="onboarding-form-wrap">
          <form class="form-grid" data-form="settings-onboarding">
            ${renderSettingsFields(config, {
              tokenValue: "",
              passphraseValue: "",
              showTokenFields,
              showCloseButton: false,
              isOnboarding: true,
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
  const totalAmount = month ? totalAmountForMonth(month, state.snapshot) : 0;

  return `
    <div class="app-frame">
      <div class="topbar">
        <div class="brand-block">
          <h1 class="brand-title">Track Your Expense Web</h1>
          <p class="brand-copy">
            로컬 편집은 즉시 반영되고, 원격 반영은 사용자가 명시적으로 Sync할 때만 일어납니다.
            앱이 다시 열리면 remote snapshot이 로컬 상태를 교체합니다.
          </p>
        </div>
        <div class="header-actions">
          <button class="button-ghost" type="button" data-action="open-settings">GitHub 설정</button>
          ${
            state.sessionToken
              ? '<button class="button-ghost" type="button" data-action="lock-session">잠금</button>'
              : '<button class="button-primary" type="button" data-action="open-unlock">잠금 해제</button>'
          }
        </div>
      </div>

      ${renderStatusBar()}

      <div class="toolbar">
        <button class="button-ghost" type="button" data-action="open-sources">카드/계좌</button>
        <button class="button-ghost" type="button" data-action="open-rates">환율 설정</button>
        <button
          class="button-ghost"
          type="button"
          data-action="open-add-expense"
          ${months().length === 0 || state.snapshot.sources.length === 0 ? "disabled" : ""}
        >
          지출 추가
        </button>
        <button class="button-ghost" type="button" data-action="open-add-month">월 추가</button>
        <button
          class="button-ghost"
          type="button"
          data-action="open-pull-confirm"
          ${canRunRemoteAction() ? "" : "disabled"}
        >
          다시 불러오기
        </button>
        <button
          class="button-primary"
          type="button"
          data-action="open-sync-confirm"
          ${canRunRemoteAction() ? "" : "disabled"}
        >
          Sync
        </button>
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
                  <button class="button-ghost" type="button" data-action="open-add-month">추가</button>
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
                  <div class="summary-block">
                    <div class="form-section-title">${yearMonthTitle(month)}</div>
                    <p class="summary-amount">${formatAmount(totalAmount, "krw")}</p>
                    <div class="muted">월 bar는 source별 월 합계를 기준으로 계산합니다.</div>
                  </div>
                  <button
                    class="button-danger"
                    type="button"
                    data-action="delete-month"
                    data-month-key="${yearMonthKey(month)}"
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
                            <p class="muted">이 월에는 입력된 지출이 아직 없습니다.</p>
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
                      ${source ? escapeHtml(source.name) : "상세 지출 선택"}
                    </div>
                    <div class="muted">
                      ${
                        source
                          ? `${yearMonthTitle(month)}의 지출을 최신순으로 표시합니다.`
                          : `${yearMonthTitle(month)}에서 source를 선택하면 상세 지출이 열립니다.`
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
                        >
                          이 source에 지출 추가
                        </button>
                      `
                      : ""
                  }
                </div>
                <div class="panel-body">
                  ${
                    !source
                      ? `
                        <section class="empty-state">
                          <div class="empty-state-copy">
                            <h2 class="modal-title">상세 지출 선택</h2>
                            <p class="muted">카드 또는 계좌 카드를 탭하면 해당 월의 지출이 열립니다.</p>
                          </div>
                        </section>
                      `
                      : occurrences.length === 0
                        ? `
                          <section class="empty-state">
                            <div class="empty-state-copy">
                              <h2 class="modal-title">해당 source의 지출이 없습니다</h2>
                              <p class="muted">선택한 월과 source 조합에는 표시할 항목이 아직 없습니다.</p>
                            </div>
                          </section>
                        `
                        : `
                          <div class="expense-list">
                            ${occurrences
                              .map(
                                (entry) => `
                                  <article class="expense-row">
                                    <div class="expense-main">
                                      <div class="stack">
                                        <div class="expense-title">${
                                          escapeHtml(entry.expense.description ?? "설명 없음")
                                        }</div>
                                        <div class="expense-meta">
                                          <span>${formatDateLabel(entry.displayDate)}</span>
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
                                      >
                                        수정
                                      </button>
                                      <button
                                        class="button-danger"
                                        type="button"
                                        data-action="delete-expense"
                                        data-expense-id="${entry.expense.id}"
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

function renderStatusBar() {
  const locked = isGitHubConfigValid(state.settings.gitHubConfig) && !state.sessionToken;

  return `
    <section class="status-bar">
      <div class="status-main">
        <div class="status-summary">${escapeHtml(statusSummary())}</div>
        <div class="status-badges">
          ${state.isDirty ? '<span class="badge badge-warning">로컬 변경 있음</span>' : ""}
          ${state.sessionToken ? '<span class="badge badge-success">토큰 잠금 해제됨</span>' : ""}
          ${locked ? '<span class="badge">잠금 해제 필요</span>' : ""}
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
        <button class="button-primary" type="button" data-action="open-add-month">월 추가</button>
        <button class="button-ghost" type="button" data-action="open-sources">카드/계좌 관리</button>
      </div>
    </section>
  `;
}

function renderModal() {
  if (!state.modal) {
    return "";
  }

  if (state.modal.type === "unlock") {
    return renderUnlockModal();
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

function renderUnlockModal() {
  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">토큰 잠금 해제</h2>
            <p class="modal-copy">
              저장된 GitHub 토큰은 브라우저에 암호화되어 있습니다. passphrase를 입력하면 자동으로 최신 remote snapshot을 다시 불러옵니다.
            </p>
          </div>
          ${
            months().length > 0
              ? '<button class="button-subtle" type="button" data-action="close-modal">닫기</button>'
              : ""
          }
        </div>
        <div class="modal-body">
          <form class="form-grid" data-form="unlock">
            <div class="field-grid">
              <label for="unlock-passphrase">Passphrase</label>
              <input id="unlock-passphrase" name="passphrase" type="password" autocomplete="current-password" required />
              <small class="form-note">브라우저를 닫으면 다시 잠금 해제해야 합니다.</small>
            </div>
            <div class="form-actions">
              ${
                months().length > 0
                  ? '<button class="button-ghost" type="button" data-action="close-modal">취소</button>'
                  : ""
              }
              <button class="button-primary" type="submit">잠금 해제</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderSettingsModal() {
  const config = mergeSettings(state.settings).gitHubConfig;

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
          <button class="button-subtle" type="button" data-action="close-modal">닫기</button>
        </div>
        <div class="modal-body">
          <form class="form-grid" data-form="settings-modal">
            ${renderSettingsFields(config, {
              tokenValue: "",
              passphraseValue: "",
              showTokenFields: true,
              showCloseButton: true,
              isOnboarding: false,
            })}
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderSettingsFields(config, options) {
  return `
    <div class="form-grid">
      <div class="split-fields">
        <div class="field-grid">
          <label for="github-owner">Owner</label>
          <input id="github-owner" name="owner" value="${escapeAttr(config.owner)}" autocomplete="off" required />
        </div>
        <div class="field-grid">
          <label for="github-repo">Repository</label>
          <input id="github-repo" name="repo" value="${escapeAttr(config.repo)}" autocomplete="off" required />
        </div>
      </div>

      <div class="split-fields">
        <div class="field-grid">
          <label for="github-branch">Branch</label>
          <input id="github-branch" name="branch" value="${escapeAttr(config.branch)}" autocomplete="off" required />
        </div>
        <div class="field-grid">
          <label for="github-path">File Path</label>
          <input id="github-path" name="filePath" value="${escapeAttr(config.filePath)}" autocomplete="off" required />
        </div>
      </div>

      ${
        options.showTokenFields
          ? `
            <div class="field-grid">
              <label for="github-token">${
                state.tokenEnvelope && !options.isOnboarding
                  ? "새 GitHub Personal Access Token 또는 비워두기"
                  : "GitHub Personal Access Token"
              }</label>
              <input
                id="github-token"
                name="token"
                type="password"
                value="${escapeAttr(options.tokenValue)}"
                autocomplete="new-password"
                ${options.isOnboarding && !state.tokenEnvelope ? "required" : ""}
              />
              <small class="form-note">
                private repo 1개만 선택하고 <strong>Contents: Read and write</strong> 권한만 주는 fine-grained PAT를 권장합니다.
              </small>
            </div>
            <div class="field-grid">
              <label for="github-passphrase">${
                state.tokenEnvelope && !options.isOnboarding ? "새 토큰을 저장할 때 사용할 passphrase" : "로컬 passphrase"
              }</label>
              <input
                id="github-passphrase"
                name="passphrase"
                type="password"
                value="${escapeAttr(options.passphraseValue)}"
                autocomplete="new-password"
              />
              <small class="form-note">
                토큰을 브라우저에 암호화 저장할 때만 사용합니다. 서버로 전송되지 않습니다.
              </small>
            </div>
          `
          : ""
      }

      <div class="field-grid">
        <div class="form-section-title">동작 방식</div>
        <div class="readout muted">
          앱 시작 시 GitHub JSON을 다시 읽어 로컬 상태를 교체합니다. 원격 반영은 사용자가 Sync 버튼을 눌렀을 때만 수행합니다.
        </div>
      </div>

      <div class="form-actions">
        ${
          options.showCloseButton
            ? '<button class="button-ghost" type="button" data-action="close-modal">취소</button>'
            : ""
        }
        <button class="button-primary" type="submit">저장</button>
      </div>
    </div>
  `;
}

function renderSourcesModal() {
  const sources = state.snapshot.sources.slice().sort((left, right) => left.id - right.id);

  return `
    <div class="modal-backdrop">
      <section class="modal wide">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">카드/계좌 관리</h2>
            <p class="modal-copy">source 삭제 시 연결된 모든 지출도 함께 삭제됩니다.</p>
          </div>
          <div class="header-actions">
            <button class="button-ghost" type="button" data-action="add-source">추가</button>
            <button class="button-subtle" type="button" data-action="close-modal">닫기</button>
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
                              >
                                수정
                              </button>
                              <button
                                class="button-danger"
                                type="button"
                                data-action="delete-source"
                                data-source-id="${source.id}"
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

  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">${isEditing ? "카드/계좌 수정" : "카드/계좌 추가"}</h2>
            <p class="modal-copy">정렬 순서는 항상 source ID 오름차순입니다.</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal">닫기</button>
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
              <input id="source-name" name="name" value="${escapeAttr(draft.name)}" required />
            </div>
            <div class="form-actions">
              <button class="button-ghost" type="button" data-action="close-modal">취소</button>
              <button class="button-primary" type="submit">저장</button>
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

  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">월 추가</h2>
            <p class="modal-copy">월 페이지는 자동 생성되지 않고 사용자가 명시적으로 생성합니다.</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal">닫기</button>
        </div>
        <div class="modal-body">
          <form class="form-grid" data-form="month-editor">
            <div class="field-grid">
              <label for="month-value">월</label>
              <input id="month-value" name="month" type="month" value="${escapeAttr(draft.month)}" required />
              <small class="form-note">저장 시 ${escapeHtml(yearMonthTitle(parseDateInputToYearMonth(draft.month)))} 페이지가 생성됩니다.</small>
            </div>
            <div class="form-actions">
              <button class="button-ghost" type="button" data-action="close-modal">취소</button>
              <button class="button-primary" type="submit">저장</button>
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

  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">환율 설정</h2>
            <p class="modal-copy">저장한 환율은 sync 대상에 포함되고, 월별 KRW 합계 계산에 즉시 반영됩니다.</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal">닫기</button>
        </div>
        <div class="modal-body">
          <form class="form-grid" data-form="rates-editor">
            <div class="split-fields">
              <div class="field-grid">
                <label for="usd-rate">1 USD</label>
                <input id="usd-rate" name="usdToKRWPer1" inputmode="numeric" value="${escapeAttr(draft.usdToKRWPer1)}" required />
              </div>
              <div class="field-grid">
                <label for="jpy-rate">100 JPY</label>
                <input id="jpy-rate" name="jpyToKRWPer100" inputmode="numeric" value="${escapeAttr(draft.jpyToKRWPer100)}" required />
              </div>
            </div>
            <div class="form-actions">
              <button class="button-ghost" type="button" data-action="close-modal">취소</button>
              <button class="button-primary" type="submit">저장</button>
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

  return `
    <div class="modal-backdrop">
      <section class="modal wide">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">${draft.id ? "지출 수정" : "지출 추가"}</h2>
            <p class="modal-copy">반복 지출 수정은 특정 월 예외가 아니라 전체 규칙 수정입니다.</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal">닫기</button>
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
                      <select id="expense-source" name="sourceID">
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
                      <input id="expense-description" name="description" value="${escapeAttr(draft.description)}" />
                    </div>
                  </div>

                  <div class="split-fields">
                    <div class="field-grid">
                      <label for="expense-currency">통화</label>
                      <select id="expense-currency" name="currency">
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
                      />
                    </div>
                  </div>

                  <div class="split-fields">
                    <div class="field-grid">
                      <label for="expense-date">지출 일자</label>
                      <input id="expense-date" name="spentAt" type="date" value="${escapeAttr(draft.spentAt)}" required />
                    </div>
                    <div class="field-grid">
                      <span class="form-section-title">반복 여부</span>
                      <label class="check-row">
                        <input type="checkbox" name="isRecurring" ${draft.isRecurring ? "checked" : ""} />
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
                            />
                          </div>
                          <div class="field-grid">
                            <span class="form-section-title">종료 월</span>
                            <label class="check-row">
                              <input type="checkbox" name="hasEndMonth" ${draft.hasEndMonth ? "checked" : ""} />
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
                    <button class="button-ghost" type="button" data-action="close-modal">취소</button>
                    <button class="button-primary" type="submit">저장</button>
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
  const destructive = modal.type === "confirm-pull" && state.isDirty;

  return `
    <div class="modal-backdrop">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2 class="modal-title">${escapeHtml(modal.title)}</h2>
            <p class="modal-copy confirm-copy">${escapeHtml(modal.message)}</p>
          </div>
          <button class="button-subtle" type="button" data-action="close-modal">닫기</button>
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
              <button class="button-ghost" type="button" data-action="close-modal">취소</button>
              <button class="${destructive || modal.destructive ? "button-danger" : "button-primary"}" type="submit">
                ${escapeHtml(modal.confirmLabel)}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function statusSummary() {
  if (state.isSyncing) {
    return "GitHub에 동기화하는 중";
  }

  if (state.isBootstrapping) {
    return "GitHub에서 최신 데이터를 불러오는 중";
  }

  if (!isGitHubConfigValid(state.settings.gitHubConfig)) {
    return "GitHub 연결을 설정하세요.";
  }

  if (!state.sessionToken) {
    return "저장된 GitHub 토큰 잠금 해제가 필요합니다.";
  }

  if (state.isDirty) {
    return "로컬 변경 사항이 아직 동기화되지 않았습니다.";
  }

  if (state.settings.lastSyncedAt) {
    return `마지막 동기화: ${formatDateTimeLabel(state.settings.lastSyncedAt)}`;
  }

  if (state.settings.lastFetchedAt) {
    return `마지막 불러오기: ${formatDateTimeLabel(state.settings.lastFetchedAt)}`;
  }

  return "GitHub 연결이 준비되었습니다.";
}

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;

  if (action === "open-settings") {
    openModal("settings");
  } else if (action === "open-unlock") {
    openModal("unlock");
  } else if (action === "lock-session") {
    state.sessionToken = null;
    openModal("unlock");
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
  } else if (action === "open-pull-confirm") {
    openModal("confirm-pull", {
      title: "GitHub에서 다시 불러올까요?",
      message: state.isDirty
        ? "GitHub의 최신 데이터를 불러와 로컬 데이터를 교체합니다.\n아직 Sync하지 않은 로컬 변경 사항은 사라집니다."
        : "GitHub의 최신 데이터를 불러와 로컬 데이터를 교체합니다.",
      confirmLabel: "다시 불러오기",
      destructive: state.isDirty,
    });
  } else if (action === "open-sync-confirm") {
    openModal("confirm-sync", {
      title: "GitHub에 Sync할까요?",
      message: "현재 로컬 전체 상태를 GitHub JSON 파일 하나로 업로드합니다.",
      confirmLabel: "Sync",
      destructive: false,
    });
  } else if (action === "select-month") {
    state.selectedMonthKey = button.dataset.monthKey ?? state.selectedMonthKey;
    normalizeSelection();
    render();
  } else if (action === "select-source") {
    state.selectedSourceId = Number(button.dataset.sourceId);
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

    if (form.dataset.form === "unlock") {
      await unlockSession(form);
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
  if (event.key === "Escape" && state.modal) {
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
  const token = String(formData.get("token") ?? "").trim();
  const passphrase = String(formData.get("passphrase") ?? "").trim();

  if (!isGitHubConfigValid(gitHubConfig)) {
    throw new Error("GitHub 저장소 설정을 모두 입력하세요.");
  }

  if (!state.tokenEnvelope && !token) {
    throw new Error("GitHub token을 입력하세요.");
  }

  if (token && !passphrase) {
    throw new Error("새 토큰을 암호화 저장하려면 passphrase가 필요합니다.");
  }

  state.settings = {
    ...state.settings,
    gitHubConfig,
  };

  if (token) {
    state.tokenEnvelope = await encryptToken(token, passphrase);
    await persistTokenEnvelope(state.tokenEnvelope);
    state.sessionToken = token;
  }

  await persistSettings(state.settings);
  normalizeSelection();

  if (closeOnSuccess) {
    closeModal(false);
  }

  render();

  if (state.sessionToken) {
    await bootstrapFromRemote();
  } else if (state.tokenEnvelope) {
    openModal("unlock");
  }
}

async function unlockSession(form) {
  if (!state.tokenEnvelope) {
    throw new Error("저장된 토큰이 없습니다. GitHub 설정에서 먼저 token을 저장하세요.");
  }

  const passphrase = String(new FormData(form).get("passphrase") ?? "").trim();
  if (!passphrase) {
    throw new Error("passphrase를 입력하세요.");
  }

  state.sessionToken = await decryptToken(state.tokenEnvelope, passphrase);
  closeModal(false);
  render();
  await bootstrapFromRemote();
}

async function saveSource(form) {
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
  const formData = new FormData(form);
  const confirmType = String(formData.get("confirmType"));

  if (confirmType === "confirm-pull") {
    closeModal(false);
    render();
    await bootstrapFromRemote();
    return;
  }

  if (confirmType === "confirm-sync") {
    closeModal(false);
    render();
    await syncToRemote();
    return;
  }

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
    const envelope = await fetchSnapshot(state.settings.gitHubConfig, state.sessionToken);
    state.snapshot = envelope.snapshot;
    state.settings.remoteSHA = envelope.sha;
    state.settings.lastFetchedAt = new Date().toISOString();
    state.isDirty = false;
    await persistSnapshot(state.snapshot);
    await persistSettings(state.settings);
    normalizeSelection();
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : "GitHub에서 데이터를 불러오지 못했습니다.";
  } finally {
    state.isBootstrapping = false;
    render();
  }
}

async function syncToRemote() {
  if (!canRunRemoteAction()) {
    return;
  }

  state.isSyncing = true;
  clearError();
  render();

  try {
    const nextSHA = await pushSnapshot(
      state.settings.gitHubConfig,
      state.sessionToken,
      state.snapshot,
      state.settings.remoteSHA
    );
    state.settings.remoteSHA = nextSHA;
    state.settings.lastSyncedAt = new Date().toISOString();
    state.isDirty = false;
    await persistSettings(state.settings);
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : "GitHub에 동기화하지 못했습니다.";
  } finally {
    state.isSyncing = false;
    render();
  }
}

async function commitSnapshot(nextSnapshot) {
  state.snapshot = normalizeSnapshot(nextSnapshot);
  state.isDirty = true;
  await persistSnapshot(state.snapshot);
  normalizeSelection();
  render();
}

function openModal(type, payload = {}) {
  if (type === "confirm-pull" || type === "confirm-sync" || type === "confirm-delete-source" || type === "confirm-delete-expense" || type === "confirm-delete-month") {
    state.modal = { type, ...payload };
  } else {
    state.modal = { type, ...payload };
  }
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
  const baseDate = firstDateOfYearMonth(selectedMonth);

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
  context.fillText("마지막 Sync 준비", 670, 392);

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
