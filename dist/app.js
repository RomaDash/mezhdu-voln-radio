import { RadioAudio } from './audio-engine.js';
import { DEFAULT_STATIONS, MIN_FREQUENCY, MAX_FREQUENCY, clampFrequency, getReception, validateStation, loadStations, saveStations } from './stations.js';

const $ = id => document.getElementById(id);
const audio = new RadioAudio();
let frequency = 96;
let stations = DEFAULT_STATIONS.map(station => ({ ...station }));
let powered = false;
let starting = false;
let powerRevision = 0;
let playerMode = false;
let editId = null;
let selectedFile = null;
let credits = [];
let toastTimer;
let saveQueue = Promise.resolve();
let lastAudioError = null;
let initialized = false;
let waveformFrame = 0;
let waveformData = null;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

for (let i = 0; i <= 80; i += 1) {
  const tick = document.createElement('i');
  if (i % 4 === 0) tick.className = 'major';
  $('scale-ticks').append(tick);
}

function announce(message, error = false, undo = null) {
  clearTimeout(toastTimer);
  const toast = $('toast');
  toast.replaceChildren(document.createTextNode(message));
  toast.dataset.error = String(error);
  if (undo) {
    const button = document.createElement('button');
    button.className = 'toast-undo';
    button.textContent = 'Вернуть';
    button.addEventListener('click', () => { undo(); toast.hidden = true; });
    toast.append(document.createTextNode(' '), button);
  }
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 9000 : undo ? 10000 : 4500);
}

function currentReception() {
  return getReception(frequency, stations.filter(station => station.type !== 'file' || station.file));
}

function updateReception() {
  const reception = currentReception();
  const strength = powered ? reception.strength : 0;
  const status = !powered ? 'Эфир ждёт' : strength > .88 ? 'Сигнал пойман' : strength > .1 ? 'Ловим сигнал' : 'Между станциями';
  $('signal-status').textContent = status;
  $('signal-meter').setAttribute('aria-valuenow', String(Math.round(strength * 100)));
  [...$('signal-meter').children].forEach((bar, index) => bar.classList.toggle('lit', index < Math.round(strength * 12)));
  $('waveform-caption').textContent = !powered ? 'Включи приёмник, чтобы услышать эфир' : strength > .88 ? 'Частота настроена. Слушай.' : strength > .1 ? 'Сигнал рядом. Настраивай точнее.' : 'Вслушивайся. В эфире что-то есть.';
  if (powered) audio.setStation(reception.station, reception.strength).then(() => {
    if (audio.error && audio.error !== lastAudioError) {
      lastAudioError = audio.error;
      announce(playerMode ? 'Сигнал теряется. Попробуй настроить приёмник ещё раз.' : audio.error, true);
    }
    if (!audio.error) lastAudioError = null;
  });
  drawWaveform();
}

function tune(value) {
  frequency = clampFrequency(value);
  const text = frequency.toFixed(1);
  $('frequency').value = String(frequency);
  $('frequency').setAttribute('aria-valuetext', `${text} мегагерц`);
  $('frequency-value').textContent = text;
  $('tuning-knob').setAttribute('aria-valuenow', String(frequency));
  $('tuning-knob').setAttribute('aria-valuetext', `${text} мегагерц`);
  const progress = (frequency - MIN_FREQUENCY) / (MAX_FREQUENCY - MIN_FREQUENCY);
  $('frequency-needle').style.left = `${progress * 100}%`;
  $('knob-marker').style.transform = `rotate(${-135 + progress * 270}deg)`;
  updateReception();
}

$('frequency').addEventListener('input', event => tune(Number(event.target.value)));
$('frequency-down').addEventListener('click', () => tune(frequency - .1));
$('frequency-up').addEventListener('click', () => tune(frequency + .1));
$('tuning-knob').addEventListener('keydown', event => {
  const values = { ArrowUp: frequency + .1, ArrowRight: frequency + .1, ArrowDown: frequency - .1, ArrowLeft: frequency - .1, Home: MIN_FREQUENCY, End: MAX_FREQUENCY, PageUp: frequency + 1, PageDown: frequency - 1 };
  if (!(event.key in values)) return;
  event.preventDefault();
  tune(values[event.key]);
});

let drag = null;
$('tuning-knob').addEventListener('pointerdown', event => {
  if (drag || !event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, frequency };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.focus({ preventScroll: true });
});
$('tuning-knob').addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.id) return;
  tune(drag.frequency + ((event.clientX - drag.x) - (event.clientY - drag.y)) * .035);
});
function releaseKnob(event) { if (drag?.id === event.pointerId) drag = null; }
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => $('tuning-knob').addEventListener(name, releaseKnob));

