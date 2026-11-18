const { contextBridge, ipcRenderer } = require('electron');

const handle = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (callback) => ipcRenderer.on(channel, (_event, value) => callback(value));

contextBridge.exposeInMainWorld('fastSamp', {
  state: handle('app:state'),
  windowAction: handle('window:action'),
  siteBounds: handle('site:bounds'),
  reloadSite: handle('site:reload'),
  addSource: handle('source:add'),
  pasteSource: handle('source:paste'),
  prepare: handle('track:prepare'),
  openLibrary: handle('library:open'),
  deleteSample: handle('library:delete'),
  revealSample: handle('library:reveal'),
  chooseDownloadDirectory: handle('settings:choose-directory'),
  autoPrepare: handle('settings:auto'),
  checkNetwork: handle('network:check'),
  setConnection: handle('settings:connection'),
  dragSample: (id) => ipcRenderer.send('audio:drag', id),
  onTrack: subscribe('track:update'),
  onJob: subscribe('job:update'),
  onLibrary: subscribe('library:update'),
  onSite: subscribe('site:update'),
  onMaximize: subscribe('window:maximized'),
  onNotice: subscribe('app:notice'),
  onNetwork: subscribe('network:update'),
});
