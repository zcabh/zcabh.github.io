const SOURCE_KINDS = new Set(["card", "account"]);
const CURRENCIES = new Set(["krw", "usd", "jpy"]);

export const sourceKindMeta = {
  card: { title: "카드" },
  account: { title: "계좌" },
};

export const currencyMeta = {
  krw: {
    code: "KRW",
    title: "원화",
    fractionDigits: 0,
    minorUnitsPerMajorUnit: 1,
    prefix: "₩",
  },
  usd: {
    code: "USD",
    title: "미국 달러",
    fractionDigits: 2,
    minorUnitsPerMajorUnit: 100,
    prefix: "$",
  },
  jpy: {
    code: "JPY",
    title: "일본 엔",
    fractionDigits: 0,
    minorUnitsPerMajorUnit: 1,
    prefix: "¥",
  },
};

export function emptyExchangeRates() {
  return {
    usdToKRWPer1: null,
    jpyToKRWPer100: null,
  };
}

export function emptySnapshot() {
  return {
    version: 3,
    sources: [],
    monthPages: [],
    expenses: [],
    exchangeRates: null,
  };
}

export function cloneSnapshot(snapshot) {
  return typeof structuredClone === "function"
    ? structuredClone(snapshot)
    : JSON.parse(JSON.stringify(snapshot));
}

export function trimmedGitHubConfig(config) {
  return {
    owner: String(config?.owner ?? "").trim(),
    repo: String(config?.repo ?? "").trim(),
    branch: String(config?.branch ?? "").trim(),
    filePath: String(config?.filePath ?? "").trim(),
  };
}

export function isGitHubConfigValid(config) {
  const value = trimmedGitHubConfig(config);
  return Boolean(value.owner && value.repo && value.branch && value.filePath);
}

export function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("원격 데이터 형식이 올바르지 않습니다.");
  }

  if (!Number.isInteger(snapshot.version)) {
    throw new Error("원격 데이터 버전을 해석하지 못했습니다.");
  }

  const sources = asArray(snapshot.sources, "sources").map(normalizeSource);
  const monthPages = asArray(snapshot.monthPages, "monthPages").map(normalizeMonthPage);
  const expenses = asArray(snapshot.expenses, "expenses").map(normalizeExpense);
  const exchangeRates = snapshot.exchangeRates == null
    ? null
    : normalizeExchangeRates(snapshot.exchangeRates);

  return {
    version: snapshot.version,
    sources: sources.sort((left, right) => left.id - right.id),
    monthPages: monthPages.sort((left, right) =>
      compareYearMonths(left.yearMonth, right.yearMonth)
    ),
    expenses: expenses.sort(compareExpensesForStorage),
    exchangeRates,
  };
}

export function encodeSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  return JSON.stringify(normalized, null, 2);
}

export function compareExpensesForStorage(left, right) {
  const timeDelta = new Date(right.spentAt).getTime() - new Date(left.spentAt).getTime();
  if (timeDelta !== 0) {
    return timeDelta;
  }
  return String(left.id).localeCompare(String(right.id));
}

export function nextFundingSourceId(snapshot) {
  return snapshot.sources.reduce((maxID, source) => Math.max(maxID, source.id), 0) + 1;
}

export function sourceById(snapshot, sourceID) {
  return snapshot.sources.find((source) => source.id === sourceID) ?? null;
}

export function insertMonthPage(snapshot, month) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const normalizedMonth = normalizeYearMonth(month);
  if (!nextSnapshot.monthPages.some((entry) => yearMonthKey(entry.yearMonth) === yearMonthKey(normalizedMonth))) {
    nextSnapshot.monthPages.push({ yearMonth: normalizedMonth });
    nextSnapshot.monthPages.sort((left, right) =>
      compareYearMonths(left.yearMonth, right.yearMonth)
    );
  }
  return nextSnapshot;
}

export function upsertSource(snapshot, record) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const normalizedRecord = normalizeSource(record);
  const existingIndex = nextSnapshot.sources.findIndex((source) => source.id === normalizedRecord.id);

  if (existingIndex >= 0) {
    nextSnapshot.sources[existingIndex] = normalizedRecord;
  } else {
    nextSnapshot.sources.push(normalizedRecord);
  }

  nextSnapshot.sources.sort((left, right) => left.id - right.id);
  return nextSnapshot;
}