function renderPower() {
  $('radio').dataset.powered = String(powered || starting);
  $('power-button').setAttribute('aria-pressed', String(powered || starting));
  $('power-label').textContent = powered || starting ? 'Выключить приёмник' : 'Включить приёмник';
  $('hardware-state').textContent = starting ? 'Ловим эфир…' : powered ? 'Питание включено' : 'Питание выключено';
  updateReception();
}

$('power-button').addEventListener('click', async () => {
  if (!initialized) return announce('Эфир загружается. Ещё мгновение.');
  const revision = ++powerRevision;
  if (powered || starting) {
    powered = false;
    starting = false;
    audio.stop();
    renderPower();
  } else {
    starting = true;
    const reception = currentReception();
    // start() is invoked synchronously inside the user gesture, before any await.
    const started = audio.start();
    renderPower();
    await audio.setStation(reception.station, reception.strength);
    const success = await started;
    if (revision !== powerRevision) return;
    powered = success;
    starting = false;
    if (!powered) announce(audio.error || 'Не удалось включить звук. Нажми ещё раз.', true);
    renderPower();
  }
});

for (const id of ['volume', 'noise']) {
  $(id).addEventListener('input', event => {
    const value = Number(event.target.value);
    $(`${id}-value`).textContent = `${value}%`;
    if (id === 'volume') audio.setVolume(value / 100 * .5);
    else audio.setNoise(value / 100);
  });
}
audio.setVolume(.175);
audio.setNoise(.45);

function drawWaveform() {
  cancelAnimationFrame(waveformFrame);
  const canvas = $('waveform');
  if (!canvas.clientWidth) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  }
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = powered ? '#bfc69d' : '#687661';
  context.lineWidth = 1;
  context.beginPath();
  const analyser = audio.analyser;
  if (powered && analyser && !reducedMotion.matches && !document.hidden) {
    if (!waveformData || waveformData.length !== analyser.fftSize) waveformData = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(waveformData);
    for (let x = 0; x < width; x += 1) {
      const sample = waveformData[Math.floor(x / width * waveformData.length)] / 128 - 1;
      const y = height / 2 + sample * height * 1.7;
      if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    waveformFrame = requestAnimationFrame(drawWaveform);
  } else { context.moveTo(0, height / 2); context.lineTo(width, height / 2); }
  context.stroke();
}
window.addEventListener('resize', drawWaveform);
document.addEventListener('visibilitychange', drawWaveform);
reducedMotion.addEventListener('change', drawWaveform);

function setPlayerMode(value) {
  playerMode = value;
  if (value && $('host-dialog').open) $('host-dialog').close();
  document.body.classList.toggle('player-mode', value);
  $('exit-player').hidden = !value;
  if (value) { $('toast').hidden = true; $('tuning-knob').focus({ preventScroll: true }); }
  else $('player-mode').focus({ preventScroll: true });
  drawWaveform();
}
$('player-mode').addEventListener('click', () => setPlayerMode(true));
$('host-player').addEventListener('click', () => setPlayerMode(true));
$('exit-player').addEventListener('click', () => setPlayerMode(false));
document.addEventListener('keydown', event => {
  document.body.classList.add('keyboard-input');
  if (event.key === 'Escape' && playerMode) setPlayerMode(false);
});
document.addEventListener('pointerdown', () => document.body.classList.remove('keyboard-input'));
$('dismiss-note').addEventListener('click', () => { $('first-run-note').hidden = true; });

function openHost() {
  renderStations();
  $('host-dialog').showModal();
  $('host-dialog').querySelector('.host-scroll').scrollTop = 0;
}
$('host-open').addEventListener('click', openHost);
$('host-close').addEventListener('click', () => $('host-dialog').close());
$('help-open').addEventListener('click', () => $('help-dialog').showModal());
['help-close', 'help-done'].forEach(id => $(id).addEventListener('click', () => $('help-dialog').close()));
for (const id of ['host-dialog', 'help-dialog']) {
  $(id).addEventListener('click', event => {
    if (event.target !== $(id)) return;
    const rect = $(id).getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $(id).close();
  });
}

