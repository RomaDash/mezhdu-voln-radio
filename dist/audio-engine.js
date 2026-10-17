// All demo transmissions are generated locally. No network audio is requested.
const clamp = value => Number.isFinite(Number(value)) ? Math.min(1, Math.max(0, Number(value))) : 0;
const supportedTypes = new Set(['beacon', 'morse', 'tone', 'file']);

function sameStation(a, b) {
  return a === b || (!!a && !!b && ['id', 'type', 'file', 'loop', 'frequency', 'name'].every(key => a[key] === b[key]));
}

function syntheticBuffer(context, station) {
  const unit = 0.12;
  // SOS: three dots, three dashes, three dots; the remaining loop is silence.
  const morse = [1, 1, 1, 3, 3, 3, 1, 1, 1];
  const windows = [];
  let cursor = 0.16;
  if (station.type === 'morse') {
    morse.forEach((length, index) => {
      windows.push([cursor, cursor + length * unit]);
      cursor += length * unit + ((index === 2 || index === 5) ? unit * 3 : unit);
    });
  } else if (station.type === 'beacon') {
    windows.push([0.12, 0.4], [0.65, 0.93], [1.3, 2.12]);
  } else {
    windows.push([0, 4]);
  }
  const duration = station.type === 'morse' ? cursor + 1.2 : 4;
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
  const data = buffer.getChannelData(0);
  const pitch = station.type === 'morse' ? 720 : 390 + (Math.abs(Number(station.frequency) || 0) * 7 % 190);
  for (let index = 0; index < data.length; index += 1) {
    const time = index / context.sampleRate;
    const window = windows.find(([from, to]) => time >= from && time < to);
    if (!window) continue;
    const edge = Math.min(1, (time - window[0]) / 0.008, (window[1] - time) / 0.008);
    const carrier = Math.sin(2 * Math.PI * pitch * time) + 0.13 * Math.sin(2 * Math.PI * pitch * 2 * time);
    data[index] = carrier * edge * 0.38;
  }
  return buffer;
}

/**
 * A local Web Audio receiver. Call start() directly from a user gesture.
 * stop()/start() suspend/resume the context, retaining exact playback position.
 * Tuning away stores a file's position by station ID + Blob identity; returning
 * resumes it. Replacing the Blob starts the replacement at the beginning.
 */
export class RadioAudio {
  constructor() {
    this._context = null;
    this._analyser = null;
    this._master = null;
    this._noiseSource = null;
    this._noiseGain = null;
    this._signalGain = null;
    this._active = null;
    this._station = null;
    this._strength = 0;
    this._volume = 0.16;
    this._noise = 0.55;
    this._started = false;
    this._destroyed = false;
    this._revision = 0;
    this._runRevision = 0;
    this._pending = null;
    this._pendingRevision = -1;
    this._files = new WeakMap();
    this._positions = new Map();
    this._synths = new Map();
    this.error = null;
  }

  get analyser() { return this._analyser; }
  get isStarted() { return this._started; }

