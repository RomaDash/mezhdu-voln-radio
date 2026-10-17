import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dist/interaction-audio.js', import.meta.url), 'utf8').catch(() => '');
const { InteractionAudio } = source ? await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) : {};

// Node has no Web Audio device. Keep the browser boundary fake while testing
// the real generated samples, graph routing and asynchronous cancellation.
class FakeAudioContext {
  static instances = [];
  static deferResume = false;
  static rejectResume = false;

  constructor() {
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.state = 'suspended';
    this.nodes = [];
    this.resumeCalls = 0;
    this.destination = {};
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    const node = this.node('gain');
    node.gain = { value: 1 };
    return node;
  }

  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / sampleRate, getChannelData: index => data[index] };
  }

  createBufferSource() {
    const node = this.node('source');
    node.stopCalls = 0;
    node.start = () => { node.active = true; };
    node.finish = () => { node.active = false; node.onended?.(); };
    node.stop = () => { node.stopCalls += 1; node.finish(); };
    return node;
  }

  node(kind) {
    const node = {
      kind, connections: [],
      connect(next) { this.connections.push(next); return next; },
      disconnect() { this.connections = []; }
    };
    this.nodes.push(node);
    return node;
  }

  resume() {
    this.resumeCalls += 1;
    if (FakeAudioContext.rejectResume) return Promise.reject(new Error('audio unavailable'));
    if (FakeAudioContext.deferResume) {
      return new Promise(resolve => {
        this.resolveResume = () => {
          if (this.state !== 'closed') this.state = 'running';
          resolve();
        };
      });
    }
    this.state = 'running';
    return Promise.resolve();
  }

  async close() { this.state = 'closed'; }
}

