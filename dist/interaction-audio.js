const clamp = value => Number.isFinite(Number(value)) ? Math.min(1, Math.max(0, Number(value))) : 0;
const taps = {
  click: [0.035, 1180, 900, 145],
  tune: [0.023, 1580, 1240, 180],
  'power-on': [0.074, 520, 880, 76],
  'power-off': [0.062, 820, 450, 83]
};

function tapBuffer(context, kind) {
  const [duration, from, to, decay] = taps[kind];
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = from * 7919;
  for (let index = 1; index < data.length - 1; index += 1) {
    const time = index / context.sampleRate;
    const edge = Math.min(1, time / 0.0008, (data.length - 1 - index) / (context.sampleRate * 0.004));
    const phase = 2 * Math.PI * (from * time + (to - from) * time * time / (2 * duration));
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const noise = (seed >>> 0) / 2147483648 - 1;
    const body = 0.7 * Math.sin(phase) + 0.2 * Math.sin(phase * 2.17);
    // A very low, damped resonant body with a tiny initial mechanical transient.
    data[index] = 0.045 * edge * Math.exp(-time * decay) * (body + 0.1 * noise * Math.exp(-time * 600));
  }
  return buffer;
}

/** Independent button feedback. Call play() directly from a user gesture. */
export class InteractionAudio {
  constructor() {
    this._context = null;
    this._master = null;
    this._voice = null;
    this._buffers = new Map();
    this._volume = 0.35;
    this._enabled = true;
    this._destroyed = false;
    this._revision = 0;
    this._lastPlayedAt = -Infinity;
  }

  /** Resolves true only when a tap starts; unavailable or throttled taps are false. */
  async play(kind = 'click') {
    if (this._destroyed || !this._enabled || this._volume === 0) return false;
    const revision = ++this._revision;
    try {
      // Creation and resume stay in the gesture's synchronous call stack.
      if (!this._context) {
        const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContextClass) return false;
        this._context = new AudioContextClass();
        this._master = this._context.createGain();
        this._master.gain.value = this._volume;
        this._master.connect(this._context.destination);
      }
      const context = this._context;
      if (context.state !== 'running') await context.resume();
      if (revision !== this._revision || this._destroyed || !this._enabled || this._volume === 0) return false;
      if (context.currentTime - this._lastPlayedAt < 0.018) return false;

      const sound = Object.hasOwn(taps, kind) ? kind : 'click';
      if (!this._buffers.has(sound)) this._buffers.set(sound, tapBuffer(context, sound));
      this._stopVoice();
      const voice = context.createBufferSource();
      this._voice = voice;
      voice.buffer = this._buffers.get(sound);
      voice.onended = () => {
        voice.disconnect();
        voice.onended = null;
        if (this._voice === voice) this._voice = null;
      };
      voice.connect(this._master);
      this._master.gain.value = this._volume;
      voice.start();
      this._lastPlayedAt = context.currentTime;
      return true;
    } catch {
      if (revision === this._revision) this._stopVoice();
      return false;
    }
  }

  setVolume(value) {
    this._volume = clamp(value);
    if (this._volume === 0) this._cancel();
    else if (this._master) this._master.gain.value = this._enabled ? this._volume : 0;
  }

  setEnabled(value) {
    this._enabled = Boolean(value);
    if (!this._enabled) this._cancel();
    else if (this._master) this._master.gain.value = this._volume;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._cancel();
    this._master?.disconnect();
    try { this._context?.close().catch(() => {}); } catch {}
    this._buffers.clear();
    this._context = null;
    this._master = null;
  }

  _cancel() {
    this._revision += 1;
    this._lastPlayedAt = -Infinity;
    if (this._master) this._master.gain.value = 0;
    this._stopVoice();
  }

  _stopVoice() {
    const voice = this._voice;
    if (!voice) return;
    this._voice = null;
    voice.onended = null;
    try { voice.stop(); } catch {}
    voice.disconnect();
  }
}
