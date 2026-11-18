const { app, BaseWindow, WebContentsView, clipboard, dialog, ipcMain, nativeImage, protocol, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { youtubeId, videoIdPattern, wavName, readWav, downloadWav, downloadError } = require('./audio.cjs');
const { audioToolsReady, toolPaths } = require('./setup-audio.cjs');
const { systemProxy } = require('./network.cjs');

const sampletteUrl = 'https://samplette.io/';
const sitePartition = 'persist:samplette';
const assets = path.join(__dirname, 'assets');
const dataRoot = process.env.FAST_SAMP_DATA_DIR || path.join(app.getPath('appData'), 'FAST-SAMP');
const bundledTools = path.join(process.resourcesPath, 'tools');
const toolRoot = app.isPackaged ? bundledTools : path.join(__dirname, '..', 'tools');
const defaultDownloadDirectory = path.join(dataRoot, 'WAV');
const catalogPath = path.join(dataRoot, 'catalog');
const temporaryPath = path.join(dataRoot, 'incoming');
const settingsPath = path.join(dataRoot, 'settings.json');
const sampletteStyle = fs.readFileSync(path.join(__dirname, 'samplette.css'), 'utf8');
const library = new Map();
const deletions = new Set();
const jobs = new Map();
const queue = [];
let window;
let shellContents;
let site;
let dragIcon;
let currentTrack = null;
let siteTrackId = null;
let siteBounds = null;
let siteStatus = 'idle';
let autoTimer;
let activeJob;
let scanTimer;
let scanRunning = false;
let settings = { autoPrepare: true, downloadDirectory: null };

fs.mkdirSync(dataRoot, { recursive: true });
app.setPath('userData', dataRoot);
protocol.registerSchemesAsPrivileged([{
  scheme: 'sample-audio', privileges: { standard: true, secure: true, stream: true },
}]);

function send(topic, data) {
  if (shellContents && !shellContents.isDestroyed()) shellContents.send(topic, data);
}

function libraryList() {
  return [...library.values()].map(({ file, ...item }) => item).sort((a, b) => b.added - a.added);
}

function sendSite(status, detail = '') {
  siteStatus = status;
  send('site:update', { status, detail });
}

function siteUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  return url.protocol === 'https:' && ['samplette.io', 'www.samplette.io'].includes(url.hostname) &&
    !url.username && !url.password && !url.port ? url : null;
}

