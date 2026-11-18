const api = window.fastSamp;
const $ = (id) => document.getElementById(id);
const audio = $('audio');
const siteWell = $('site-well');
const canvas = $('waveform');
const seek = $('seek');
const sourceDialog = $('source-dialog');
const settingsDialog = $('settings-dialog');
const deleteDialog = $('delete-dialog');
const importZone = $('import-zone');
const jobs = new Map();
let library = [];
let selected = null;
let sourceTrack = null;
let sampleToDelete = null;
let readySample = null;
let audioSampleId = null;
let view = 'samplette';
let started = false;
let toastTimer;
let peekError = '';

function showToast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function syncSiteBounds() {
  if (!started) return;
  if (view !== 'samplette' || sourceDialog.open || settingsDialog.open) {
    void api.siteBounds(null);
    return;
  }
  const rect = siteWell.getBoundingClientRect();
  void api.siteBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}

function openView(nextView) {
  view = nextView;
  $('samplette').hidden = view !== 'samplette';
  $('library').hidden = view !== 'library';
  for (const button of document.querySelectorAll('.nav-button[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $('reload-site').hidden = view !== 'samplette';
  $('track-empty').textContent = view === 'samplette' ? 'Выбери трек в Samplette.' : 'Выбери сэмпл.';
  if (view === 'samplette') {
    audio.pause();
    selectSample(sourceTrack);
  }
  syncSiteBounds();
}

function timecode(seconds) {
  const value = Math.floor(Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(value / 3600);
  const mins = Math.floor(value / 60) % 60;
  const secs = String(value % 60).padStart(2, '0');
  return hours ? `${hours}:${String(mins).padStart(2, '0')}:${secs}` : `${mins}:${secs}`;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function sampleRow(item) {
  const row = document.createElement('div');
  row.className = 'sample-row';
  row.dataset.id = item.id;
  row.draggable = true;
  row.title = 'Перетащи строку в FL Studio';
  row.classList.toggle('selected', selected?.id === item.id);
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'row-main';
  select.addEventListener('click', () => selectSample(item));
  const art = document.createElement('div');
  art.className = 'row-art';
  art.append(icon('disc'));
  const copy = document.createElement('div');
  copy.className = 'row-copy';
  const title = document.createElement('strong');
  title.textContent = item.title;
  const artist = document.createElement('small');
  artist.textContent = item.artist;
  copy.append(title, artist);
  select.append(art, copy);
  const duration = document.createElement('span');
  duration.className = 'row-time';
  duration.textContent = timecode(item.duration);
  const remove = document.createElement('button');
  remove.className = 'row-delete';
  remove.type = 'button';
  remove.title = 'Удалить сэмпл';
  remove.setAttribute('aria-label', `Удалить сэмпл ${item.title}`);
  remove.append(icon('trash'));
  remove.addEventListener('click', () => {
    sampleToDelete = item;
    $('delete-name').textContent = item.title;
    $('delete-error').hidden = true;
    openDialog(deleteDialog);
  });
  row.addEventListener('dragstart', (event) => {
    event.preventDefault();
    api.dragSample(item.id);
  });
  row.append(select, duration, remove);
  return row;
}

function renderRows(container, list, emptyMessage) {
  if (list.length) {
    container.replaceChildren(...list.map(sampleRow));
  } else {
    const empty = document.createElement('p');
    empty.className = 'empty-library';
    empty.textContent = emptyMessage;
    container.replaceChildren(empty);
  }
}

function renderLibrarySearch() {
  const search = $('library-search').value.trim().toLocaleLowerCase('ru');
  const matches = library.filter((item) => `${item.title} ${item.artist}`.toLocaleLowerCase('ru').includes(search));
  renderRows($('all-samples'), matches, search ? 'Сэмплы не найдены.' : 'Скачанных сэмплов пока нет.');
}

function drawWave() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  const pixelsWide = Math.round(width * scale);
  const pixelsHigh = Math.round(height * scale);
  if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
    canvas.width = pixelsWide;
    canvas.height = pixelsHigh;
  }
  const context = canvas.getContext('2d');
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  const peaks = readySample?.peaks;
  const bars = Math.max(1, Math.floor(width / 3.5));
  const progress = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
  const maximum = peaks ? Math.max(0.1, ...peaks) : 1;
  for (let bar = 0; bar < bars; bar++) {
    const from = bar / bars;
    const peak = peaks ? peaks[Math.min(peaks.length - 1, Math.floor(from * peaks.length))] / maximum : 0;
    const length = 2 + Math.pow(peak, 0.82) * (height - 4);
    context.fillStyle = from < progress ? '#f609cf' : '#929292';
    context.fillRect(Math.floor(from * width), (height - length) / 2, 2, length);
  }
}

function syncPlayback() {
  const playing = !audio.paused;
  $('preview-icon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('preview').title = playing ? 'Пауза' : 'Прослушать';
  $('preview').setAttribute('aria-label', $('preview').title);
  $('elapsed').textContent = timecode(audio.currentTime);
  seek.value = audio.duration > 0 ? Math.round(audio.currentTime / audio.duration * 1000) : 0;
  seek.setAttribute('aria-valuetext', timecode(audio.currentTime));
  drawWave();
}

function renderTrack() {
  readySample = library.find((sample) => sample.id === selected?.id) || null;
  const job = jobs.get(selected?.id);
  const item = readySample || job || selected;
  const working = job && job.status !== 'error';
  const error = !readySample && (peekError || job?.message);
  $('track-empty').hidden = Boolean(item);
  $('track-card').hidden = !item;
  $('track-title').textContent = item?.title || '';
  $('track-title').title = item?.title || '';
  $('track-artist').textContent = item?.artist || '';
  const image = $('track-image');
  const thumbnail = item?.id ? `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg` : '';
  if (thumbnail && image.getAttribute('src') !== thumbnail) {
    image.hidden = false;
    image.src = thumbnail;
  }
  if (!thumbnail) {
    image.removeAttribute('src');
    image.hidden = true;
  }

  if ((readySample?.id ?? null) !== audioSampleId) {
    audio.pause();
    audioSampleId = readySample?.id ?? null;
    if (audioSampleId) audio.src = `sample-audio://library/${audioSampleId}`;
    else { audio.removeAttribute('src'); audio.load(); }
  }
  $('wave-panel').hidden = !readySample;
  $('preview').disabled = !readySample;
  seek.disabled = !readySample;
  $('duration').textContent = timecode(readySample?.duration);
  $('track-details').hidden = !readySample;
  $('track-format').textContent = readySample ? `WAV · ${readySample.sampleRate / 1000} кГц · ${readySample.bits} бит` : '';
  $('track-mode').textContent = readySample?.channels === 1 ? 'MONO' : readySample?.channels === 2 ? 'STEREO' : '';

  importZone.hidden = !readySample && !working;
  importZone.classList.toggle('ready', Boolean(readySample));
  importZone.draggable = Boolean(readySample);
  $('drag-icon').querySelector('use').setAttribute('href', readySample ? '#i-drag' : '#i-download');
  const messages = {
    queued: 'В очереди',
    resolving: 'Получаем аудио…',
    downloading: `Скачивание · ${Math.round(job?.progress || 0)}%`,
    converting: 'Конвертируем в WAV…',
  };
  $('import-label').textContent = readySample ? 'Перетащи в FL Studio' : messages[job?.status] || 'Готовим WAV…';
  const progress = $('import-progress');
  progress.hidden = !working || Boolean(readySample);
  if (job?.status === 'downloading') progress.value = job.progress;
  else progress.removeAttribute('value');

  $('prepare').hidden = !selected || Boolean(readySample || working);
  $('prepare-label').textContent = error ? 'Повторить подготовку' : 'Подготовить WAV';
  $('reveal-sample').hidden = !readySample;
  $('track-error').hidden = !error;
  $('error-message').textContent = error || '';
  $('error-details').hidden = !job?.detail || !error;
  $('error-detail').textContent = job?.detail || '';
  syncPlayback();
}

function selectSample(track) {
  selected = track;
  peekError = '';
  for (const row of document.querySelectorAll('.sample-row')) {
    row.classList.toggle('selected', row.dataset.id === track?.id);
  }
  renderTrack();
}

function updateSite({ status, detail }) {
  const error = status === 'error';
  $('site-title').hidden = status === 'ready';
  $('site-title').textContent = error ? 'Не удалось открыть Samplette.' : 'Загрузка Samplette…';
  $('site-title').title = detail || '';
  $('retry-site').hidden = !error;
}

function showDirectory(directory) {
  $('download-directory').value = directory || '';
  $('download-directory').title = directory || '';
}

function openDialog(dialog) {
  dialog.showModal();
  syncSiteBounds();
}

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => openView(button.dataset.view));
}
for (const button of document.querySelectorAll('[data-window]')) {
  button.addEventListener('click', async () => {
    const value = await api.windowAction(button.dataset.window);
    if (button.dataset.window === 'pin') button.setAttribute('aria-pressed', String(value));
  });
}
for (const button of document.querySelectorAll('[data-close-dialog]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}
for (const dialog of [sourceDialog, settingsDialog]) dialog.addEventListener('close', syncSiteBounds);

$('open-source').addEventListener('click', () => {
  $('source-error').hidden = true;
  openDialog(sourceDialog);
  $('source-url').focus();
});
$('paste-source').addEventListener('click', async () => {
  $('source-url').value = await api.pasteSource();
  $('source-url').focus();
});
$('open-settings').addEventListener('click', () => {
  $('directory-error').hidden = true;
  openDialog(settingsDialog);
});
async function chooseDirectory() {
  const button = $('choose-directory');
  const error = $('directory-error');
  error.hidden = true;
  button.disabled = true;
  try {
    const result = await api.chooseDownloadDirectory();
    if (result.directory) {
      const firstChoice = !$('download-directory').value;
      showDirectory(result.directory);
      if (firstChoice) settingsDialog.close();
    }
    if (result.error) {
      error.textContent = result.error;
      error.hidden = false;
    }
  } catch {
    error.textContent = 'Не удалось открыть выбор папки.';
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}
$('choose-directory').addEventListener('click', chooseDirectory);
$('confirm-delete').addEventListener('click', async ({ currentTarget: button }) => {
  const id = sampleToDelete?.id;
  if (!id) return;
  const error = $('delete-error');
  error.hidden = true;
  button.disabled = true;
  if (audioSampleId === id) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audioSampleId = null;
  }
  try {
    const failure = await api.deleteSample(id);
    if (failure) throw new Error(failure);
    if (selected?.id === id) selectSample(null);
    deleteDialog.close();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    renderTrack();
  } finally {
    button.disabled = false;
  }
});
$('auto-prepare').addEventListener('change', async ({ target }) => {
  try { await api.autoPrepare(target.checked); }
  catch {
    target.checked = !target.checked;
    const error = $('directory-error');
    error.textContent = 'Не удалось сохранить настройки.';
    error.hidden = false;
  }
});
$('source-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await api.addSource($('source-url').value);
  if (result.error) {
    $('source-error').textContent = result.error;
    $('source-error').hidden = false;
    return;
  }
  sourceDialog.close();
  $('source-url').value = '';
  if (result.view) openView(result.view);
});

for (const id of ['reload-site', 'retry-site']) $(id).addEventListener('click', () => api.reloadSite());
$('open-library-folder').addEventListener('click', async () => {
  const error = await api.openLibrary();
  if (error) showToast(error);
});
$('reveal-sample').addEventListener('click', async () => {
  if (!readySample) return;
  const error = await api.revealSample(readySample.id);
  if (error) showToast(error);
});
$('prepare').addEventListener('click', async () => {
  const id = selected?.id;
  if (!id) return;
  const result = await api.prepare(id);
  if (selected?.id !== id) return;
  peekError = result.error || '';
  renderTrack();
});
$('library-search').addEventListener('input', renderLibrarySearch);
$('track-image').addEventListener('error', () => { $('track-image').hidden = true; });

importZone.addEventListener('dragstart', (event) => {
  event.preventDefault();
  if (readySample) api.dragSample(readySample.id);
});
$('preview').addEventListener('click', () => {
  if (!readySample) return;
  if (audio.paused) void audio.play().catch(() => showToast('Не удалось открыть WAV для прослушивания.'));
  else audio.pause();
});
seek.addEventListener('input', () => {
  if (audio.duration > 0) audio.currentTime = audio.duration * Number(seek.value) / 1000;
});
for (const event of ['loadedmetadata', 'timeupdate', 'play', 'pause', 'ended']) audio.addEventListener(event, syncPlayback);
new ResizeObserver(drawWave).observe(canvas);
new ResizeObserver(syncSiteBounds).observe(siteWell);
window.addEventListener('resize', syncSiteBounds);

api.onMaximize((maximized) => {
  $('maximize-icon').setAttribute('href', maximized ? '#i-restore' : '#i-square');
  document.querySelector('[data-window="maximize"]').setAttribute('aria-label', maximized ? 'Восстановить' : 'Развернуть');
});
api.onNotice(showToast);
api.onTrack((track) => {
  sourceTrack = track;
  selectSample(track);
});
api.onLibrary((samples) => {
  library = samples;
  renderLibrarySearch();
  renderTrack();
});
api.onJob((job) => {
  if (job.status === 'ready') jobs.delete(job.id);
  else jobs.set(job.id, job);
  if (selected?.id === job.id) renderTrack();
});
api.onSite(updateSite);

async function start() {
  const state = await api.state();
  library = state.library;
  state.jobs.forEach((job) => jobs.set(job.id, job));
  $('auto-prepare').checked = state.settings.autoPrepare;
  showDirectory(state.settings.downloadDirectory);
  sourceTrack = state.currentTrack;
  selected = sourceTrack;
  renderLibrarySearch();
  renderTrack();
  updateSite({ status: state.siteStatus });
  started = true;
  if (state.settings.downloadDirectory) {
    syncSiteBounds();
  } else {
    openDialog(settingsDialog);
  }
}

void start().catch(() => showToast('Не удалось загрузить библиотеку сэмплов.'));