function persist() {
  const snapshot = stations.map(station => ({ ...station }));
  const operation = saveQueue.catch(() => {}).then(() => saveStations(snapshot));
  saveQueue = operation;
  return operation.then(() => {
    $('storage-status').textContent = 'Сохранено в этом браузере';
    $('storage-status').classList.remove('storage-error');
    return true;
  }, () => {
    $('storage-status').textContent = 'Изменения не сохранены. Работают до перезагрузки.';
    $('storage-status').classList.add('storage-error');
    announce('Не удалось сохранить эфир. Освободи место в браузере или выбери файл поменьше и сохрани снова.', true);
    return false;
  });
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function renderStations() {
  const list = $('station-list');
  list.replaceChildren();
  if (stations.length === 0) {
    const empty = textElement('div', 'empty-stations', '');
    empty.append(textElement('strong', '', 'Пока только шум.'), textElement('p', '', 'Добавь первую передачу. Без записи тоже можно — подключишь её позже.'));
    list.append(empty);
  }
  for (const station of [...stations].sort((a, b) => a.frequency - b.frequency)) {
    const row = document.createElement('article'); row.className = 'station-row';
    const detail = document.createElement('div');
    const kinds = { beacon: 'Тестовый маяк', morse: 'Тестовый позывной', tone: 'Тестовый сигнал' };
    const kind = station.type === 'file' ? station.file ? station.genre || station.fileName || 'Аудиозапись' : 'Запись ещё не добавлена' : kinds[station.type];
    detail.append(textElement('span', 'station-frequency', `${station.frequency.toFixed(1)} МГц`), textElement('span', 'station-name', station.name), textElement('span', 'station-kind', kind));
    const actions = document.createElement('div'); actions.className = 'station-actions';
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'switch';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = station.enabled; toggle.setAttribute('aria-label', `Передача «${station.name}» включена`);
    toggle.addEventListener('change', async () => { station.enabled = toggle.checked; updateReception(); await persist(); });
    const track = document.createElement('span'); track.className = 'switch-track'; track.setAttribute('aria-hidden', 'true'); toggleLabel.append(toggle, track);
    const edit = textElement('button', 'plain-button', 'Изменить'); edit.type = 'button'; edit.setAttribute('aria-label', `Изменить передачу «${station.name}»`); edit.addEventListener('click', () => showForm(station));
    actions.append(toggleLabel, edit); row.append(detail, actions); list.append(row);
  }
}

function clearErrors() {
  for (const field of ['name', 'frequency', 'file']) { $(`${field}-error`).textContent = ''; $(`station-${field}`).removeAttribute('aria-invalid'); $(`station-${field}`).removeAttribute('aria-describedby'); }
}

function showForm(station = null) {
  editId = station?.id ?? null;
  selectedFile = station?.file ?? null;
  clearErrors();
  $('station-form').reset();
  $('form-title').textContent = station ? 'Изменить передачу' : 'Новая передача';
  $('station-name').value = station?.name || '';
  let available = 100;
  while (stations.some(item => Math.abs(item.frequency - available) < .05) && available < MAX_FREQUENCY) available = clampFrequency(available + .1);
  $('station-frequency').value = String(station?.frequency ?? available);
  $('station-type').value = station?.type || 'file';
  $('station-enabled').checked = station?.enabled ?? true;
  $('station-loop').checked = station?.loop ?? true;
  $('file-caption').textContent = station?.fileName || 'Выбрать аудиозапись';
  $('file-field').hidden = $('station-type').value !== 'file';
  $('station-form').hidden = false;
  $('station-add').hidden = true;
  const oldDelete = $('delete-station'); if (oldDelete) oldDelete.remove();
  if (station) {
    const remove = textElement('button', 'plain-button delete-station', 'Удалить передачу'); remove.id = 'delete-station'; remove.type = 'button';
    remove.addEventListener('click', async () => {
      const index = stations.findIndex(item => item.id === station.id);
      stations.splice(index, 1); closeForm(); renderStations(); updateReception();
      const saved = await persist();
      if (saved) announce('Передача удалена.', false, async () => { stations.splice(Math.min(index, stations.length), 0, station); renderStations(); updateReception(); await persist(); });
    });
    $('station-form').append(remove);
  }
  $('station-name').focus({ preventScroll: true });
  $('station-form').scrollIntoView({ block: 'start', behavior: 'instant' });
}

function closeForm() { $('station-form').hidden = true; $('station-add').hidden = false; editId = null; selectedFile = null; $('station-add').focus({ preventScroll: true }); }
$('station-add').addEventListener('click', () => showForm());
$('form-cancel').addEventListener('click', closeForm);
$('station-type').addEventListener('change', event => { $('file-field').hidden = event.target.value !== 'file'; });
$('station-file').addEventListener('change', event => {
  const file = event.target.files[0];
  $('file-error').textContent = '';
  if (!file) return;
  if (file.size === 0) { $('file-error').textContent = 'Этот файл пуст. Выбери запись со звуком.'; event.target.value = ''; return; }
  if (file.size > 30 * 1024 * 1024) { $('file-error').textContent = 'Файл больше 30 МБ. Выбери запись поменьше.'; event.target.value = ''; return; }
  if (!(file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name))) { $('file-error').textContent = 'Выбери аудиофайл: MP3, WAV, OGG или M4A.'; event.target.value = ''; return; }
  selectedFile = file;
  $('file-caption').textContent = file.name;
});

