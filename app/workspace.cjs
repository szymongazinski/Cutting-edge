'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const formats = ['mp4', 'mov', 'mkv', 'webm'];
const qualities = ['draft', 'balanced', 'high'];
const clipKinds = new Set(['media', 'compound', 'caption', 'text']);
const categories = ['global', 'audiofx', 'visualfx', 'sticker'];
const finite = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
function filename(name) {
  const safe = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 70);
  return !safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe) ? 'Project' : safe;
}
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
function validProject(p) {
  if (
    !p ||
    p.schema !== 1 ||
    typeof p.id !== 'string' ||
    typeof p.name !== 'string' ||
    !finite(p.width, 16, 8192) ||
    !finite(p.height, 16, 8192) ||
    !finite(p.fps, 1, 240) ||
    !formats.includes(p.format) ||
    !qualities.includes(p.quality) ||
    !Array.isArray(p.clips) ||
    !p.assets ||
    typeof p.assets !== 'object' ||
    Array.isArray(p.assets)
  )
    throw Error('Invalid Cutting edge project / Nieprawidłowy plik projektu.');
  for (const [id, a] of Object.entries(p.assets)) {
    if (
      !a ||
      ['__proto__', 'constructor', 'prototype'].includes(id) ||
      id !== a.id ||
      typeof a.path !== 'string' ||
      !['video', 'audio', 'image'].includes(a.kind)
    )
      throw Error('Invalid source / Nieprawidłowe źródło.');
  }
  const ids = new Set();
  const visit = (clip, depth) => {
    if (
      !clip ||
      typeof clip.id !== 'string' ||
      ids.has(clip.id) ||
      !clipKinds.has(clip.kind) ||
      !finite(clip.start, 0, 864000) ||
      !finite(clip.duration, 0.000001, 864000) ||
      !finite(clip.in, 0, 864000) ||
      !Number.isInteger(clip.track) ||
      clip.track < 0 ||
      clip.track > 999 ||
      depth > 32
    )
      throw Error('Invalid timeline / Nieprawidłowa oś czasu.');
    ids.add(clip.id);
    if (clip.kind === 'media' && !Object.hasOwn(p.assets, clip.assetId))
      throw Error('Missing source / Brak źródła.');
    if (clip.kind === 'compound') {
      if (!Array.isArray(clip.children)) throw Error('Invalid compound clip.');
      for (const c of clip.children) visit(c, depth + 1);
    }
    if (
      clip.kind === 'caption' &&
      (!Array.isArray(clip.cues) ||
        clip.cues.some(
          (c) =>
            typeof c.text !== 'string' || !finite(c.start, 0, 864000) || !finite(c.end, c.start, 864000),
        ))
    )
      throw Error('Invalid subtitles.');
  };
  p.clips.forEach((c) => visit(c, 0));
  return p;
}
class Workspace {
  constructor({ data, documents, videos, bundled, locale = 'en', installer = {} }) {
    this.data = data;
    this.bundled = bundled;
    this.libraryDir = path.join(data, 'Library');
    this.configPath = path.join(data, 'settings.json');
    this.templatesPath = path.join(data, 'templates.json');
    this.installer = installer;
    this.settings = {
      projectDir: installer.ProjectDir || path.join(documents, 'Cutting edge', 'Projects'),
      outputDir: installer.OutputDir || path.join(videos, 'Cutting edge'),
      defaultFormat: 'mp4',
      defaultWidth: 1920,
      defaultHeight: 1080,
      defaultFps: 30,
      defaultQuality: 'balanced',
      language: ['pl', 'en'].includes(installer.UILanguage)
        ? installer.UILanguage
        : locale.toLowerCase().startsWith('pl')
          ? 'pl'
          : 'en',
      theme: 'system',
      timelineSnap: true,
      sceneSnap: true,
      edgeDragMode: 'crop',
      silenceDb: -35,
      silenceDuration: 0.4,
      captionLanguage: 'auto',
      captionModel: 'large-v3',
      recent: [],
    };
    this.known = new Map();
    this.writes = Promise.resolve();
  }
  serial(fn) {
    const next = this.writes.then(fn);
    this.writes = next.catch(() => {});
    return next;
  }
  async init() {
    const loaded = await readJson(this.configPath, {});
    Object.assign(this.settings, loaded);
    const previous = loaded.installerDefaults;
    for (const [key, setting] of [
      ['ProjectDir', 'projectDir'],
      ['OutputDir', 'outputDir'],
      ['UILanguage', 'language'],
    ]) {
      const value = this.installer[key];
      if (value && previous && value !== previous[key]) this.settings[setting] = value;
    }
    this.settings.installerDefaults = this.installer;
    await Promise.all(
      [
        this.settings.projectDir,
        this.settings.outputDir,
        ...categories.map((c) => path.join(this.libraryDir, c)),
      ].map((p) => fs.mkdir(p, { recursive: true })),
    );
  }
  async setSettings(patch) {
    return this.serial(async () => {
      const next = { ...this.settings };
      for (const [k, allowed] of Object.entries({
        defaultFormat: formats,
        defaultQuality: qualities,
        theme: ['light', 'dark', 'system'],
        language: ['pl', 'en'],
        edgeDragMode: ['crop', 'stretch'],
        captionLanguage: ['auto', 'pl', 'en'],
        captionModel: ['small', 'large-v3', 'large-v3-turbo'],
      })) {
        if (allowed.includes(patch[k])) next[k] = patch[k];
      }
      for (const [k, lo, hi] of [
        ['defaultWidth', 16, 8192],
        ['defaultHeight', 16, 8192],
        ['defaultFps', 1, 240],
        ['silenceDb', -100, 0],
        ['silenceDuration', 0.01, 120],
      ])
        if (finite(patch[k], lo, hi)) next[k] = patch[k];
      for (const k of ['timelineSnap', 'sceneSnap'])
        if (typeof patch[k] === 'boolean') next[k] = patch[k];
      for (const k of ['projectDir', 'outputDir'])
        if (typeof patch[k] === 'string' && path.isAbsolute(patch[k])) {
          await fs.mkdir(patch[k], { recursive: true });
          next[k] = patch[k];
        }
      await writeJson(this.configPath, next);
      this.settings = next;
      return { ...next };
    });
  }
  async remember(file, project) {
    return this.serial(async () => {
      this.known.set(file, project.id);
      this.settings.recent = [
        { path: file, name: project.name },
        ...this.settings.recent.filter((r) => r.path !== file),
      ].slice(0, 16);
      await writeJson(this.configPath, this.settings);
      return { path: file, project };
    });
  }
  async create(name, overrides = {}) {
    const s = this.settings;
    const project = validProject({
      schema: 1,
      id: randomUUID(),
      name: String(name || 'Project').trim() || 'Project',
      width: overrides.width ?? s.defaultWidth,
      height: overrides.height ?? s.defaultHeight,
      fps: overrides.fps ?? s.defaultFps,
      quality: overrides.quality ?? s.defaultQuality,
      format: overrides.format ?? s.defaultFormat,
      assets: {},
      clips: [],
    });
    const file = path.join(
      s.projectDir,
      filename(project.name) + ' - ' + project.id.slice(0, 8) + '.cutproj',
    );
    await writeJson(file, project);
    return this.remember(file, project);
  }
  async open(file) {
    const project = validProject(await readJson(file, null));
    return this.remember(file, project);
  }
  async save(file, project) {
    validProject(project);
    if (this.known.get(file) !== project.id) throw Error('Project location changed. Reopen the project.');
    return this.serial(async () => {
      await writeJson(file, project);
      const item = this.settings.recent.find((r) => r.path === file);
      if (item && item.name !== project.name) {
        item.name = project.name;
        await writeJson(this.configPath, this.settings);
      }
      return file;
    });
  }
}
module.exports = {
  Workspace,
  writeJson,
  readJson,
  validProject,
  filename,
  categories,
  formats,
  qualities,
};
