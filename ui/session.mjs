import { api, notify, error, progressDialog } from './dom.mjs';
import { makeClip, endTime, fullBox } from './model.mjs';
export const state = {
  doc: null,
  settings: null,
  version: '',
  revision: 0,
  selection: [],
  nested: [],
  category: 'media',
  assetId: null,
  query: '',
  panel: 'inspect',
  editor: null,
  library: {},
  templates: [],
  past: [],
  future: [],
  commands: {},
  status: '',
  jobs: new Map(),
  chat: new Map(),
  preset: 'classic',
};
export const t = (pl, en) => (state.settings?.language === 'en' ? en : pl);
export const rootProject = () => state.doc.project;
export function view() {
  const root = rootProject();
  let clips = root.clips,
    parent = null;
  const valid = [],
    ancestors = [];
  for (const id of state.nested) {
    const c = clips.find((o) => o.id === id && o.kind === 'compound');
    if (!c) break;
    valid.push(id);
    ancestors.push(c);
    parent = c;
    clips = c.children;
  }
  if (valid.length !== state.nested.length) state.nested = valid;
  return { project: parent ? { ...root, clips } : root, parent, ancestors };
}
export const project = () => view().project;
export const selected = () => project().clips.filter((c) => state.selection.includes(c.id));
export const chosen = () => selected().at(-1);
export const assetById = (id) =>
  rootProject().assets[id] ||
  Object.values(state.library)
    .flat()
    .find((a) => a.id === id);
export function selectIds(ids) {
  state.selection = ids;
  state.commands.selection?.();
}
export const time = () => state.editor?.getTime() || 0;
export const redraw = () => state.commands.draw?.();
let pendingTimer,
  saving = Promise.resolve(),
  pending = null;