export function deleteSource(snapshot, sourceID) {
  const nextSnapshot = cloneSnapshot(snapshot);
  nextSnapshot.sources = nextSnapshot.sources.filter((source) => source.id !== sourceID);
  nextSnapshot.expenses = nextSnapshot.expenses.filter((expense) => expense.sourceID !== sourceID);
  return nextSnapshot;
}

export function upsertExchangeRates(snapshot, exchangeRates) {
  const nextSnapshot = cloneSnapshot(snapshot);
  nextSnapshot.exchangeRates = normalizeExchangeRates(exchangeRates);
  return nextSnapshot;
}

export function deleteExpense(snapshot, expenseID) {
  const nextSnapshot = cloneSnapshot(snapshot);
  nextSnapshot.expenses = nextSnapshot.expenses.filter((expense) => expense.id !== expenseID);
  return nextSnapshot;
}

export function upsertExpense(snapshot, expense) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const normalizedExpense = normalizeExpense(expense);
  const issues = validateExpenseMonths(
    normalizedExpense,
    new Set(nextSnapshot.monthPages.map((entry) => yearMonthKey(entry.yearMonth)))
  );

  if (issues.length > 0) {
    const message = issues.map(issueMessage).join("\n");
    throw new Error(message);
  }

  const existingIndex = nextSnapshot.expenses.findIndex((entry) => entry.id === normalizedExpense.id);

  if (existingIndex >= 0) {
    nextSnapshot.expenses[existingIndex] = normalizedExpense;
  } else {
    nextSnapshot.expenses.push(normalizedExpense);
  }

  nextSnapshot.expenses.sort(compareExpensesForStorage);
  return nextSnapshot;
}

export function deleteMonthPage(snapshot, month) {
  const normalizedMonth = normalizeYearMonth(month);
  const plan = makeMonthDeletionPlan(snapshot, normalizedMonth);
  const nextSnapshot = cloneSnapshot(snapshot);
  const deletedMonthKey = yearMonthKey(normalizedMonth);

  nextSnapshot.monthPages = nextSnapshot.monthPages.filter(
    (entry) => yearMonthKey(entry.yearMonth) !== deletedMonthKey
  );

  const expenseIDsToDelete = new Set([
    ...plan.oneOffExpenseIDsToDelete,
    ...plan.recurringExpenseIDsToDelete,
  ]);

  nextSnapshot.expenses = nextSnapshot.expenses
    .filter((expense) => !expenseIDsToDelete.has(expense.id))
    .map((expense) => {
      const updated = plan.recurringExpenseUpdates.find((entry) => entry.id === expense.id);
      if (!updated) {
        return expense;
      }
      return {
        ...expense,
        recurrence: updated.recurrence,
      };
    })
    .sort(compareExpensesForStorage);

  return {
    snapshot: nextSnapshot,
    impact: plan.impact,
  };
}

export function monthDeletionImpact(snapshot, month) {
  return makeMonthDeletionPlan(snapshot, normalizeYearMonth(month)).impact;
}

function makeMonthDeletionPlan(snapshot, month) {
  const targetKey = yearMonthKey(month);
  const monthExists = snapshot.monthPages.some((entry) => yearMonthKey(entry.yearMonth) === targetKey);

  if (!monthExists) {
    return {
      oneOffExpenseIDsToDelete: [],
      recurringExpenseIDsToDelete: [],
      recurringExpenseUpdates: [],
      impact: emptyMonthDeletionImpact(),
    };
  }

  const remainingMonths = snapshot.monthPages
    .map((entry) => entry.yearMonth)
    .filter((entry) => yearMonthKey(entry) !== targetKey)
    .sort(compareYearMonths);

  const plan = {
    oneOffExpenseIDsToDelete: [],
    recurringExpenseIDsToDelete: [],
    recurringExpenseUpdates: [],
    impact: emptyMonthDeletionImpact(),
  };

  for (const expense of snapshot.expenses) {
    if (!expense.recurrence) {
      if (yearMonthKey(yearMonthFromDate(expense.spentAt)) === targetKey) {
        plan.oneOffExpenseIDsToDelete.push(expense.id);
      }
      continue;
    }

    const adjustment = adjustedRecurrence(expense.recurrence, month, remainingMonths);

    if (adjustment.kind === "delete") {
      plan.recurringExpenseIDsToDelete.push(expense.id);
    } else if (adjustment.kind === "update") {
      plan.recurringExpenseUpdates.push({
        id: expense.id,
        recurrence: adjustment.recurrence,
      });
      if (adjustment.shiftedStart) {
        plan.impact.shiftedRecurringStartCount += 1;
      }
      if (adjustment.shiftedEnd) {
        plan.impact.shiftedRecurringEndCount += 1;
      }
    }
  }

  plan.impact.deletedOneOffExpenseCount = plan.oneOffExpenseIDsToDelete.length;
  plan.impact.deletedRecurringExpenseCount = plan.recurringExpenseIDsToDelete.length;
  return plan;
}

