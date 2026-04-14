export const TYPE_COLORS = [
  "blue",
  "pink",
  "green",
  "orange",
  "purple",
  "teal",
  "amber",
  "slate",
];

const TYPE_COLOR_SET = new Set(TYPE_COLORS);
const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const typeColorMeta = {
  blue: { title: "블루" },
  pink: { title: "핑크" },
  green: { title: "그린" },
  orange: { title: "오렌지" },
  purple: { title: "퍼플" },
  teal: { title: "틸" },
  amber: { title: "앰버" },
  slate: { title: "슬레이트" },
};

export function emptySnapshot() {
  return {
    version: 1,
    types: [
      { id: 1, name: "식품", color: "blue" },
      { id: 2, name: "화장품", color: "pink" },
      { id: 3, name: "의약품", color: "green" },
    ],
    items: [],
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

  const types = asArray(snapshot.types, "types").map(normalizeType);
  const typeIDs = new Set(types.map((type) => type.id));
  const items = asArray(snapshot.items, "items").map((item) => normalizeItem(item, typeIDs));

  return {
    version: snapshot.version,
    types: types.sort((left, right) => left.id - right.id),
    items: items.sort(compareItemsForStorage),
  };
}

export function encodeSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  return JSON.stringify(normalized, null, 2);
}

function normalizeType(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("타입 데이터 형식이 올바르지 않습니다.");
  }

  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("타입 id는 양의 정수여야 합니다.");
  }

  const name = String(raw.name ?? "").trim();
  if (!name) {
    throw new Error("타입 이름이 비어 있습니다.");
  }

  const color = String(raw.color ?? "").trim();
  if (!TYPE_COLOR_SET.has(color)) {
    throw new Error(`지원하지 않는 타입 색상입니다: ${color || "(빈 값)"}`);
  }

  return { id, name, color };
}

function normalizeItem(raw, typeIDs) {
  if (!raw || typeof raw !== "object") {
    throw new Error("물품 데이터 형식이 올바르지 않습니다.");
  }

  const id = String(raw.id ?? "").trim();
  if (!id) {
    throw new Error("물품 id가 비어 있습니다.");
  }

  const typeID = Number(raw.typeID);
  if (!Number.isInteger(typeID) || !typeIDs.has(typeID)) {
    throw new Error(`물품 "${raw.name ?? id}"의 타입을 찾지 못했습니다.`);
  }

  const name = String(raw.name ?? "").trim();
  if (!name) {
    throw new Error("물품 이름이 비어 있습니다.");
  }

  const expiresOn = String(raw.expiresOn ?? "").trim();
  if (!DATE_INPUT_PATTERN.test(expiresOn) || Number.isNaN(parseExpiresOn(expiresOn).getTime())) {
    throw new Error(`물품 "${name}"의 사용기한 형식이 올바르지 않습니다.`);
  }

  const quantity = Number(raw.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`물품 "${name}"의 개수는 양의 정수여야 합니다.`);
  }

  const location = raw.location == null ? null : String(raw.location).trim() || null;
  const notes = raw.notes == null ? null : String(raw.notes).trim() || null;
  const createdAt = normalizeTimestamp(raw.createdAt, `물품 "${name}"의 createdAt`);
  const updatedAt = normalizeTimestamp(raw.updatedAt, `물품 "${name}"의 updatedAt`);

  return {
    id,
    typeID,
    name,
    expiresOn,
    quantity,
    location,
    notes,
    createdAt,
    updatedAt,
  };
}

function normalizeTimestamp(value, context) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${context} 값이 비어 있습니다.`);
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${context} 값이 올바르지 않습니다.`);
  }
  return parsed.toISOString();
}