  async start() {
    if (this._destroyed) return false;
    try {
      if (!this._context) {
        const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContextClass) {
          this.error = 'Этот браузер не поддерживает Web Audio. Откройте приёмник в современном браузере.';
          return false;
        }
        this._createGraph(new AudioContextClass());
      }
      this._started = true;
      const runRevision = ++this._runRevision;
      await this._context.resume();
      if (!this._started || runRevision !== this._runRevision) return false;
      this._setParam(this._master.gain, this._volume);
      if (!this._active) await this._activate(this._revision);
      return this._started && runRevision === this._runRevision;
    } catch {
      this._started = false;
      if (this._master) this._setParam(this._master.gain, 0, true);
      this.error = 'Не удалось включить звук. Нажмите кнопку питания ещё раз.';
      return false;
    }
  }

  stop() {
    this._started = false;
    this._runRevision += 1;
    if (!this._context) return;
    this._setParam(this._master.gain, 0, true);
    // Suspended context time does not advance, so real files pause as well.
    this._context.suspend().catch(() => {});
  }

  setVolume(value) {
    this._volume = clamp(value);
    if (this._master) this._setParam(this._master.gain, this._started ? this._volume : 0);
  }

  setNoise(value) {
    this._noise = clamp(value);
    this._updateMix();
  }

  async setStation(station, strength = 0) {
    if (this._destroyed) return;
    this._strength = clamp(strength);
    const next = station && station.enabled !== false && supportedTypes.has(station.type)
      ? { id: station.id, name: station.name, frequency: station.frequency, type: station.type, file: station.file, loop: station.loop !== false }
      : null;
    if (sameStation(next, this._station)) {
      this._updateMix();
      if (this._started && !this._active) await this._activate(this._revision);
      return;
    }
    this._revision += 1;
    this._releaseActive();
    this._station = next;
    this.error = null;
    this._updateMix();
    if (this._started) await this._activate(this._revision);
  }

  destroy() {
    if (this._destroyed) return;
    this.stop();
    this._destroyed = true;
    this._revision += 1;
    this._releaseActive();
    if (this._noiseSource) this._noiseSource.stop();
    if (this._context) this._context.close().catch(() => {});
    this._files = new WeakMap();
    this._positions.clear();
    this._synths.clear();
  }

  _createGraph(context) {
    this._context = context;
    this._master = context.createGain();
    this._master.gain.value = 0;
    this._analyser = context.createAnalyser();
    this._analyser.fftSize = 1024;
    this._analyser.smoothingTimeConstant = 0.8;
    this._master.connect(this._analyser);
    this._analyser.connect(context.destination);

    this._signalGain = context.createGain();
    this._signalGain.gain.value = 0;
    const signalFilter = context.createBiquadFilter();
    signalFilter.type = 'bandpass';
    signalFilter.frequency.value = 1450;
    signalFilter.Q.value = 0.55;
    this._signalGain.connect(signalFilter);
    signalFilter.connect(this._master);

    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
    this._noiseSource = context.createBufferSource();
    this._noiseSource.buffer = buffer;
    this._noiseSource.loop = true;
    const noiseFilter = context.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 1800;
    noiseFilter.Q.value = 0.6;
    this._noiseGain = context.createGain();
    this._noiseSource.connect(noiseFilter);
    noiseFilter.connect(this._noiseGain);
    this._noiseGain.connect(this._master);
    this._updateMix();
    this._noiseSource.start();
  }

  _setParam(parameter, value, immediate = false) {
    const now = this._context.currentTime;
    parameter.cancelScheduledValues(now);
    if (immediate) parameter.setValueAtTime(value, now);
    else parameter.setTargetAtTime(value, now, 0.035);
  }

  _updateMix() {
    if (!this._noiseGain) return;
    const strength = this._active ? this._strength : 0;
    this._setParam(this._signalGain.gain, Math.sqrt(strength) * 0.5);
    this._setParam(this._noiseGain.gain, Math.sqrt(1 - strength) * this._noise * 0.34);
  }

  async _decode(file) {
    if (!this._files.has(file)) {
      const pending = file.arrayBuffer().then(bytes => new Promise((resolve, reject) => {
        // Callback plus Promise forms cover older webkitAudioContext as well.
        const result = this._context.decodeAudioData(bytes, resolve, reject);
        if (result && typeof result.then === 'function') result.then(resolve, reject);
      })).catch(error => {
        this._files.delete(file);
        throw error;
      });
      this._files.set(file, pending);
    }
    return this._files.get(file);
  }

  async _activate(revision) {
    const station = this._station;
    if (!station || !this._started || this._active || this._destroyed) return;
    if (this._pending && this._pendingRevision === revision) return this._pending;
    this._pendingRevision = revision;
    const task = (async () => {
      try {
        let buffer;
        if (station.type === 'file') {
          if (!station.file || !station.file.size || typeof station.file.arrayBuffer !== 'function') return;
          buffer = await this._decode(station.file);
        } else {
          const key = `${station.type}:${station.frequency}`;
          if (!this._synths.has(key)) {
            if (this._synths.size >= 16) this._synths.delete(this._synths.keys().next().value);
            this._synths.set(key, syntheticBuffer(this._context, station));
          }
          buffer = this._synths.get(key);
        }
        if (revision !== this._revision || !this._started || this._destroyed) return;
        const source = this._context.createBufferSource();
        source.buffer = buffer;
        source.loop = station.loop;
        source.connect(this._signalGain);
        const saved = this._positions.get(station.id);
        const offset = station.type === 'file' && saved?.file === station.file && saved.offset < buffer.duration ? saved.offset : 0;
        this._active = { source, station, buffer, offset, startedAt: this._context.currentTime };
        source.onended = () => {
          if (this._active?.source !== source) return;
          this._active = null;
          this._positions.delete(station.id);
          source.disconnect();
          this._updateMix();
        };
        source.start(0, offset);
        this.error = null;
        this._updateMix();
      } catch {
        if (revision === this._revision && !this._destroyed) {
          this.error = 'Не удалось прочитать аудиофайл. Выберите другой файл для этой станции.';
          this._updateMix();
        }
      }
    })();
    this._pending = task;
    try { await task; }
    finally { if (this._pending === task) this._pending = null; }
  }

  _releaseActive() {
    if (!this._active) return;
    const { source, station, buffer, offset, startedAt } = this._active;
    this._active = null;
    if (station.type === 'file' && buffer.duration > 0) {
      const elapsed = offset + Math.max(0, this._context.currentTime - startedAt);
      this._positions.set(station.id, { file: station.file, offset: station.loop ? elapsed % buffer.duration : elapsed < buffer.duration ? elapsed : 0 });
    }
    source.onended = null;
    source.stop();
    source.disconnect();
  }
}