function adjustedRecurrence(recurrence, deletingMonth, remainingMonths) {
  const deletesStart = compareYearMonths(recurrence.startMonth, deletingMonth) === 0;
  const deletesEnd =
    recurrence.endMonth != null &&
    compareYearMonths(recurrence.endMonth, deletingMonth) === 0;

  if (!deletesStart && !deletesEnd) {
    return { kind: "unchanged" };
  }

  let updatedStartMonth = recurrence.startMonth;
  let updatedEndMonth = recurrence.endMonth;
  let shiftedStart = false;
  let shiftedEnd = false;

  if (deletesStart) {
    const nextStartMonth = nextRemainingMonth(deletingMonth, recurrence.endMonth, remainingMonths);
    if (!nextStartMonth) {
      return { kind: "delete" };
    }
    updatedStartMonth = nextStartMonth;
    shiftedStart = true;
  }

  if (deletesEnd) {
    const previousEndMonth = previousRemainingMonth(deletingMonth, updatedStartMonth, remainingMonths);
    if (!previousEndMonth) {
      return { kind: "delete" };
    }
    updatedEndMonth = previousEndMonth;
    shiftedEnd = true;
  }

  if (updatedEndMonth && compareYearMonths(updatedStartMonth, updatedEndMonth) > 0) {
    return { kind: "delete" };
  }

  return {
    kind: "update",
    recurrence: {
      startMonth: updatedStartMonth,
      endMonth: updatedEndMonth,
    },
    shiftedStart,
    shiftedEnd,
  };
}

function nextRemainingMonth(month, upperBound, remainingMonths) {
  return (
    remainingMonths.find((candidate) => {
      if (compareYearMonths(candidate, month) <= 0) {
        return false;
      }
      if (!upperBound) {
        return true;
      }
      return compareYearMonths(candidate, upperBound) <= 0;
    }) ?? null
  );
}

function previousRemainingMonth(month, lowerBound, remainingMonths) {
  return (
    [...remainingMonths]
      .reverse()
      .find(
        (candidate) =>
          compareYearMonths(candidate, month) < 0 &&
          compareYearMonths(candidate, lowerBound) >= 0
      ) ?? null
  );
}

export function emptyMonthDeletionImpact() {
  return {
    deletedOneOffExpenseCount: 0,
    deletedRecurringExpenseCount: 0,
    shiftedRecurringStartCount: 0,
    shiftedRecurringEndCount: 0,
  };
}

export function validateExpenseMonths(expense, allowedMonthKeys) {
  const issues = [];

  if (expense.recurrence) {
    const startKey = yearMonthKey(expense.recurrence.startMonth);
    if (!allowedMonthKeys.has(startKey)) {
      issues.push({
        kind: "recurrenceStartMonthMissing",
        month: expense.recurrence.startMonth,
      });
    }

    if (expense.recurrence.endMonth) {
      const endKey = yearMonthKey(expense.recurrence.endMonth);
      if (!allowedMonthKeys.has(endKey)) {
        issues.push({
          kind: "recurrenceEndMonthMissing",
          month: expense.recurrence.endMonth,
        });
      }
    }

    return issues;
  }

  const spentMonth = yearMonthFromDate(expense.spentAt);
  if (!allowedMonthKeys.has(yearMonthKey(spentMonth))) {
    issues.push({
      kind: "spentMonthMissing",
      month: spentMonth,
    });
  }

  return issues;
}

export function issueMessage(issue) {
  const title = yearMonthTitle(issue.month);

  if (issue.kind === "spentMonthMissing") {
    return `지출 일자는 생성된 월에만 저장할 수 있습니다. ${title} 페이지를 먼저 추가하세요.`;
  }

  if (issue.kind === "recurrenceStartMonthMissing") {
    return `반복 시작 월은 생성된 월이어야 합니다. ${title} 페이지를 먼저 추가하세요.`;
  }

  return `반복 종료 월은 생성된 월이어야 합니다. ${title} 페이지를 먼저 추가하세요.`;
}

