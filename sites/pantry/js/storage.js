const DB_NAME = "track-your-pantry-web";
const DB_VERSION = 1;
const STORE_NAME = "kv";
const KEYS = {
  snapshot: "snapshot",
  settings: "settings",
  token: "token",
  legacyTokenEnvelope: "tokenEnvelope",
};

let openRequest = null;
let warnedFallback = false;

export async function loadPersistedState() {
  const [snapshot, settings, token, legacyTokenEnvelope] = await Promise.all([
    getValue(KEYS.snapshot),
    getValue(KEYS.settings),
    getValue(KEYS.token),
    getValue(KEYS.legacyTokenEnvelope),
  ]);

  return {
    snapshot,
    settings,
    token: typeof token === "string" && token ? token : null,
    hasLegacyTokenEnvelope: legacyTokenEnvelope != null,
  };
}

export function persistSnapshot(snapshot) {
  return setValue(KEYS.snapshot, snapshot);
}

export function persistSettings(settings) {
  return setValue(KEYS.settings, settings);
}

export function persistToken(token) {
  return setValue(KEYS.token, token);
}

export function clearLegacyTokenEnvelope() {
  return deleteValue(KEYS.legacyTokenEnvelope);
}

async function getValue(key) {
  const database = await openDatabase();
  if (!database) {
    return readFromLocalStorage(key);
  }

  return transact(database, "readonly", (store) => store.get(key));
}

async function setValue(key, value) {
  const database = await openDatabase();
  if (!database) {
    writeToLocalStorage(key, value);
    return;
  }

  await transact(database, "readwrite", (store) => store.put(value, key));
}

async function deleteValue(key) {
  const database = await openDatabase();
  if (!database) {
    window.localStorage.removeItem(storageKey(key));
    return;
  }

  await transact(database, "readwrite", (store) => store.delete(key));
}

function openDatabase() {
  if (!("indexedDB" in window)) {
    warnFallback();
    return Promise.resolve(null);
  }

  if (!openRequest) {
    openRequest = new Promise((resolve) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.error("IndexedDB를 열지 못했습니다.", request.error);
        warnFallback();
        resolve(null);
      };
    });
  }

  return openRequest;
}

function transact(database, mode, perform) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = perform(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 작업에 실패했습니다."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB 트랜잭션에 실패했습니다."));
  });
}

function storageKey(key) {
  return `${DB_NAME}:${key}`;
}

function readFromLocalStorage(key) {
  const raw = window.localStorage.getItem(storageKey(key));
  return raw == null ? null : JSON.parse(raw);
}

function writeToLocalStorage(key, value) {
  window.localStorage.setItem(storageKey(key), JSON.stringify(value));
}

function warnFallback() {
  if (warnedFallback) {
    return;
  }
  warnedFallback = true;
  console.warn("IndexedDB를 사용할 수 없어 localStorage로 대체합니다.");
}