$('station-form').addEventListener('submit', async event => {
  event.preventDefault(); clearErrors();
  const previous = stations.find(station => station.id === editId);
  const station = { id: editId || (crypto.randomUUID ? crypto.randomUUID() : `station-${Date.now()}`), name: $('station-name').value.trim(), frequency: Number($('station-frequency').value), type: $('station-type').value, enabled: $('station-enabled').checked, loop: $('station-loop').checked, bandwidth: .65 };
  if (station.type === 'file' && selectedFile) { station.file = selectedFile; station.fileName = selectedFile.name || previous?.fileName || 'Аудиозапись'; }
  const validation = validateStation(station, stations, editId);
  if (!validation.valid) {
    for (const [field, error] of Object.entries(validation.errors)) { $(`${field}-error`).textContent = error; $(`station-${field}`).setAttribute('aria-invalid', 'true'); $(`station-${field}`).setAttribute('aria-describedby', `${field}-error`); }
    $(`station-${Object.keys(validation.errors)[0]}`).focus(); return;
  }
  station.frequency = clampFrequency(station.frequency);
  if (editId) stations[stations.findIndex(item => item.id === editId)] = station;
  else stations.push(station);
  const submit = $('station-form').querySelector('[type=submit]'); submit.disabled = true;
  updateReception(); renderStations();
  const saved = await persist();
  submit.disabled = false;
  if (saved) { closeForm(); announce('Передача сохранена. Эфир готов к игре.'); }
});

function renderCredits() {
  if (!credits.length) return;
  const section = document.createElement('section'); section.className = 'music-credits'; section.append(textElement('h3', '', 'Музыка в эфире'));
  for (const credit of credits) {
    const p = document.createElement('p');
    const link = document.createElement('a'); link.href = credit.sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `${credit.title} — ${credit.artist}`;
    const license = document.createElement('a'); license.href = credit.licenseUrl; license.target = '_blank'; license.rel = 'noopener noreferrer'; license.textContent = credit.license;
    p.append(link, document.createTextNode(' · '), license);
    if (credit.changes) p.append(document.createTextNode(' · Запись целиком. MP3 перекодирован в 160 кбит/с; обложка удалена.'));
    section.append(p);
  }
  $('host-dialog').querySelector('.host-bottom-note').append(section);
}

async function initialize() {
  let saved = null;
  try { saved = await loadStations(); } catch { $('storage-status').textContent = 'Хранилище недоступно. Изменения работают до перезагрузки.'; $('storage-status').classList.add('storage-error'); }
  try {
    const response = await fetch('./assets/music/credits.json');
    if (response.ok) credits = await response.json();
  } catch { /* The receiver also works with generated signals when no bundled music exists. */ }
  if (saved !== null) stations = saved;
  else if (credits.length) {
    const music = await Promise.all(credits.slice(0, 3).map(async (credit, index) => {
      try {
        const response = await fetch(`./assets/music/${credit.file}`);
        if (!response.ok) throw new Error('Music unavailable');
        const file = await response.blob();
        return { ...DEFAULT_STATIONS[index], name: credit.stationName || credit.title, type: 'file', file, fileName: credit.file, genre: credit.genre, example: true };
      } catch { return { ...DEFAULT_STATIONS[index] }; }
    }));
    stations = music;
  }
  if (credits.length) {
    const note = $('first-run-note').querySelector('p');
    note.replaceChildren(document.createTextNode('Музыка уже в эфире.'), textElement('span', '', ' Три станции разных настроений. Частоты — в пульте ведущего. Свои записи добавишь, когда придёт время.'));
  }
  renderCredits(); renderStations(); tune(frequency); initialized = true;
}

window.addEventListener('pagehide', () => { powerRevision += 1; audio.stop(); powered = false; starting = false; renderPower(); });
initialize().catch(() => { initialized = true; announce('Не удалось загрузить сохранённый эфир. Открой пульт и проверь передачи.', true); });