export function matchesExpenseKindFilter(expense, filter = "all") {
  const normalizedFilter = normalizeExpenseKindFilter(filter);

  if (normalizedFilter === "all") {
    return true;
  }

  const isRecurring = Boolean(expense.recurrence);
  return normalizedFilter === "recurring" ? isRecurring : !isRecurring;
}

export function totalsForMonth(month, snapshot, filter = "all") {
  const normalizedMonth = normalizeYearMonth(month);
  const exchangeRates = snapshot.exchangeRates ?? emptyExchangeRates();
  const totalsBySource = new Map();

  for (const expense of snapshot.expenses) {
    if (!matchesExpenseKindFilter(expense, filter) || !expenseOccursInMonth(expense, normalizedMonth)) {
      continue;
    }

    const amount = amountInKRW(expense, exchangeRates);
    if (amount == null) {
      continue;
    }

    totalsBySource.set(expense.sourceID, (totalsBySource.get(expense.sourceID) ?? 0) + amount);
  }

  return snapshot.sources
    .slice()
    .sort((left, right) => left.id - right.id)
    .map((source) => ({
      source,
      total: totalsBySource.get(source.id) ?? 0,
    }))
    .filter((entry) => entry.total > 0);
}

export function totalAmountForMonth(month, snapshot, filter = "all") {
  const exchangeRates = snapshot.exchangeRates ?? emptyExchangeRates();
  return snapshot.expenses.reduce((runningTotal, expense) => {
    if (!matchesExpenseKindFilter(expense, filter) || !expenseOccursInMonth(expense, month)) {
      return runningTotal;
    }
    return runningTotal + (amountInKRW(expense, exchangeRates) ?? 0);
  }, 0);
}

export function occurrencesForMonth(month, sourceID, snapshot, filter = "all") {
  const normalizedMonth = normalizeYearMonth(month);
  return snapshot.expenses
    .filter(
      (expense) =>
        matchesExpenseKindFilter(expense, filter) &&
        (sourceID == null || expense.sourceID === sourceID)
    )
    .map((expense) => ({
      expense,
      source: sourceById(snapshot, expense.sourceID),
      displayDate: materializedDisplayDate(expense, normalizedMonth),
    }))
    .filter((entry) => entry.source != null && entry.displayDate != null)
    .sort((left, right) => right.displayDate.getTime() - left.displayDate.getTime());
}

export function expenseOccursInMonth(expense, month) {
  const normalizedMonth = normalizeYearMonth(month);
  if (!expense.recurrence) {
    return compareYearMonths(yearMonthFromDate(expense.spentAt), normalizedMonth) === 0;
  }

  if (compareYearMonths(normalizedMonth, expense.recurrence.startMonth) < 0) {
    return false;
  }

  if (expense.recurrence.endMonth && compareYearMonths(normalizedMonth, expense.recurrence.endMonth) > 0) {
    return false;
  }

  return true;
}

export function materializedDisplayDate(expense, month) {
  if (!expenseOccursInMonth(expense, month)) {
    return null;
  }

  if (!expense.recurrence) {
    return asDate(expense.spentAt);
  }

  return materializeDate(normalizeYearMonth(month), expense.spentAt);
}

function normalizeExpenseKindFilter(filter) {
  return filter === "recurring" || filter === "oneOff" ? filter : "all";
}

export function amountInKRW(expense, exchangeRates) {
  const currency = expense.currency;

  if (currency === "krw") {
    return expense.amountMinorUnits;
  }

  if (currency === "usd") {
    const rate = exchangeRates?.usdToKRWPer1 ?? 0;
    if (!(rate > 0)) {
      return null;
    }
    return roundedKRW(
      (expense.amountMinorUnits * rate) / currencyMeta.usd.minorUnitsPerMajorUnit
    );
  }

  const rate = exchangeRates?.jpyToKRWPer100 ?? 0;
  if (!(rate > 0)) {
    return null;
  }
  return roundedKRW((expense.amountMinorUnits * rate) / 100);
}

export function formattedKRWEquivalent(expense, exchangeRates) {
  if (expense.currency === "krw") {
    return null;
  }
  const value = amountInKRW(expense, exchangeRates);
  return value == null ? null : formatAmount(value, "krw");
}

