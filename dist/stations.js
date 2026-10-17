export const MIN_FREQUENCY = 87.5;
export const MAX_FREQUENCY = 108;
export const STEP = 0.1;

export const DEFAULT_STATIONS = [
  { id: 'example-beacon', name: 'Маяк', frequency: 91.4, type: 'beacon', enabled: true, loop: true, bandwidth: 0.65 },
  { id: 'example-morse', name: 'Позывной', frequency: 98.2, type: 'morse', enabled: true, loop: true, bandwidth: 0.65 },
  { id: 'example-tone', name: 'Дальний сигнал', frequency: 104.7, type: 'tone', enabled: true, loop: true, bandwidth: 0.65 },
];

export function clampFrequency(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return MIN_FREQUENCY;
  const limited = Math.min(MAX_FREQUENCY, Math.max(MIN_FREQUENCY, value));
  return Math.round(limited * 10) / 10;
}

/** Bandwidth is the capture radius in MHz on either side of the station. */
export function getReception(frequency, stations) {
  let reception = { station: null, strength: 0 };
  let nearest = Infinity;
  if (!Number.isFinite(frequency) || !Array.isArray(stations)) return reception;

  for (const station of stations) {
    if (!station || station.enabled !== true || !Number.isFinite(station.frequency)
      || !Number.isFinite(station.bandwidth) || station.bandwidth <= 0) continue;
    const distance = Math.abs(frequency - station.frequency);
    if (distance >= station.bandwidth) continue;
    const strength = (1 + Math.cos(Math.PI * distance / station.bandwidth)) / 2;
    if (strength <= 1e-12) continue;

    const stronger = strength > reception.strength + 1e-12;
    const tied = Math.abs(strength - reception.strength) <= 1e-12;
    const closer = distance < nearest - 1e-12;
    const sameDistance = Math.abs(distance - nearest) <= 1e-12;
    const stableId = String(station.id ?? '') < String(reception.station?.id ?? '');
    if (stronger || (tied && (closer || (sameDistance && stableId)))) {
      reception = { station, strength };
      nearest = distance;
    }
  }
  return reception;
}

export function validateStation(input, existingStations = [], excludeId = null) {
  const errors = {};
  try {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name || name.length > 60) errors.name = 'Введите название от 1 до 60 символов.';

    const frequency = value.frequency;
    if (!Number.isFinite(frequency) || frequency < MIN_FREQUENCY || frequency > MAX_FREQUENCY) {
      errors.frequency = 'Укажите частоту от 87,5 до 108,0 МГц.';
    } else if (Array.isArray(existingStations) && existingStations.some((station) =>
      station && (excludeId === null || station.id !== excludeId)
        && Number.isFinite(station.frequency)
        && Math.round(station.frequency * 10) === Math.round(frequency * 10))) {
      errors.frequency = 'Эта частота уже занята другим сигналом.';
    }

    if (!['beacon', 'morse', 'tone', 'file'].includes(value.type)) {
      errors.file = 'Выберите доступный тип сигнала.';
    } else if (value.type === 'file' && value.file != null
      && !(typeof Blob !== 'undefined' && value.file instanceof Blob)) {
      errors.file = 'Выберите аудиофайл с устройства.';
    }
  } catch {
    errors.name = 'Не удалось прочитать сигнал. Проверьте введённые данные.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

const DATABASE_NAME = 'efir-radio';
const STORE_NAME = 'settings';
const STATIONS_KEY = 'stations';

function storageError(action, cause) {
  const detail = cause?.name === 'QuotaExceededError'
    ? 'Освободите место на устройстве или выберите аудиофайл меньшего размера.'
    : 'Проверьте доступ браузера к локальному хранилищу и повторите попытку.';
  return new Error(`IndexedDB: не удалось ${action}. ${detail}`, { cause });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    try {
      if (!globalThis.indexedDB) throw new Error('IndexedDB unavailable');
      request = globalThis.indexedDB.open(DATABASE_NAME, 1);
    } catch (error) {
      reject(storageError('открыть локальное хранилище', error));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (settled) database.close();
      else {
        settled = true;
        resolve(database);
      }
    };
    request.onerror = () => {
      settled = true;
      reject(storageError('открыть локальное хранилище', request.error));
    };
    request.onblocked = () => {
      settled = true;
      reject(new Error('IndexedDB: хранилище заблокировано другой вкладкой. Закройте другие вкладки «Эфира» и повторите попытку.'));
    };
  });
}

async function transact(mode, action, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      let transaction;
      let result;
      try {
        transaction = database.transaction(STORE_NAME, mode);
        const request = operation(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(storageError(action, request.error));
      } catch (error) {
        reject(storageError(action, error));
        return;
      }
      // A successful request alone does not prove that the write was committed.
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(storageError(action, transaction.error));
      transaction.onabort = () => reject(storageError(action, transaction.error));
    });
  } finally {
    database.close();
  }
}

export async function loadStations() {
  const saved = await transact('readonly', 'загрузить сигналы', (store) => store.get(STATIONS_KEY));
  if (saved === undefined) return null;
  if (!Array.isArray(saved)) throw new Error('IndexedDB: сохранённые сигналы повреждены. Удалите локальные данные через настройки.');
  return saved;
}

export async function saveStations(stations) {
  if (!Array.isArray(stations)) throw new Error('IndexedDB: для сохранения нужен список сигналов. Проверьте данные и повторите попытку.');
  await transact('readwrite', 'сохранить сигналы', (store) => store.put(stations, STATIONS_KEY));
}

export async function clearStations() {
  await transact('readwrite', 'удалить сохранённые сигналы', (store) => store.delete(STATIONS_KEY));
}
