import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dist/audio-engine.js', import.meta.url), 'utf8').catch(() => '');
const { RadioAudio } = source ? await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) : {};

// Web Audio is an external browser API unavailable in Node. This fake keeps
// source activity, graph gains, offsets, suspension and deferred decoding visible.
class Parameter {
  constructor(value = 1) { this.value = value; }
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
}
class AudioNode {
  constructor(context, kind) { this.context = context; this.kind = kind; this.connections = []; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; }
}
class FakeAudioContext {
  static instances = [];
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.state = 'suspended';
    this.nodes = [];
    this.decodes = [];
    this.destination = new AudioNode(this, 'destination');
    FakeAudioContext.instances.push(this);
  }
  add(kind) { const node = new AudioNode(this, kind); this.nodes.push(node); return node; }
  createGain() { const node = this.add('gain'); node.gain = new Parameter(); return node; }
  createBiquadFilter() { const node = this.add('filter'); node.frequency = new Parameter(); node.Q = new Parameter(); return node; }
  createAnalyser() { return this.add('analyser'); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / sampleRate, getChannelData: index => data[index] };
  }
  createBufferSource() {
    const node = this.add('source');
    node.start = (when = 0, offset = 0) => { node.active = true; node.offset = offset; };
    node.stop = () => { node.active = false; node.onended?.(); };
    return node;
  }
  decodeAudioData(bytes) {
    return new Promise((resolve, reject) => this.decodes.push({ bytes, resolve, reject }));
  }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
}

function setup() {
  assert.equal(typeof RadioAudio, 'function', 'RadioAudio must expose the receiver audio lifecycle');
  FakeAudioContext.instances = [];
  globalThis.AudioContext = FakeAudioContext;
  return new RadioAudio();
}
const fileStation = (id, file = new Blob([id])) => ({ id, file, type: 'file', frequency: 91.2, name: id, loop: true, enabled: true });
const synthStation = (type = 'tone') => ({ id: type, type, frequency: 91.2, name: 'Test', loop: true, enabled: true });
const playingFiles = context => context.nodes.filter(node => node.kind === 'source' && node.active && node.buffer?.decoded);
const master = context => context.nodes.find(node => node.kind === 'gain' && node.connections.some(next => next.kind === 'analyser'));
async function flush() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }

// Removing lazy construction, safe startup gain or suspension must break this test.
test('starts audio only on request and stop immediately mutes and suspends it', async () => {
  const engine = setup();
  await engine.setStation(synthStation(), 1);
  assert.equal(FakeAudioContext.instances.length, 0);
  assert.equal(await engine.start(), true);
  const context = FakeAudioContext.instances[0];
  assert.equal(engine.isStarted, true);
  assert.ok(master(context).gain.value > 0 && master(context).gain.value <= 0.2);
  assert.equal(context.nodes.filter(node => node.kind === 'source' && node.active).length, 2);
  engine.stop();
  assert.equal(engine.isStarted, false);
  assert.equal(master(context).gain.value, 0);
  assert.equal(context.state, 'suspended');
  engine.destroy();
  assert.equal(context.state, 'closed');
});

// Removing the tuning revision guard would allow the late A decode to play.
test('rapid file tuning never starts an obsolete decode', async () => {
  const engine = setup();
  await engine.start();
  const context = FakeAudioContext.instances[0];
  const first = engine.setStation(fileStation('A'), 1);
  await flush();
  const second = engine.setStation(fileStation('B'), 1);
  await flush();
  assert.equal(context.decodes.length, 2);
  context.decodes[1].resolve({ decoded: 'B', duration: 10 });
  await second;
  context.decodes[0].resolve({ decoded: 'A', duration: 10 });
  await first;
  assert.deepEqual(playingFiles(context).map(node => node.buffer.decoded), ['B']);
  engine.destroy();
});

// Starting a file after stop, losing its offset, or decoding twice breaks this contract.
test('file playback pauses on stop and resumes from its position after tuning back', async () => {
  const engine = setup();
  await engine.start();
  const context = FakeAudioContext.instances[0];
  const station = fileStation('field tape');
  const pending = engine.setStation(station, 0.8);
  await flush();
  engine.stop();
  context.decodes[0].resolve({ decoded: 'field tape', duration: 10 });
  await pending;
  assert.equal(playingFiles(context).length, 0);
  await engine.start();
  assert.equal(playingFiles(context).length, 1);
  context.currentTime = 2.5;
  await engine.setStation(null, 0);
  assert.equal(playingFiles(context).length, 0);
  await engine.setStation(station, 0.8);
  assert.equal(playingFiles(context)[0].offset, 2.5);
  assert.equal(context.decodes.length, 1);
  const resumed = playingFiles(context)[0];
  engine.stop();
  await engine.start();
  assert.equal(playingFiles(context)[0], resumed);
  engine.destroy();
});