function asArray(value, context) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context} 필드는 배열이어야 합니다.`);
  }
  return value;
}

export function compareItemsForStorage(left, right) {
  if (left.expiresOn !== right.expiresOn) {
    return left.expiresOn < right.expiresOn ? -1 : 1;
  }
  return left.name.localeCompare(right.name, "ko");
}

export function nextTypeID(snapshot) {
  return snapshot.types.reduce((maxID, type) => Math.max(maxID, type.id), 0) + 1;
}

export function typeByID(snapshot, typeID) {
  return snapshot.types.find((type) => type.id === typeID) ?? null;
}

export function itemCountForType(snapshot, typeID) {
  return snapshot.items.filter((item) => item.typeID === typeID).length;
}

export function upsertType(snapshot, record) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const candidate = {
    id: Number.isInteger(record.id) && record.id > 0 ? record.id : nextTypeID(nextSnapshot),
    name: String(record.name ?? "").trim(),
    color: String(record.color ?? "").trim(),
  };

  if (!candidate.name) {
    throw new Error("타입 이름을 입력하세요.");
  }

  if (!TYPE_COLOR_SET.has(candidate.color)) {
    throw new Error("타입 색상을 선택하세요.");
  }

  const duplicateName = nextSnapshot.types.some(
    (type) => type.id !== candidate.id && type.name === candidate.name
  );
  if (duplicateName) {
    throw new Error("이미 사용 중인 타입 이름입니다.");
  }

  const existingIndex = nextSnapshot.types.findIndex((type) => type.id === candidate.id);
  if (existingIndex >= 0) {
    nextSnapshot.types[existingIndex] = candidate;
  } else {
    nextSnapshot.types.push(candidate);
  }

  nextSnapshot.types.sort((left, right) => left.id - right.id);
  return nextSnapshot;
}

export function deleteType(snapshot, typeID) {
  const linked = itemCountForType(snapshot, typeID);
  if (linked > 0) {
    throw new Error(`이 타입에 속한 물품 ${linked}개를 먼저 정리하세요.`);
  }

  const nextSnapshot = cloneSnapshot(snapshot);
  nextSnapshot.types = nextSnapshot.types.filter((type) => type.id !== typeID);
  return nextSnapshot;
}

export function upsertItem(snapshot, record) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const typeIDs = new Set(nextSnapshot.types.map((type) => type.id));
  const nowISO = new Date().toISOString();
  const existingIndex = nextSnapshot.items.findIndex((item) => item.id === record.id);
  const createdAt =
    existingIndex >= 0 ? nextSnapshot.items[existingIndex].createdAt : nowISO;

  const normalized = normalizeItem(
    {
      ...record,
      createdAt,
      updatedAt: nowISO,
    },
    typeIDs
  );

  if (existingIndex >= 0) {
    nextSnapshot.items[existingIndex] = normalized;
  } else {
    nextSnapshot.items.push(normalized);
  }

  nextSnapshot.items.sort(compareItemsForStorage);
  return nextSnapshot;
}

export function deleteItem(snapshot, itemID) {
  const nextSnapshot = cloneSnapshot(snapshot);
  nextSnapshot.items = nextSnapshot.items.filter((item) => item.id !== itemID);
  return nextSnapshot;
}

export function decrementItem(snapshot, itemID) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const index = nextSnapshot.items.findIndex((item) => item.id === itemID);
  if (index < 0) {
    return nextSnapshot;
  }

  const item = nextSnapshot.items[index];
  const nextQuantity = item.quantity - 1;
  if (nextQuantity <= 0) {
    nextSnapshot.items.splice(index, 1);
    return nextSnapshot;
  }

  nextSnapshot.items[index] = {
    ...item,
    quantity: nextQuantity,
    updatedAt: new Date().toISOString(),
  };
  nextSnapshot.items.sort(compareItemsForStorage);
  return nextSnapshot;
}

export function itemsFilteredByType(snapshot, typeFilter) {
  if (typeFilter === "all" || typeFilter == null) {
    return snapshot.items.slice().sort(compareItemsForStorage);
  }
  const typeID = Number(typeFilter);
  if (!Number.isInteger(typeID)) {
    return [];
  }
  return snapshot.items
    .filter((item) => item.typeID === typeID)
    .sort(compareItemsForStorage);
}

export function parseExpiresOn(expiresOn) {
  if (!DATE_INPUT_PATTERN.test(String(expiresOn ?? ""))) {
    return new Date(NaN);
  }
  const [year, month, day] = expiresOn.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function todayDateKey(reference = new Date()) {
  const year = reference.getFullYear();
  const month = String(reference.getMonth() + 1).padStart(2, "0");
  const day = String(reference.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function daysUntilExpiry(expiresOn, reference = new Date()) {
  const target = parseExpiresOn(expiresOn);
  if (Number.isNaN(target.getTime())) {
    return null;
  }
  const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const diffMs = target.getTime() - today.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

export const EXPIRY_BUCKETS = [
  { id: "expired", title: "기한 지남", description: "이미 기한이 지난 물품입니다." },
  { id: "soon", title: "임박 (7일 이내)", description: "일주일 안에 기한이 지납니다." },
  { id: "month", title: "이번 달 (30일 이내)", description: "한 달 안에 기한이 지납니다." },
  { id: "later", title: "나중", description: "기한이 한 달 이상 남았습니다." },
];

export function bucketForDaysUntilExpiry(days) {
  if (days == null) {
    return "later";
  }
  if (days < 0) {
    return "expired";
  }
  if (days <= 7) {
    return "soon";
  }
  if (days <= 30) {
    return "month";
  }
  return "later";
}

export function groupItemsByBucket(items, reference = new Date()) {
  const groups = {
    expired: [],
    soon: [],
    month: [],
    later: [],
  };
  for (const item of items) {
    const days = daysUntilExpiry(item.expiresOn, reference);
    const bucket = bucketForDaysUntilExpiry(days);
    groups[bucket].push({ item, days });
  }
  return groups;
}

export function formatExpiresOnLabel(expiresOn) {
  const date = parseExpiresOn(expiresOn);
  if (Number.isNaN(date.getTime())) {
    return expiresOn;
  }
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${year}년 ${month}월 ${day}일`;
}

export function formatDateTimeLabel(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function formatDDayLabel(days) {
  if (days == null) {
    return "D-?";
  }
  if (days === 0) {
    return "D-day";
  }
  if (days < 0) {
    return `D+${Math.abs(days)}`;
  }
  return `D-${days}`;
}
