'use strict';
const { app, BrowserWindow, dialog, protocol, ipcMain, Menu, shell, nativeTheme } = require('electron');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Workspace, readJson, writeJson, filename, validProject } = require('./workspace.cjs');
const { Library, isMedia, mediaExt } = require('./library.cjs');
const { resolveStickerPath } = require('./retired-stickers.cjs');
const { sample } = require('./sample.cjs');
const root = path.resolve(__dirname, '..');
const engine = require('./engine.cjs');
const testProfile = process.env.CUTTING_EDGE_PROFILE;
const hiddenTestWindow = Boolean(testProfile) && process.env.CUTTING_EDGE_QA_HIDDEN === '1';
if (testProfile) app.setPath('userData', path.resolve(testProfile));
app.setName('Cutting edge');
app.setAppUserModelId('CuttingEdge.Editor');
protocol.registerSchemesAsPrivileged(
  ['cutting', 'cutting-media'].map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  })),
);
const mime = {
  html: 'text/html',
  css: 'text/css',
  mjs: 'text/javascript',
  js: 'text/javascript',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  avif: 'image/avif',
};
let win,
  ws,
  library,
  startFile = process.argv.find((a) => /\.cutproj$/i.test(a)),
  allowClose = false,
  booted = false;
let sampleDir;
const running = new Set();
function installerDirs() {
  const result = {};
  if (process.platform !== 'win32' || testProfile) return result;
  try {
    const command =
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $prefs = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Cutting edge' -ErrorAction SilentlyContinue; if ($prefs) { $prefs | Select-Object ProjectDir,OutputDir,UILanguage | ConvertTo-Json -Compress }";
    const data = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 6000 },
    );
    if (data.trim()) Object.assign(result, JSON.parse(data.trim()));
  } catch {}
  return result;
}
function send(event, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('ce-event', event, payload);
}
function registerSchemes() {
  protocol.handle('cutting', async (req) => {
    try {
      const url = new URL(req.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const target = path.resolve(root, relative);
      if (
        url.hostname !== 'editor' ||
        !['ui', 'assets/icons', 'assets/fonts'].some((f) =>
          target.startsWith(path.resolve(root, f) + path.sep),
        )
      )
        return new Response(null, { status: 403 });
      return new Response(await fs.readFile(target), {
        headers: { 'Content-Type': mime[path.extname(target).slice(1)] || 'application/octet-stream' },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  protocol.handle('cutting-media', async (req) => {
    try {
      const url = new URL(req.url);
      const file = path.resolve(decodeURIComponent(url.pathname.slice(1)));
      if (!library.allowed.has(file.toLowerCase()) || !isMedia(file))
        return new Response(null, { status: 403 });
      if (url.searchParams.has('frame')) {
        const value = url.searchParams.get('frame').trim();
        const time = Number(value);
        if (req.method !== 'GET' || !value || !Number.isFinite(time) || time < 0)
          return new Response(null, { status: 400 });
        const frame = await library.cropFrame(file, time, req.signal);
        return new Response(frame, {
          headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
        });
      }
      const { size } = await fs.stat(file);
      const headers = {
        'Content-Type': mime[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      };
      const range = req.headers.get('range');
      let start = 0,
        end = size - 1,
        partial = false;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m || (!m[1] && !m[2])) return new Response(null, { status: 416 });
        if (!m[1]) start = Math.max(0, size - Number(m[2]));
        else {
          start = Number(m[1]);
          if (m[2]) end = Math.min(end, Number(m[2]));
        }
        if (start > end || start >= size)
          return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
        partial = true;
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
      }
      headers['Content-Length'] = String(Math.max(0, end - start + 1));
      if (req.method === 'HEAD' || !size)
        return new Response(null, { headers, status: partial ? 206 : 200 });
      const input = createReadStream(file, { start, end });
      if (!req.signal.aborted)
        req.signal.addEventListener('abort', () => input.destroy(), { once: true });
      return new Response(Readable.toWeb(input), { headers, status: partial ? 206 : 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
function handler(name, fn) {
  ipcMain.handle('ce:' + name, async (e, arg = {}) => {
    if (e.sender !== win?.webContents || e.senderFrame?.url !== 'cutting://editor/ui/index.html')
      return { error: 'Invalid window' };
    try {
      return { value: await fn(arg || {}) };
    } catch (err) {
      console.error('[Cutting edge]', name, String(err.message || err));
      return { error: String(err.message || err) };
    }
  });
}
function localized(pl, en) {
  return ws.settings.language === 'pl' ? pl : en;
}
const mediaFilter = () => [
  { name: localized('Pliki multimedialne', 'Media files'), extensions: [...mediaExt] },
];
async function chooseFile(options) {
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], ...options });
  return result.canceled ? [] : result.filePaths;
}
async function opened(doc) {
  const missing = [];
  for (const a of Object.values(doc.project.assets)) {
    if (!isMedia(a.path)) continue;
    try {
      a.path = await resolveStickerPath(a, ws);
      library.allow(a);
      await fs.access(a.path);
      if (
        (a.previewPath && !(await exists(a.previewPath))) ||
        (a.thumbnail && !(await exists(a.thumbnail)))
      ) {
        const updated = await library.inspect(a.path, a.category, a.group);
        // A rebuilt preview can use the source directly after a codec or cache update.
        Object.assign(a, { previewPath: undefined, thumbnail: undefined }, updated, { id: a.id });
      }
    } catch {
      missing.push(a.name);
    }
  }
  return { ...doc, missing };
}
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
async function openSample() {
  return opened(await sample(ws, library, sampleDir));
}
function checked(p) {
  validProject(p);
  for (const a of Object.values(p.assets))
    if (!library.allowed.has(path.resolve(a.path).toLowerCase()))
      throw Error('Unknown source: ' + a.name);
  return p;
}
async function launchDoc() {
  if (startFile) {
    const f = startFile;
    startFile = undefined;
    return opened(await ws.open(f));
  }
  const latest = ws.settings.recent[0];
  if (latest && (await exists(latest.path))) return opened(await ws.open(latest.path));
  return openSample();
}
function job(name, fn) {
  handler(name, async (arg) => {
    if (running.has(name))
      throw Error(localized('To zadanie już trwa.', 'This operation is already running.'));
    running.add(name);
    try {
      return await fn(arg, (value) => send('progress', { job: name, value }));
    } finally {
      running.delete(name);
    }
  });
}
function setupIpc() {
  handler('boot', async () => {
    let doc, warning;
    try {
      doc = await launchDoc();
    } catch (e) {
      warning = e.message;
      doc = await ws.create(localized('Bez tytułu', 'Untitled'));
    }
    booted = true;
    return { settings: ws.settings, doc, warning, version: app.getVersion(), libraryDir: ws.libraryDir };
  });
  handler('window', async ({ action }) => {
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'close') win.close();
    if (action === 'closeReady') {
      allowClose = true;
      win.close();
    }
  });
  handler('preferences', async ({ patch }) => {
    const s = await ws.setSettings(patch);
    nativeTheme.themeSource = s.theme;
    return s;
  });
  handler(
    'directory',
    async ({ current }) =>
      (await chooseFile({ properties: ['openDirectory', 'createDirectory'], defaultPath: current }))[0],
  );
  handler('projectNew', ({ name, options }) => ws.create(name, options));
  handler('projectOpen', async ({ recent }) => {
    const f =
      (recent && ws.settings.recent.find((r) => r.path === recent)?.path) ||
      (!recent &&
        (
          await chooseFile({
            filters: [{ name: 'Cutting edge', extensions: ['cutproj'] }],
            defaultPath: ws.settings.projectDir,
          })
        )[0]);
    return f ? opened(await ws.open(f)) : null;
  });
  handler('sample', openSample);
  handler('projectSave', ({ path: file, project }) => ws.save(file, checked(project)));
  handler('projectCopy', async ({ project }) => {
    checked(project);
    const p = await dialog.showSaveDialog(win, {
      defaultPath: path.join(ws.settings.projectDir, filename(project.name) + ' - copy.cutproj'),
      filters: [{ name: 'Cutting edge', extensions: ['cutproj'] }],
    });
    if (p.canceled) return null;
    const copy = { ...project, id: ws.known.get(p.filePath) === project.id ? project.id : randomUUID() };
    await writeJson(p.filePath, copy);
    return ws.remember(p.filePath, copy);
  });
  handler('mediaImport', async ({ files, category = 'media', group }) => {
    if (!files)
      files = await chooseFile({ properties: ['openFile', 'multiSelections'], filters: mediaFilter() });
    const assets = [],
      errors = [];
    for (const f of files) {
      try {
        assets.push(await library.import(f, category, group));
      } catch (e) {
        errors.push(path.basename(f) + ' — ' + e.message);
      }
    }
    return { assets, errors };
  });
  handler('libraryList', ({ category }) => library.scan(category));
  handler('folderOpen', async ({ category }) => {
    const folder =
      category === 'output'
        ? ws.settings.outputDir
        : category === 'projects'
          ? ws.settings.projectDir
          : library.folder(category);
    const error = await shell.openPath(folder);
    if (error) throw Error(error);
  });
  handler('templates', () => readJson(ws.templatesPath, []));
  handler('templateSave', ({ template, remove }) =>
    ws.serial(async () => {
      const current = await readJson(ws.templatesPath, []);
      const next = current.filter((t) => t.id !== (template?.id || remove));
      if (template && typeof template.name === 'string' && Array.isArray(template.slots))
        next.push(template);
      await writeJson(ws.templatesPath, next);
      return next;
    }),
  );
  job('render', async ({ project }, onProgress) => {
    checked(project);
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(ws.settings.outputDir, filename(project.name) + '.' + project.format),
      filters: [{ name: project.format.toUpperCase(), extensions: [project.format] }],
    });
    if (canceled) return null;
    const dest = filePath.toLowerCase().endsWith('.' + project.format)
      ? filePath
      : filePath + '.' + project.format;
    if (
      Object.values(project.assets).some(
        (a) => path.resolve(a.path).toLowerCase() === path.resolve(dest).toLowerCase(),
      )
    )
      throw Error(
        localized(
          'Wybierz inną nazwę niż plik źródłowy.',
          'Choose a name different from the source file.',
        ),
      );
    await engine.renderProject(project, dest, { onProgress });
    return dest;
  });
  job('silence', ({ project, db, minDuration }) =>
    engine.detectSilence(checked(project), { db, minDuration }),
  );
  job('transcribe', ({ project, language, model }, onProgress) =>
    engine.transcribe(checked(project), {
      language,
      model,
      uiLanguage: ws.settings.language,
      onProgress,
      onStatus: (text) => send('jobStatus', String(text)),
    }),
  );
  handler('subtitles', async ({ name, format, text, automatic }) => {
    if (!['srt', 'vtt'].includes(format) || typeof text !== 'string') throw Error('Invalid subtitles');
    const base = path.join(ws.settings.outputDir, filename(name));
    let file = base + '.' + format;
    if (automatic) {
      for (let i = 1; ; i++) {
        try {
          await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
          return file;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          file = base + ' (' + i + ').' + format;
        }
      }
    }
    const reply = await dialog.showSaveDialog(win, {
      defaultPath: file,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (reply.canceled) return null;
    await fs.writeFile(reply.filePath, text, 'utf8');
    return reply.filePath;
  });
  job('assistant', async ({ project, selection, message, history }) => {
    const { askAssistant } = require('./assistant.cjs');
    const response = await askAssistant({
      project: checked(project),
      selection,
      message,
      history,
      language: ws.settings.language,
      libraryDir: ws.libraryDir,
      onEvent: (ev) => send('assistantEvent', ev),
    });
    for (const action of response.actions || []) {
      if (action.type !== 'insertAsset') continue;
      const existing = Object.values(project.assets).find(
        (a) => path.resolve(a.path).toLowerCase() === path.resolve(action.path).toLowerCase(),
      );
      if (existing) {
        action.asset = existing;
        continue;
      }
      const allowedRoot = path.resolve(ws.libraryDir).toLowerCase() + path.sep;
      if (!path.resolve(action.path).toLowerCase().startsWith(allowedRoot))
        throw Error('Asset outside library');
      action.asset = await library.inspect(action.path, action.category, action.group);
    }
    return response;
  });
  handler('updateCheck', () => require('./updater.cjs').checkUpdate(app.getVersion()));
  handler('updateInstall', async () => {
    await require('./updater.cjs').installUpdate(app.getVersion());
    allowClose = true;
    app.quit();
  });
}
function createWindow() {
  win = new BrowserWindow({
    title: 'Cutting edge',
    width: 1470,
    height: 920,
    minWidth: 940,
    minHeight: 610,
    backgroundColor: '#141617',
    show: false,
    frame: false,
    icon: path.join(root, 'assets', 'app.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: hiddenTestWindow,
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== 'cutting://editor/ui/index.html') e.preventDefault();
  });
  win.on('close', (e) => {
    if (!allowClose && booted) {
      e.preventDefault();
      send('closeRequested');
    }
  });
  if (!hiddenTestWindow) win.once('ready-to-show', () => win.show());
  win.loadURL('cutting://editor/ui/index.html');
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, args) => {
    const file = args.find((a) => /\.cutproj$/i.test(a));
    if (win && !hiddenTestWindow) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (file && booted)
      ws.open(file)
        .then(opened)
        .then((doc) => send('externalOpen', doc))
        .catch((e) => send('error', e.message));
    else if (file) startFile = file;
  });
  app
    .whenReady()
    .then(async () => {
      const userData =
        testProfile || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Cutting edge');
      ws = new Workspace({
        data: userData,
        documents: testProfile || app.getPath('documents'),
        videos: testProfile || app.getPath('videos'),
        bundled: path.join(root, 'assets'),
        locale: app.getLocale(),
        installer: installerDirs(),
      });
      await ws.init();
      nativeTheme.themeSource = ws.settings.theme;
      library = new Library(ws, engine);
      await library.init();
      if (app.isPackaged && !testProfile && process.platform === 'win32') {
        const alias = path.join(path.dirname(process.execPath), 'Library');
        try {
          await fs.symlink(ws.libraryDir, alias, 'junction');
        } catch (e) {
          if (!['EEXIST', 'EPERM', 'EACCES'].includes(e.code)) console.warn(e.message);
        }
      }
      sampleDir = app.isPackaged
        ? path.join(process.resourcesPath, 'sample')
        : path.join(root, 'assets', 'sample');
      registerSchemes();
      setupIpc();
      createWindow();
    })
    .catch((err) => {
      dialog.showErrorBox('Cutting edge', err.message);
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
}