// Empty or disabled stations must never consume a playable source.
test('empty file and disabled stations remain static only', async () => {
  const engine = setup();
  await engine.start();
  const context = FakeAudioContext.instances[0];
  await engine.setStation(fileStation('empty', new Blob([])), 1);
  assert.equal(context.decodes.length, 0);
  await engine.setStation({ ...synthStation(), enabled: false }, 1);
  assert.equal(context.nodes.filter(node => node.kind === 'source' && node.active).length, 1);
  engine.setVolume(-1);
  assert.equal(master(context).gain.value, 0);
  engine.setVolume(2);
  assert.ok(master(context).gain.value > 0 && master(context).gain.value <= 1);
  engine.destroy();
});

// Decode rejection must settle without silencing the usable static receiver.
test('invalid file data falls back to static and reports a recoverable error', async () => {
  const engine = setup();
  await engine.start();
  const context = FakeAudioContext.instances[0];
  const pending = engine.setStation(fileStation('bad'), 1);
  await flush();
  context.decodes[0].reject(new Error('not audio'));
  await pending;
  assert.equal(playingFiles(context).length, 0);
  assert.equal(engine.isStarted, true);
  assert.equal(typeof engine.error, 'string');
  assert.ok(engine.error.length > 0);
  await engine.setStation(synthStation('beacon'), 1);
  assert.equal(engine.error, null);
  engine.destroy();
});

test('unsupported browsers return a readable error without throwing', async () => {
  const engine = setup();
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  assert.equal(await engine.start(), false);
  assert.equal(engine.isStarted, false);
  assert.equal(typeof engine.error, 'string');
  engine.destroy();
});

// Broken strength routing, forgotten noise updates, and retuning restarts fail here.
test('strength crossfades signal and static while same-station updates keep playback', async () => {
  const engine = setup();
  await engine.start();
  const context = FakeAudioContext.instances[0];
  const station = synthStation();
  await engine.setStation(station, 0);
  const signal = context.nodes.filter(node => node.kind === 'source').at(-1);
  const signalGain = signal.connections[0].gain;
  const staticGain = context.nodes.find(node => node.kind === 'source').connections[0].connections[0].gain;
  assert.equal(signalGain.value, 0);
  const fullStatic = staticGain.value;
  assert.ok(fullStatic > 0);
  await engine.setStation(station, 0.25);
  const weakSignal = signalGain.value;
  assert.ok(weakSignal > 0);
  assert.ok(staticGain.value > 0 && staticGain.value < fullStatic);
  await engine.setStation(station, 1);
  assert.ok(signalGain.value > weakSignal);
  assert.equal(staticGain.value, 0);
  assert.equal(context.nodes.filter(node => node.kind === 'source').at(-1), signal);
  await engine.setStation(null, 0);
  engine.setNoise(0);
  assert.equal(staticGain.value, 0);
  engine.setNoise(1);
  assert.ok(staticGain.value > fullStatic);
  engine.destroy();
});

// A late startup continuation must not unmute after a newer stop request.
test('stop during startup cancels the pending start', async () => {
  const engine = setup();
  const starting = engine.start();
  engine.stop();
  assert.equal(await starting, false);
  const context = FakeAudioContext.instances[0];
  assert.equal(engine.isStarted, false);
  assert.equal(master(context).gain.value, 0);
  assert.equal(context.state, 'suspended');
  engine.destroy();
});

// A stale failure must not replace the state of a newer, playable station.
test('obsolete file errors cannot overwrite the newly tuned station', async () => {
  const engine = setup();
  await engine.start();
  const context = FakeAudioContext.instances[0];
  const stale = engine.setStation(fileStation('broken'), 1);
  await flush();
  await engine.setStation(synthStation('morse'), 1);
  context.decodes[0].reject(new Error('old decode failed'));
  await stale;
  assert.equal(engine.error, null);
  assert.equal(context.nodes.filter(node => node.kind === 'source' && node.active).length, 2);
  engine.destroy();
});

test('all synthetic transmissions contain bounded audible samples and keyed ones have gaps', async () => {
  const engine = setup();
  await engine.start();
  const context = FakeAudioContext.instances[0];
  for (const type of ['tone', 'beacon', 'morse']) {
    await engine.setStation(synthStation(type), 1);
    const source = context.nodes.filter(node => node.kind === 'source' && node.active).at(-1);
    const data = source.buffer.getChannelData(0);
    let peak = 0;
    let silent = 0;
    for (const sample of data) {
      assert.ok(Number.isFinite(sample));
      peak = Math.max(peak, Math.abs(sample));
      if (Math.abs(sample) < 0.00001) silent += 1;
    }
    assert.ok(peak > 0.1 && peak < 0.5);
    if (type !== 'tone') assert.ok(silent / data.length > 0.4);
  }
  engine.destroy();
});