async function copyWav(wav, destination, name) {
  const title = path.basename(name, '.wav');
  for (let index = 1; ; index++) {
    const file = path.join(destination, index === 1 ? name : `${title} (${index}).wav`);
    try {
      await files.copyFile(wav, file, fs.constants.COPYFILE_EXCL);
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

async function storeSample({ id, directory, destination, wav, title, artist, length }) {
  const format = await readWav(wav);
  const item = {
    id, title, artist, added: Date.now(), duration: format.seconds || length,
    peaks: format.peaks, sampleRate: format.rate, channels: format.channels, bits: format.bits,
  };
  await files.mkdir(destination, { recursive: true });
  const file = await copyWav(wav, destination, wavName(title));
  const sample = { ...item, name: path.basename(file), file };
  try {
    const record = path.join(directory, 'sample.json');
    await files.writeFile(record, JSON.stringify(sample), 'utf8');
    await files.rename(record, path.join(catalogPath, `${id}.json`));
  } catch (error) {
    await files.unlink(file).catch(console.warn);
    throw error;
  }
  library.set(id, sample);
  send('library:update', libraryList());
}

async function loadLibrary() {
  await files.mkdir(defaultDownloadDirectory, { recursive: true });
  await files.mkdir(catalogPath, { recursive: true });
  await files.mkdir(temporaryPath, { recursive: true });
  const legacyFolders = await files.readdir(defaultDownloadDirectory, { withFileTypes: true });
  for (const entry of legacyFolders) {
    if (!entry.isDirectory() || !videoIdPattern.test(entry.name)) continue;
    try {
      const folder = path.join(defaultDownloadDirectory, entry.name);
      const item = JSON.parse(await files.readFile(path.join(folder, 'sample.json'), 'utf8'));
      if (item.id !== entry.name || typeof item.name !== 'string' || item.name !== path.basename(item.name) ||
        path.extname(item.name) !== '.wav') continue;
      const file = path.join(folder, item.name);
      if ((await files.stat(file)).isFile()) library.set(item.id, { ...item, file });
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Reading sample metadata:', error.message);
    }
  }
  for (const name of await files.readdir(catalogPath)) {
    const id = path.basename(name, '.json');
    if (!name.endsWith('.json') || !videoIdPattern.test(id)) continue;
    try {
      const item = JSON.parse(await files.readFile(path.join(catalogPath, name), 'utf8'));
      if (item.id === id && typeof item.file === 'string' && path.isAbsolute(item.file) &&
        path.extname(item.file) === '.wav' && (await files.stat(item.file)).isFile()) library.set(id, item);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Reading sample catalog:', error.message);
    }
  }
}

async function deleteSample(id) {
  const sample = library.get(id);
  if (!sample || deletions.has(id)) return '';
  deletions.add(id);
  try {
    try { await shell.trashItem(path.resolve(sample.file)); }
    catch (error) {
      try { await files.stat(sample.file); }
      catch (statError) {
        if (statError.code === 'ENOENT') return await removeLibraryEntry(id);
      }
      throw error;
    }
    return await removeLibraryEntry(id);
  } catch (error) {
    console.warn('Removing sample:', error.message);
    return 'Не удалось переместить WAV в Корзину.';
  } finally {
    deletions.delete(id);
  }
}

async function removeLibraryEntry(id) {
  if (siteTrackId === id) clearTimeout(autoTimer);
  for (const record of [path.join(catalogPath, `${id}.json`), path.join(defaultDownloadDirectory, id, 'sample.json')]) {
    await files.unlink(record).catch((error) => {
      if (error.code !== 'ENOENT') console.warn('Removing library metadata:', error.message);
    });
  }
  library.delete(id);
  send('library:update', libraryList());
  return '';
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  send('job:update', { ...job });
}

async function nextJob() {
  if (activeJob || !queue.length) return;
  const job = queue.shift();
  const runtime = {};
  activeJob = runtime;
  let directory;
  let saving = false;
  try {
    updateJob(job, { status: 'checking', progress: 0 });
    const proxy = await systemProxy(session.fromPartition(sitePartition), `https://www.youtube.com/watch?v=${job.id}`);
    updateJob(job, { status: 'resolving', progress: 0 });
    directory = await files.mkdtemp(path.join(temporaryPath, 'track-'));
    const info = await downloadWav({
      id: job.id, directory, tools: toolPaths(toolRoot), proxy, runtime,
      report: (patch) => updateJob(job, patch),
    });
    const title = info.title || job.title || `YouTube ${job.id}`;
    const artist = info.artist || job.artist || 'YouTube';
    saving = true;
    await storeSample({ id: job.id, directory, destination: job.destination, ...info, title, artist });
    jobs.delete(job.id);
    send('job:update', { id: job.id, status: 'ready' });
  } catch (error) {
    const failure = saving
      ? { message: 'Не удалось сохранить WAV. Проверь папку скачивания.', detail: error.message }
      : downloadError(error);
    updateJob(job, { status: 'error', ...failure });
    console.warn('Preparing WAV:', error.message);
  } finally {
    if (directory) await files.rm(directory, { recursive: true, force: true }).catch(console.warn);
    activeJob = null;
    void nextJob();
  }
}

function prepare(track) {
  const { id, title, artist } = track;
  if (deletions.has(id)) return { error: 'Этот сэмпл удаляется.' };
  if (library.has(id) && fs.existsSync(library.get(id).file)) return { ok: true };
  if (!videoIdPattern.test(id)) return { error: 'Выбери трек в Samplette.' };
  if (!settings.downloadDirectory) return { error: 'Выбери папку скачивания в настройках.' };
  if (!audioToolsReady(toolRoot)) return { error: app.isPackaged
    ? 'Не найдены встроенные аудиоинструменты. Распакуй всю папку FAST-SAMP из ZIP заново.'
    : 'Подготовь аудиоинструменты командой npm run setup:audio.' };
  if (jobs.has(id) && jobs.get(id).status !== 'error') return { ok: true };
  if (queue.length >= 12) return { error: 'Очередь заполнена. Дождись подготовки файлов.' };
  if (library.delete(id)) send('library:update', libraryList());
  const job = { id, title, artist, destination: settings.downloadDirectory, status: 'queued', progress: 0 };
  jobs.set(id, job);
  queue.push(job);
  updateJob(job, {});
  void nextJob();
  return { ok: true };
}

function selectTrack(track) {
  currentTrack = track;
  send('track:update', currentTrack);
}

function schedulePrepare(track) {
  clearTimeout(autoTimer);
  if (!settings.autoPrepare || !settings.downloadDirectory) return;
  autoTimer = setTimeout(() => {
    if (siteTrackId === track.id && currentTrack?.id === track.id) prepare(track);
  }, 2400);
}

function siteTrack() {
  const links = [...document.querySelectorAll('a.watch-on-youtube-href')];
  const link = links.find((element) => element.href.startsWith('https://www.youtube.com/')) ??
    links.find((element) => element.href.startsWith('https://youtu.be/'));
  const frame = document.querySelector('#youtube-player-container iframe, iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]');
  return {
    urls: [link?.href, frame?.src],
    title: document.querySelector('#youtube-player-title')?.textContent.trim().slice(0, 255),
    artist: document.querySelector('#youtube-player-channel')?.textContent.trim().slice(0, 255),
  };
}

async function scanSite() {
  if (!siteBounds || !site || siteStatus !== 'ready' || scanRunning || !siteUrl(site.webContents.getURL())) return;
  scanRunning = true;
  try {
    const track = await site.webContents.executeJavaScript(`(${siteTrack.toString()})()`);
    if (!siteBounds) return;
    const frameUrls = site.webContents.mainFrame.frames.map((frame) => frame.url);
    const id = [...track.urls, ...frameUrls].map(youtubeId).find(Boolean);
    if (!id || id === siteTrackId) return;
    siteTrackId = id;
    const selection = { id, title: track.title || `YouTube ${id}`, artist: track.artist || 'Samplette' };
    selectTrack(selection);
    schedulePrepare(selection);
  } catch {
    // The page or player can navigate while its previous frame is being read.
  } finally {
    scanRunning = false;
  }
}

function ensureSite() {
  if (site) return;
  const browserSession = session.fromPartition(sitePartition);
  browserSession.setPermissionRequestHandler((_content, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on('will-download', (event) => event.preventDefault());
  site = new WebContentsView({
    webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  site.setBackgroundColor('#0f0f0f');
  site.setVisible(false);
  window.contentView.addChildView(site);
  const contents = site.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const external = new URL(url);
      if (external.protocol === 'https:') void shell.openExternal(external.href).catch(console.warn);
    } catch {}
    return { action: 'deny' };
  });
  const allowNavigation = (event) => {
    if (!siteUrl(event.url)) event.preventDefault();
  };
  contents.on('will-navigate', allowNavigation);
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame) allowNavigation(event);
  });
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) {
      siteTrackId = null;
      sendSite('loading');
      attachSite();
    }
  });
  contents.on('dom-ready', async () => {
    const url = contents.getURL();
    if (!siteUrl(url)) return;
    await contents.insertCSS(sampletteStyle, { cssOrigin: 'user' }).catch(console.warn);
    if (contents.isDestroyed() || contents.getURL() !== url) return;
    sendSite('ready');
    attachSite();
    void scanSite();
  });
  contents.on('did-fail-load', (_event, code, detail, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      sendSite('error', detail);
      attachSite();
    }
  });
  contents.on('render-process-gone', () => {
    sendSite('error', 'Процесс браузера закрылся.');
    attachSite();
  });
}

