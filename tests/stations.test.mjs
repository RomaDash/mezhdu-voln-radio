import test from 'node:test';
import assert from 'node:assert/strict';

// These assertions describe missing behavior even before the module exists.
const api = await import('../dist/stations.js').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

function feature(name) {
  assert.equal(typeof api[name], 'function', `${name} must be implemented`);
  return api[name];
}

const station = (overrides = {}) => ({
  id: 'test',
  name: 'Тестовый сигнал',
  frequency: 98.2,
  type: 'tone',
  enabled: true,
  loop: true,
  bandwidth: 0.6,
  ...overrides,
});

test('tuning rounds to a tenth and cannot leave the FM dial', () => {
  const clampFrequency = feature('clampFrequency');
  for (const [value, expected] of [
    [98.24, 98.2], [98.26, 98.3], [87.49, 87.5], [109, 108],
    [-20, 87.5], [Infinity, 108], [-Infinity, 87.5], [NaN, 87.5],
  ]) assert.equal(clampFrequency(value), expected, `tuning ${value}`);
});

test('a captured station fades smoothly from center to its bandwidth edge', () => {
  const getReception = feature('getReception');
  const source = station();
  assert.deepEqual(getReception(98.2, [source]), { station: source, strength: 1 });
  const midway = getReception(98.5, [source]);
  assert.equal(midway.station, source);
  assert.ok(Math.abs(midway.strength - 0.5) < 1e-10);
  assert.deepEqual(getReception(98.8, [source]), { station: null, strength: 0 });
  assert.deepEqual(getReception(99, [source]), { station: null, strength: 0 });
  assert.ok(getReception(98.3, [source]).strength > midway.strength);
  assert.ok(getReception(98.7, [source]).strength < midway.strength);
});

test('disabled signals and an empty dial never create reception', () => {
  const getReception = feature('getReception');
  assert.deepEqual(getReception(98.2, []), { station: null, strength: 0 });
  assert.deepEqual(getReception(98.2, [station({ enabled: false })]), { station: null, strength: 0 });
  assert.deepEqual(getReception(NaN, [station()]), { station: null, strength: 0 });
});

test('overlapping reception selects the strongest usable signal', () => {
  const getReception = feature('getReception');
  const weak = station({ id: 'weak', frequency: 98.6 });
  const strong = station({ id: 'strong', frequency: 98.3 });
  assert.equal(getReception(98.2, [weak, strong]).station.id, 'strong');
  const left = station({ id: 'a', frequency: 98.1 });
  const right = station({ id: 'b', frequency: 98.3 });
  assert.equal(getReception(98.2, [right, left]).station.id, 'a');
  assert.equal(getReception(98.2, [left, right]).station.id, 'a');
});

test('a malformed signal cannot suppress valid reception', () => {
  const getReception = feature('getReception');
  const good = station();
  assert.equal(getReception(98.2, [null, station({ bandwidth: 0 }), station({ frequency: NaN }), good]).station, good);
});

test('default example signals are independently receivable', () => {
  const getReception = feature('getReception');
  assert.ok(Array.isArray(api.DEFAULT_STATIONS));
  for (const [frequency, name] of [[91.4, 'Маяк'], [98.2, 'Позывной'], [104.7, 'Дальний сигнал']]) {
    const received = getReception(frequency, api.DEFAULT_STATIONS);
    assert.equal(received.station?.name, name);
    assert.equal(received.strength, 1);
  }
});

test('valid stations include an audio file placeholder without an upload', () => {
  const validateStation = feature('validateStation');
  assert.deepEqual(validateStation(station()), { valid: true, errors: {} });
  assert.deepEqual(validateStation(station({ type: 'file' })), { valid: true, errors: {} });
  assert.deepEqual(validateStation(station({ type: 'file', file: new Blob(['audio'], { type: 'audio/wav' }) })), { valid: true, errors: {} });
});

test('station validation rejects blank and oversized names', () => {
  const validateStation = feature('validateStation');
  for (const name of ['', '   ', 'x'.repeat(61), null, 17]) {
    const result = validateStation(station({ name }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.name);
  }
  assert.equal(validateStation(station({ name: 'x'.repeat(60) })).valid, true);
});

test('station validation rejects nonnumeric and out-of-band frequencies', () => {
  const validateStation = feature('validateStation');
  for (const frequency of [NaN, Infinity, -Infinity, 87.4, 108.1, null, '', '98.2', Symbol('frequency')]) {
    const result = validateStation(station({ frequency }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.frequency);
  }
  assert.equal(validateStation(station({ frequency: 87.5 })).valid, true);
  assert.equal(validateStation(station({ frequency: 108 })).valid, true);
});

test('a frequency cannot be assigned twice at the dial tenth precision', () => {
  const validateStation = feature('validateStation');
  const existing = station({ id: 'existing' });
  const duplicate = validateStation(station({ id: 'new', frequency: 98.24 }), [existing]);
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.frequency);
  assert.equal(validateStation(station({ frequency: 98.26 }), [existing]).valid, true);
  assert.equal(validateStation(existing, [existing], 'existing').valid, true);
});

test('invalid uploads and signal types return field errors', () => {
  const validateStation = feature('validateStation');
  const fileResult = validateStation(station({ type: 'file', file: 'not a Blob' }));
  assert.equal(fileResult.valid, false);
  assert.ok(fileResult.errors.file);
  assert.equal(validateStation(station({ type: 'unknown' })).valid, false);
});

test('malformed station inputs return validation errors without throwing', () => {
  const validateStation = feature('validateStation');
  for (const input of [undefined, null, 17, [], Symbol('station'), Object.create(null), { get name() { throw new Error('bad getter'); } }]) {
    const result = validateStation(input, null);
    assert.equal(result.valid, false);
    assert.equal(typeof result.errors, 'object');
  }
});

test('unavailable browser storage rejects with an actionable persistence error', async () => {
  for (const name of ['loadStations', 'saveStations', 'clearStations']) {
    const operation = feature(name);
    await assert.rejects(() => operation(name === 'saveStations' ? [station()] : undefined), /IndexedDB.*(браузер|доступ|сохран|хранилищ)/i);
  }
});