export function formatAmount(amountMinorUnits, currency) {
  const meta = currencyMeta[currency];
  const decimalValue = amountMinorUnits / meta.minorUnitsPerMajorUnit;
  const formatter = new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: meta.fractionDigits,
    maximumFractionDigits: meta.fractionDigits,
  });
  return `${meta.prefix}${formatter.format(decimalValue)}`;
}

export function formatInputAmount(amountMinorUnits, currency) {
  const meta = currencyMeta[currency];
  const decimalValue = amountMinorUnits / meta.minorUnitsPerMajorUnit;
  const formatter = new Intl.NumberFormat("en-US", {
    useGrouping: false,
    minimumFractionDigits: meta.fractionDigits,
    maximumFractionDigits: meta.fractionDigits,
  });
  return formatter.format(decimalValue);
}

export function parseMinorUnits(text, currency) {
  const raw = String(text ?? "")
    .trim()
    .replace(/[,\s]/g, "");

  if (!raw) {
    return null;
  }

  if (currency === "krw" || currency === "jpy") {
    return /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : null;
  }

  if (!/^[0-9]*\.?[0-9]*$/.test(raw) || raw === "." || raw.endsWith(".")) {
    return null;
  }

  const [wholePart = "0", decimalPart = ""] = raw.split(".");
  if (decimalPart.length > 2) {
    return null;
  }

  const normalizedWhole = wholePart === "" ? "0" : wholePart;
  const normalizedDecimal = `${decimalPart}00`.slice(0, 2);
  return Number.parseInt(`${normalizedWhole}${normalizedDecimal}`, 10);
}

export function hasExchangeRate(exchangeRates, currency) {
  if (currency === "krw") {
    return true;
  }

  if (currency === "usd") {
    return (exchangeRates?.usdToKRWPer1 ?? 0) > 0;
  }

  return (exchangeRates?.jpyToKRWPer100 ?? 0) > 0;
}

export function defaultMonthForCreation(months, anchorMonth) {
  const existing = new Set(months.map((month) => yearMonthKey(month)));
  let candidate = anchorMonth ? addMonths(anchorMonth, 1) : yearMonthFromDate(new Date());

  while (existing.has(yearMonthKey(candidate))) {
    candidate = addMonths(candidate, 1);
  }

  return candidate;
}

export function colorForSource(sourceID) {
  const hue = (sourceID * 37) % 360;
  return `hsl(${hue} 72% 46%)`;
}

export function yearMonthKey(month) {
  const normalized = normalizeYearMonth(month);
  return `${String(normalized.year).padStart(4, "0")}-${String(normalized.month).padStart(2, "0")}`;
}

export function yearMonthTitle(month) {
  const normalized = normalizeYearMonth(month);
  return `${normalized.year}년 ${normalized.month}월`;
}

export function parseYearMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(String(value ?? ""))) {
    return null;
  }

  const [yearText, monthText] = String(value).split("-");
  const month = Number.parseInt(monthText, 10);
  if (!(month >= 1 && month <= 12)) {
    return null;
  }

  return {
    year: Number.parseInt(yearText, 10),
    month,
  };
}

export function normalizeYearMonth(value) {
  if (value instanceof Date || typeof value === "string") {
    return typeof value === "string" ? parseDateInputToYearMonth(value) : yearMonthFromDate(value);
  }

  if (
    !value ||
    !Number.isInteger(value.year) ||
    !Number.isInteger(value.month) ||
    value.month < 1 ||
    value.month > 12
  ) {
    throw new Error("월 정보가 올바르지 않습니다.");
  }

  return { year: value.year, month: value.month };
}

export function compareYearMonths(left, right) {
  const lhs = normalizeYearMonth(left);
  const rhs = normalizeYearMonth(right);
  if (lhs.year !== rhs.year) {
    return lhs.year - rhs.year;
  }
  return lhs.month - rhs.month;
}

export function yearMonthFromDate(value) {
  const date = asDate(value);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
  };
}

export function addMonths(month, offset) {
  const normalized = normalizeYearMonth(month);
  const date = new Date(normalized.year, normalized.month - 1 + offset, 1, 12, 0, 0, 0);
  return yearMonthFromDate(date);
}

export function firstDateOfYearMonth(month) {
  const normalized = normalizeYearMonth(month);
  return new Date(normalized.year, normalized.month - 1, 1, 12, 0, 0, 0);
}

