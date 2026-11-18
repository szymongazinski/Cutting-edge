const { contextBridge, ipcRenderer, webUtils } = require('electron');
const names = new Set([
  'boot',
  'window',
  'preferences',
  'directory',
  'projectNew',
  'projectOpen',
  'sample',
  'projectSave',
  'projectCopy',
  'mediaImport',
  'libraryList',
  'folderOpen',
  'templates',
  'templateSave',
  'render',
  'silence',
  'transcribe',
  'subtitles',
  'assistant',
  'updateCheck',
  'updateInstall',
]);
contextBridge.exposeInMainWorld('cutting', {
  async call(name, arg = {}) {
    if (!names.has(name)) throw Error('Unknown operation');
    const result = await ipcRenderer.invoke('ce:' + name, arg);
    if (result.error) throw Error(result.error);
    return result.value;
  },
  filePath: (file) => webUtils.getPathForFile(file),
  subscribe(fn) {
    const listener = (_e, name, data) => fn(name, data);
    ipcRenderer.on('ce-event', listener);
    return () => ipcRenderer.removeListener('ce-event', listener);
  },
});