function openSite(url = sampletteUrl) {
  ensureSite();
  sendSite('loading');
  attachSite();
  void site.webContents.loadURL(url).catch((error) => {
    if (!error.message.includes('ERR_ABORTED') && siteStatus === 'loading') {
      sendSite('error', error.message);
      attachSite();
    }
  });
}

function attachSite() {
  if (!site) return;
  const visible = Boolean(siteBounds && siteStatus === 'ready');
  if (siteBounds) site.setBounds(siteBounds);
  site.setVisible(visible);
  site.webContents.setAudioMuted(!visible);
}

function buildWindow() {
  window = new BaseWindow({
    width: 1360, height: 850, minWidth: 870, minHeight: 590, frame: false,
    backgroundColor: '#0f0f0f', title: 'FAST/SAMP', icon: path.join(assets, 'app-icon.png'),
    show: false,
  });
  window.removeMenu();
  const workspace = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });
  shellContents = workspace.webContents;
  workspace.setBackgroundColor('#0f0f0f');
  window.contentView.addChildView(workspace);
  const resizeWorkspace = () => {
    const [width, height] = window.getContentSize();
    workspace.setBounds({ x: 0, y: 0, width, height });
  };
  resizeWorkspace();
  window.on('resize', resizeWorkspace);
  shellContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  shellContents.on('will-navigate', (event) => event.preventDefault());
  shellContents.on('will-attach-webview', (event) => event.preventDefault());
  shellContents.once('did-finish-load', () => {
    window.show();
    shellContents.focus();
  });
  window.on('maximize', () => send('window:maximized', true));
  window.on('unmaximize', () => send('window:maximized', false));
  window.on('closed', () => {
    clearTimeout(autoTimer);
    clearInterval(scanTimer);
    if (site && !site.webContents.isDestroyed()) site.webContents.close();
    if (!shellContents.isDestroyed()) shellContents.close();
    activeJob?.child?.kill();
  });
  void shellContents.loadFile(path.join(__dirname, 'index.html'));
  scanTimer = setInterval(scanSite, 900);
}