export function materializeDate(month, template) {
  const targetMonth = normalizeYearMonth(month);
  const targetDate = asDate(template);
  const day = targetDate.getDate();
  const lastDayOfMonth = new Date(targetMonth.year, targetMonth.month, 0).getDate();
  const clampedDay = Math.min(day, lastDayOfMonth);

  return new Date(
    targetMonth.year,
    targetMonth.month - 1,
    clampedDay,
    targetDate.getHours(),
    targetDate.getMinutes(),
    targetDate.getSeconds(),
    targetDate.getMilliseconds()
  );
}

export function toDateInputValue(date) {
  const value = asDate(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate()
  ).padStart(2, "0")}`;
}

export function fromDateInputValue(value) {
  const match = /^\d{4}-\d{2}-\d{2}$/.exec(String(value ?? ""));
  if (!match) {
    throw new Error("날짜 형식이 올바르지 않습니다.");
  }

  const [yearText, monthText, dayText] = String(value).split("-");
  return new Date(
    Number.parseInt(yearText, 10),
    Number.parseInt(monthText, 10) - 1,
    Number.parseInt(dayText, 10),
    12,
    0,
    0,
    0
  );
}

export function toMonthInputValue(month) {
  return yearMonthKey(month);
}

export function parseDateInputToYearMonth(value) {
  const parsed = parseYearMonth(String(value).slice(0, 7));
  if (!parsed) {
    throw new Error("월 형식이 올바르지 않습니다.");
  }
  return parsed;
}

export function formatDateLabel(date) {
  return asDate(date).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTimeLabel(value) {
  if (!value) {
    return "";
  }

  return new Date(value).toLocaleString("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizeSource(record) {
  const id = Number(record?.id);
  const name = String(record?.name ?? "").trim();
  const kind = String(record?.kind ?? "");

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("카드/계좌 ID가 올바르지 않습니다.");
  }

  if (!SOURCE_KINDS.has(kind)) {
    throw new Error("카드/계좌 종류가 올바르지 않습니다.");
  }

  if (!name) {
    throw new Error("카드/계좌 이름이 비어 있습니다.");
  }

  return { id, kind, name };
}

function normalizeMonthPage(record) {
  return {
    yearMonth: normalizeYearMonth(record?.yearMonth),
  };
}

function normalizeExpense(record) {
  const id = String(record?.id ?? "").trim();
  const sourceID = Number(record?.sourceID);
  const description = normalizeDescription(record?.description);
  const amountMinorUnits = Number(record?.amountMinorUnits);
  const currency = String(record?.currency ?? "");
  const spentAt = toISOString(record?.spentAt);
  const recurrence = record?.recurrence == null ? null : normalizeRecurrence(record.recurrence);

  if (!id) {
    throw new Error("지출 ID가 비어 있습니다.");
  }

  if (!Number.isInteger(sourceID) || sourceID <= 0) {
    throw new Error("지출의 sourceID가 올바르지 않습니다.");
  }

  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
    throw new Error("지출 금액이 올바르지 않습니다.");
  }

  if (!CURRENCIES.has(currency)) {
    throw new Error("지출 통화가 올바르지 않습니다.");
  }

  return {
    id,
    sourceID,
    description,
    amountMinorUnits,
    currency,
    spentAt,
    recurrence,
  };
}

function normalizeRecurrence(record) {
  const startMonth = normalizeYearMonth(record?.startMonth);
  const endMonth = record?.endMonth == null ? null : normalizeYearMonth(record.endMonth);

  if (endMonth && compareYearMonths(startMonth, endMonth) > 0) {
    throw new Error("반복 종료 월은 시작 월보다 빠를 수 없습니다.");
  }

  return { startMonth, endMonth };
}

function normalizeExchangeRates(record) {
  const usdToKRWPer1 = nullablePositiveInteger(record?.usdToKRWPer1);
  const jpyToKRWPer100 = nullablePositiveInteger(record?.jpyToKRWPer100);

  return {
    usdToKRWPer1,
    jpyToKRWPer100,
  };
}

function normalizeDescription(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function asArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} 배열을 해석하지 못했습니다.`);
  }
  return value;
}

function nullablePositiveInteger(value) {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("환율 값이 올바르지 않습니다.");
  }
  return number;
}

function roundedKRW(value) {
  return Math.round(value);
}

function toISOString(value) {
  return asDate(value).toISOString();
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("날짜를 해석하지 못했습니다.");
  }
  return date;
}