export function scheduleSave() {
  const p = rootProject();
  pending = { path: state.doc.path, project: structuredClone(p), revision: state.revision };
  clearTimeout(pendingTimer);
  state.status = t('Zapisywanie…', 'Saving…');
  state.commands.status?.();
  pendingTimer = setTimeout(() => flush().catch(error), 250);
}
export async function flush() {
  clearTimeout(pendingTimer);
  const next = pending;
  pending = null;
  if (next) {
    saving = saving
      .catch(() => {})
      .then(async () => {
        try {
          await api('projectSave', { path: next.path, project: next.project });
          if (state.doc.path === next.path && next.revision === state.revision)
            state.status = t('Zapisano', 'Saved');
        } catch (e) {
          if (state.doc.path !== next.path || state.revision !== next.revision) return;
          if (!pending) pending = next;
          state.status = t('Błąd zapisu', 'Save failed');
          throw e;
        } finally {
          state.commands.status?.();
        }
      });
  }
  await saving;
}
export function commit(fn) {
  const before = JSON.stringify(rootProject());
  const { project: p, parent, ancestors } = view();
  const fullLengths = ancestors.map((c) => endTime({ clips: c.children }));
  let value;
  try {
    value = fn(p);
    if (parent) parent.children = p.clips;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const c = ancestors[i],
        len = Math.max(1 / p.fps, endTime({ clips: c.children }));
      if (Math.abs(fullLengths[i] - c.in - c.duration) < 1e-6)
        c.duration = Math.max(1 / p.fps, len - c.in);
      c.in = Math.max(0, Math.min(c.in, len - 1 / p.fps));
      c.duration = Math.min(c.duration, len - c.in);
    }
  } catch (e) {
    state.doc.project = JSON.parse(before);
    throw e;
  }
  if (before !== JSON.stringify(rootProject())) {
    state.past.push(before);
    if (state.past.length > 75) state.past.shift();
    state.future = [];
    state.revision++;
    scheduleSave();
  }
  state.selection = state.selection.filter((id) => project().clips.some((c) => c.id === id));
  redraw();
  return value;
}
export function history(back) {
  const stack = back ? state.past : state.future;
  if (!stack.length) return;
  (back ? state.future : state.past).push(JSON.stringify(rootProject()));
  state.doc.project = JSON.parse(stack.pop());
  state.revision++;
  state.selection = [];
  scheduleSave();
  redraw();
}
export async function switchDoc(doc) {
  if (!doc) return;
  await flush();
  state.editor?.seek(0);
  state.doc = doc;
  state.nested = [];
  state.selection = doc.project.clips.find(
    (c) => c.kind === 'media' && doc.project.assets[c.assetId]?.kind === 'video',
  )?.id
    ? [
        doc.project.clips.find(
          (c) => c.kind === 'media' && doc.project.assets[c.assetId]?.kind === 'video',
        ).id,
      ]
    : [];
  state.assetId = null;
  state.past = [];
  state.future = [];
  state.revision++;
  state.status = t('Zapisano', 'Saved');
  state.category = 'media';
  state.query = '';
  if (doc.missing?.length)
    notify(t('Brakujące źródła: ', 'Missing sources: ') + doc.missing.join(', '), 'error');
  redraw();
  state.editor?.seek(0);
}
export async function prefs(patch) {
  state.settings = await api('preferences', { patch });
  if (['Zapisano', 'Saved'].includes(state.status)) state.status = t('Zapisano', 'Saved');
  redraw();
  return state.settings;
}
export async function library(category, force = false) {
  if (category === 'media')
    return Object.values(rootProject().assets).filter(
      (a) => a.category === 'media' || a.category === 'global',
    );
  if (force || !state.library[category]) {
    const { assets, errors } = await api('libraryList', { category });
    state.library[category] = assets;
    if (errors.length) error(errors.join('\n'));
  }
  return state.library[category];
}
export function addAsset(id, start = time(), track) {
  const asset = assetById(id);
  if (!asset) return;
  const p = project();
  if (track === undefined) {
    const present = p.clips
      .filter((c) => c.start < start + 0.0001 && c.start + c.duration > start + 0.0001)
      .map((c) => c.track);
    track = present.length ? Math.max(...present) + 1 : 0;
  }
  const clip = commit((doc) => {
    doc.assets[asset.id] = asset;
    const c = makeClip(doc, asset, start, track);
    if (asset.category === 'sticker') {
      const s = 0.26 / Math.max(c.box.w, c.box.h);
      c.box = { x: 0.66, y: 0.08, w: c.box.w * s, h: c.box.h * s };
    }
    doc.clips.push(c);
    return c;
  });
  state.assetId = id;
  selectIds([clip.id]);
  return clip;
}
export async function importFiles(category = state.category, files, group) {
  const name = t('Importowanie mediów', 'Importing media');
  const result = await busy('mediaImport', name, () => api('mediaImport', { category, files, group }));
  if (result.assets.length) {
    if (category === 'media')
      commit((p) => {
        for (const a of result.assets) p.assets[a.id] = a;
      });
    else {
      state.library[category] = undefined;
      await library(category, true);
    }
    state.assetId = result.assets[0].id;
    redraw();
  }
  if (result.errors.length) error(result.errors.join('\n'));
  return result.assets;
}
export async function busy(key, title, fn, detail = '') {
  const dlg = progressDialog(title, detail);
  state.jobs.set(key, dlg);
  try {
    return await fn(dlg);
  } finally {
    state.jobs.delete(key);
    dlg.close();
  }
}
export function subset(p, clip) {
  return { ...p, clips: clip ? [{ ...structuredClone(clip), start: 0 }] : structuredClone(p.clips) };
}
export function textClip(kind, text, box, style, duration, start = time(), track) {
  return {
    id: crypto.randomUUID(),
    kind,
    name:
      kind === 'caption'
        ? t('Napisy', 'Captions')
        : text.trim().split('\n')[0].slice(0, 48) || t('Tekst', 'Text'),
    text,
    style,
    start,
    in: 0,
    duration: Math.max(1 / project().fps, duration),
    track: track ?? Math.max(-1, ...project().clips.map((c) => c.track)) + 1,
    box: { ...box },
    crop: fullBox(),
    volume: 1,
    muted: false,
    ...(kind === 'caption' ? { cues: [] } : {}),
  };
}
export function changeClip(id, patch) {
  return commit((p) => {
    const c = p.clips.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, patch);
    if (c.kind === 'media') {
      const a = p.assets[c.assetId],
        loop = a.kind === 'image' || (a.kind === 'video' && ['sticker', 'visualfx'].includes(a.category));
      if (!loop) {
        c.in = Math.min(Math.max(0, c.in), Math.max(0, a.duration - 1 / p.fps));
        c.duration = Math.min(c.duration, a.duration - c.in);
      }
    }
  });
}
export function jumpIn(c) {
  state.nested.push(c.id);
  state.selection = [];
  state.editor.seek(0);
  redraw();
}
export function jumpOut() {
  state.nested.pop();
  state.selection = [];
  state.editor.seek(0);
  redraw();
}