function handler(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== shellContents || event.senderFrame !== shellContents.mainFrame) return undefined;
    return callback(...args);
  });
}

function saveSettings(changes) {
  const next = { ...settings, ...changes };
  const temp = `${settingsPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next), 'utf8');
  fs.renameSync(temp, settingsPath);
  settings = next;
  return settings;
}

async function chooseDownloadDirectory() {
  const current = settings.downloadDirectory;
  const choice = await dialog.showOpenDialog(window, {
    title: 'Папка скачивания WAV',
    buttonLabel: 'Выбрать папку',
    defaultPath: current && fs.existsSync(current) ? current : defaultDownloadDirectory,
    properties: ['openDirectory'],
  });
  if (choice.canceled || !choice.filePaths.length) return {};
  const directory = choice.filePaths[0];
  try {
    const probe = await files.mkdtemp(path.join(directory, '.fast-samp-'));
    await files.rmdir(probe);
    saveSettings({ downloadDirectory: directory });
    if (currentTrack && currentTrack.id === siteTrackId) schedulePrepare(currentTrack);
    return { directory };
  } catch (error) {
    console.warn('Setting download directory:', error.message);
    return { error: 'Не удалось сохранить эту папку. Проверь права на запись.' };
  }
}

async function openDownloadDirectory() {
  const directory = settings.downloadDirectory;
  if (!directory) return 'Выбери папку скачивания в настройках.';
  try {
    await files.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (!error) return '';
    if (process.platform !== 'win32' || !process.env.SystemRoot) throw new Error(error);
    await new Promise((resolve, reject) => {
      const explorer = spawn(path.join(process.env.SystemRoot, 'explorer.exe'), [directory], {
        stdio: 'ignore', detached: true,
      });
      explorer.once('error', reject);
      explorer.once('spawn', () => { explorer.unref(); resolve(); });
    });
    return '';
  } catch (error) {
    console.warn('Opening download directory:', error.message);
    return 'Папка WAV недоступна. Выбери папку в настройках.';
  }
}

function registerHandlers() {
  handler('app:state', () => ({
    library: libraryList(), jobs: [...jobs.values()], settings, siteStatus,
    currentTrack, version: app.getVersion(),
  }));
  handler('window:action', (action) => {
    if (action === 'pin') {
      window.setAlwaysOnTop(!window.isAlwaysOnTop());
      return window.isAlwaysOnTop();
    }
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }
    if (action === 'close') window.close();
  });
  handler('site:bounds', (bounds) => {
    if (bounds && !['x', 'y', 'width', 'height'].every((key) => Number.isInteger(bounds[key]) && bounds[key] >= 0)) return;
    siteBounds = bounds;
    if (bounds && !site) openSite();
    attachSite();
  });
  handler('site:reload', () => openSite(siteUrl(site?.webContents.getURL())?.href || sampletteUrl));
  handler('source:paste', () => clipboard.readText().trim().slice(0, 2048));
  handler('source:add', (value) => {
    if (typeof value !== 'string' || value.length > 2048) return { error: 'Вставь ссылку на трек.' };
    const source = value.trim();
    const id = youtubeId(source);
    if (id) {
      const track = { id, title: library.get(id)?.title || `YouTube ${id}`, artist: library.get(id)?.artist || 'YouTube' };
      selectTrack(track);
      return { ...prepare(track), track };
    }
    const url = siteUrl(source);
    if (url) {
      openSite(url.href);
      return { view: 'samplette' };
    }
    return { error: 'Поддерживаются ссылки Samplette, YouTube и youtu.be.' };
  });
  handler('track:prepare', (id) => currentTrack?.id === id ? prepare(currentTrack) : { error: 'Трек уже сменился.' });
  handler('library:open', openDownloadDirectory);
  handler('library:delete', deleteSample);
  handler('settings:choose-directory', chooseDownloadDirectory);
  handler('library:reveal', (id) => {
    const item = library.get(id);
    if (item && fs.existsSync(item.file)) shell.showItemInFolder(item.file);
    else return 'Файл WAV перемещён или удалён.';
    return '';
  });
  handler('settings:auto', (enabled) => {
    saveSettings({ autoPrepare: enabled === true });
    clearTimeout(autoTimer);
    if (currentTrack && currentTrack.id === siteTrackId) schedulePrepare(currentTrack);
    return settings;
  });
  ipcMain.on('audio:drag', (event, id) => {
    if (event.sender !== shellContents || event.senderFrame !== shellContents.mainFrame) return;
    const item = library.get(id);
    if (item && fs.existsSync(item.file)) {
      try { event.sender.startDrag({ file: item.file, icon: dragIcon }); }
      catch (error) { send('app:notice', 'Не удалось начать перетаскивание WAV.'); console.warn(error.message); }
    }
    else send('app:notice', 'Файл WAV перемещён или удалён.');
  });
}

async function serveAudio(request) {
  const id = new URL(request.url).pathname.slice(1);
  const entry = library.get(id);
  if (!entry) return new Response(null, { status: 404 });
  const size = await files.stat(entry.file).then((stat) => stat.size, () => 0);
  if (!size) return new Response(null, { status: 404 });
  const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' };
  const range = request.headers.get('range');
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = range.match(/^bytes=(\d+)-(\d*)$/);
    start = Number(match?.[1]);
    end = Math.min(size - 1, Number(match?.[2] || size - 1));
    if (!Number.isSafeInteger(start) || start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  const stream = Readable.toWeb(fs.createReadStream(entry.file, { start, end }));
  return new Response(stream, { status: range ? 206 : 200, headers });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(async () => {
    try {
      const saved = JSON.parse(await files.readFile(settingsPath, 'utf8'));
      if (typeof saved.autoPrepare === 'boolean') settings.autoPrepare = saved.autoPrepare;
      if (typeof saved.downloadDirectory === 'string' && path.isAbsolute(saved.downloadDirectory)) {
        settings.downloadDirectory = saved.downloadDirectory;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Reading settings:', error.message);
    }
    await loadLibrary();
    dragIcon = nativeImage.createFromPath(path.join(assets, 'app-icon.png')).resize({ width: 40, height: 40 });
    protocol.handle('sample-audio', serveAudio);
    registerHandlers();
    buildWindow();
  }).catch((error) => {
    console.error(error);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