function setup(t, options = {}) {
  assert.equal(typeof InteractionAudio, 'function', 'InteractionAudio must expose the button sound lifecycle');
  const original = globalThis.AudioContext;
  const originalWebkit = globalThis.webkitAudioContext;
  FakeAudioContext.instances = [];
  FakeAudioContext.deferResume = options.deferResume ?? false;
  FakeAudioContext.rejectResume = options.rejectResume ?? false;
  globalThis.AudioContext = FakeAudioContext;
  delete globalThis.webkitAudioContext;
  const engine = new InteractionAudio();
  t.after(() => {
    engine.destroy();
    if (original === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = original;
    if (originalWebkit === undefined) delete globalThis.webkitAudioContext;
    else globalThis.webkitAudioContext = originalWebkit;
  });
  return engine;
}

const sources = context => context.nodes.filter(node => node.kind === 'source');
const active = context => sources(context).filter(node => node.active);
const gain = context => context.nodes.find(node => node.kind === 'gain').gain;

// Eager construction or ignoring a pre-start mute would consume an audio device.
test('muted controls do not initialize audio before an audible play request', async t => {
  const engine = setup(t);
  engine.setEnabled(false);
  assert.equal(await engine.play(), false);
  engine.setEnabled(true);
  engine.setVolume(0);
  assert.equal(await engine.play(), false);
  assert.equal(FakeAudioContext.instances.length, 0);
  engine.setVolume(0.5);
  const playing = engine.play();
  assert.equal(FakeAudioContext.instances.length, 1, 'construction must happen directly inside play');
  const context = FakeAudioContext.instances[0];
  assert.equal(context.resumeCalls, 1, 'resume must happen before leaving the gesture stack');
  assert.equal(await playing, true);
  assert.equal(active(context).length, 1);
});

// Reusing or resuming the receiver context would affect radio playback.
test('button playback owns a context separate from any existing radio context', async t => {
  const engine = setup(t);
  const radioContext = new FakeAudioContext();
  assert.equal(await engine.play('tune'), true);
  assert.equal(FakeAudioContext.instances.length, 2);
  assert.equal(radioContext.resumeCalls, 0);
  assert.equal(radioContext.nodes.length, 0);
  assert.equal(radioContext.state, 'suspended');
  engine.destroy();
  assert.equal(radioContext.state, 'suspended');
});

// A looping, long, silent, clipped or identical buffer violates the tap contract.
test('each button sound is a distinct short quiet tap with silent edges', async t => {
  const engine = setup(t);
  engine.setVolume(1);
  const signatures = [];
  for (const kind of ['click', 'tune', 'power-on', 'power-off']) {
    if (FakeAudioContext.instances[0]) FakeAudioContext.instances[0].currentTime += 0.1;
    assert.equal(await engine.play(kind), true);
    const context = FakeAudioContext.instances[0];
    const voice = active(context)[0];
    const data = voice.buffer.getChannelData(0);
    assert.ok(voice.buffer.duration >= 0.02 && voice.buffer.duration <= 0.09);
    assert.ok(!voice.loop);
    assert.equal(data[0], 0);
    assert.ok(Math.abs(data.at(-1)) < 0.00001);
    let peak = 0;
    for (const sample of data) {
      assert.ok(Number.isFinite(sample));
      peak = Math.max(peak, Math.abs(sample));
    }
    assert.ok(peak > 0.005 && peak <= 0.06, `bounded audible peak for ${kind}`);
    signatures.push(Array.from(data.slice(0, 80)).join(','));
  }
  assert.equal(new Set(signatures).size, 4);
});

// Removing volume clamping or its routing changes the audible output level.
test('volume scales the output and clamps to the supported range', async t => {
  const engine = setup(t);
  engine.setVolume(0.25);
  await engine.play();
  const context = FakeAudioContext.instances[0];
  assert.equal(gain(context).value, 0.25);
  engine.setVolume(2);
  assert.equal(gain(context).value, 1);
  engine.setVolume(-1);
  assert.equal(gain(context).value, 0);
  assert.equal(active(context).length, 0);
  assert.equal(await engine.play(), false);
});

// A disable must stop the current tap, rather than just suppress future taps.
test('disabling immediately cancels the active tap', async t => {
  const engine = setup(t);
  await engine.play();
  const context = FakeAudioContext.instances[0];
  const voice = active(context)[0];
  engine.setEnabled(false);
  assert.equal(active(context).length, 0);
  assert.equal(voice.connections.length, 0);
  assert.equal(gain(context).value, 0);
  assert.equal(await engine.play(), false);
  context.currentTime += 0.1;
  engine.setEnabled(true);
  assert.equal(await engine.play(), true);
});

// Missing revision invalidation would resurrect a tap after the mute is reversed.
for (const control of ['volume', 'enabled', 'destroy']) {
  test(`${control} cancels an unresolved resume permanently`, async t => {
    const engine = setup(t, { deferResume: true });
    const pending = engine.play('power-on');
    const context = FakeAudioContext.instances[0];
    if (control === 'volume') { engine.setVolume(0); engine.setVolume(0.5); }
    if (control === 'enabled') { engine.setEnabled(false); engine.setEnabled(true); }
    if (control === 'destroy') engine.destroy();
    context.resolveResume();
    assert.equal(await pending, false);
    assert.equal(active(context).length, 0);
    if (control === 'destroy') {
      assert.equal(context.state, 'closed');
      assert.equal(await engine.play(), false);
      assert.equal(FakeAudioContext.instances.length, 1);
    }
  });
}

// Unbounded sources would stack gain and retain many simultaneous clicks.
test('rapid clicks are throttled with at most one active voice', async t => {
  const engine = setup(t);
  await engine.play();
  const context = FakeAudioContext.instances[0];
  for (let index = 0; index < 60; index += 1) {
    context.currentTime += 0.001;
    await engine.play('tune');
    assert.ok(active(context).length <= 1);
  }
  assert.ok(sources(context).length <= 4);
  context.currentTime += 0.1;
  assert.equal(await engine.play(), true);
});

// Retaining an ended source causes redundant stops and leaked graph connections.
test('finished taps disconnect and are released before destruction', async t => {
  const engine = setup(t);
  await engine.play();
  const context = FakeAudioContext.instances[0];
  const voice = active(context)[0];
  voice.finish();
  assert.equal(voice.connections.length, 0);
  engine.destroy();
  assert.equal(voice.stopCalls, 0);
  assert.equal(context.nodes.find(node => node.kind === 'gain').connections.length, 0);
  assert.equal(context.state, 'closed');
});

// Audio availability must never turn a button press into an uncaught rejection.
test('unsupported browsers safely decline playback', async t => {
  const engine = setup(t);
  delete globalThis.AudioContext;
  assert.equal(await engine.play(), false);
  assert.equal(FakeAudioContext.instances.length, 0);
});

test('resume rejection safely declines playback', async t => {
  const engine = setup(t, { rejectResume: true });
  assert.equal(await engine.play(), false);
  assert.equal(active(FakeAudioContext.instances[0]).length, 0);
});
