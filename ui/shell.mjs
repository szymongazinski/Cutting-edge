import { el, icon, btn, ib, group, by, api, error, notify, run, mediaUrl } from './dom.mjs';
import {
  state,
  t,
  project,
  rootProject,
  view,
  selected,
  selectIds,
  commit,
  history,
  prefs,
  flush,
  switchDoc,
  addAsset,
  importFiles,
  time,
  jumpIn,
  jumpOut,
} from './session.mjs';
import { mountEditor } from './editor.mjs';
import { editSourceCrop } from './geometry-form.mjs';
import { splitClip } from './model.mjs';
import { drawLibrary, drawRail, reloadLibrary } from './library-ui.mjs';
import { drawInspector } from './inspector.mjs';
import {
  newProject,
  projectSettings,
  settings,
  shortcuts,
  syncClips,
  silenceDialog,
  ratioLabel,
} from './dialogs.mjs';
import { textDialog, editCaptions } from './captions.mjs';
import { chatEvent } from './chat.mjs';
let menu,
  docId,
  closing = false,
  externalDoc = null,
  externalTimer;
function openWhenIdle(doc) {
  if (doc) externalDoc = doc;
  clearTimeout(externalTimer);
  externalTimer = setTimeout(() => {
    if (!externalDoc || by('overlays').childElementCount || state.jobs.size) return;
    const requested = externalDoc;
    externalDoc = null;
    switchDoc(requested).catch(error);
  }, 0);
}
const clearMenu = () => {
  menu?.remove();
  menu = null;
};
async function openProject(recent) {
  await flush();
  const doc = await api('projectOpen', { recent });
  if (doc) await switchDoc(doc);
}
function projectMenu() {
  if (menu) {
    clearMenu();
    return;
  }
  const items = [
    ['file-plus-2', t('Nowy projekt', 'New project'), newProject],
    ['folder-open', t('Otwórz projekt…', 'Open project…'), () => openProject()],
    [
      'save',
      t('Zapisz projekt', 'Save project'),
      async () => {
        await flush();
        notify(t('Projekt zapisany.', 'Project saved.'));
      },
    ],
    [
      'copy',
      t('Zapisz kopię jako…', 'Save a copy as…'),
      async () => {
        await flush();
        await switchDoc(await api('projectCopy', { project: rootProject() }));
      },
    ],
    ['sliders-horizontal', t('Ustawienia projektu', 'Project settings'), () => projectSettings()],
    [
      'clapperboard',
      t('Otwórz projekt przykładowy', 'Open sample project'),
      async () => {
        await flush();
        await switchDoc(await api('sample'));
      },
    ],
    [
      'folder',
      t('Folder projektów', 'Project folder'),
      () => api('folderOpen', { category: 'projects' }),
    ],
  ];
  menu = el('div', { class: 'menu', role: 'menu' });
  for (const [sym, label, fn] of items)
    menu.append(
      btn(
        sym,
        label,
        run(() => {
          clearMenu();
          return fn();
        }),
        'ghost',
      ),
    );
  const recent = state.settings.recent.filter((r) => r.path !== state.doc.path).slice(0, 4);
  if (recent.length) {
    menu.append(
      el('div', { class: 'divider' }),
      el('small', {}, t('Ostatnie projekty', 'Recent projects')),
      ...recent.map((r) =>
        btn(
          'clock-3',
          r.name,
          run(() => {
            clearMenu();
            return openProject(r.path);
          }),
          'ghost',
        ),
      ),
    );
  }
  by('project-menu').append(menu);
}
document.addEventListener('pointerdown', (e) => {
  if (!by('project-menu').contains(e.target)) clearMenu();
});
function status() {
  const p = rootProject(),
    s = by('status');
  s.replaceChildren(
    el(
      'span',
      { class: 'status-item' },
      el('i', { class: 'status-dot' }),
      state.status || t('Zapisano', 'Saved'),
    ),
    el('span', { class: 'status-item micro' }, p.width + ' × ' + p.height + '  ·  ' + p.fps + ' FPS'),
    el('span', { class: 'flex' }),
    btn('keyboard', t('Skróty', 'Shortcuts'), shortcuts, 'ghost'),
  );
}
const split = () => {
  const ids = [...state.selection],
    at = time();
  if (!ids.length) return;
  const result = commit((p) => ids.map((id) => splitClip(p, id, at)).filter(Boolean));
  if (result.length) selectIds(result.map((c) => c.id));
};
const remove = () => {
  const ids = [...state.selection];
  if (ids.length)
    commit((p) => {
      p.clips = p.clips.filter((c) => !ids.includes(c.id));
    });
};
const toggleTimeline = () => prefs({ timelineSnap: !state.settings.timelineSnap });
const toggleScene = () => prefs({ sceneSnap: !state.settings.sceneSnap });
function toolbar() {
  clearMenu();
  const p = project(),
    sel = selected(),
    top = by('top-actions');
  const projectButton = btn('folder', rootProject().name, projectMenu, 'ghost');
  projectButton.append(icon('chevron-down'));
  by('project-menu').replaceChildren(projectButton);
  const undo = ib('undo-2', t('Cofnij (Ctrl+Z)', 'Undo (Ctrl+Z)'), () => history(true)),
    redo = ib('redo-2', t('Ponów (Ctrl+Y)', 'Redo (Ctrl+Y)'), () => history(false));
  undo.disabled = !state.past.length;
  redo.disabled = !state.future.length;
  top.replaceChildren(
    undo,
    redo,
    el('i', { class: 'separator' }),
    ib('settings', t('Ustawienia', 'Settings'), settings),
    btn('upload', t('Eksportuj', 'Export'), () => projectSettings(true), 'primary'),
  );
  const pHeader = el('span', { class: 'heading' }, icon('monitor'), t('Podgląd', 'Preview'));
  by('monitor-head').replaceChildren(
    pHeader,
    group(
      btn(null, ratioLabel(p.width, p.height), () => projectSettings(), 'ghost'),
      ib(
        'scan',
        t('Przyciąganie na scenie (G)', 'Scene snapping (G)'),
        run(toggleScene),
        state.settings.sceneSnap ? 'active' : '',
      ),
    ),
  );
  const seq = by('timeline-head'),
    title = el('span', { class: 'heading section-title' }, icon('list-video'), t('Oś czasu', 'Timeline'));
  const sc = ib('scissors', t('Podziel przy głowicy (S)', 'Split at playhead (S)'), split);
  sc.disabled = !sel.length;
  const trash = ib('trash-2', t('Usuń klip (Delete)', 'Delete clip (Delete)'), remove);
  trash.disabled = !sel.length;
  const pair = ib(
    'link-2',
    t('Synchronizuj i utwórz klip złożony', 'Sync and create compound clip'),
    syncClips,
  );
  pair.disabled = sel.length < 2;
  seq.replaceChildren(
    title,
    ib(
      'import',
      t('Importuj media', 'Import media'),
      run(() => importFiles('media')),
    ),
    sc,
    trash,
    pair,
    ib('scissors-line-dashed', t('Wytnij ciszę', 'Remove silence'), () => silenceDialog()),
    el('i', { class: 'separator' }),
    ib(
      'magnet',
      t('Przyciąganie na osi (M)', 'Timeline snapping (M)'),
      run(toggleTimeline),
      state.settings.timelineSnap ? 'active' : '',
    ),
    el('span', { class: 'tool-label' }, t('Ctrl + kółko · skala osi', 'Ctrl + wheel · timeline zoom')),
  );
  const { parent } = view();
  if (parent) {
    seq.append(btn('layers', '↑ ' + parent.name, jumpOut, 'active'));
  }
  if (docId !== state.doc.path) {
    docId = state.doc.path;
    const recent = [
      { path: state.doc.path, name: rootProject().name },
      ...state.settings.recent.filter((r) => r.path !== state.doc.path),
    ];
    state.settings.recent = recent.slice(0, 16);
  }
}
function selection() {
  if (!state.doc) return;
  toolbar();
  drawInspector();
  state.editor?.refresh();
}
function draw() {
  if (!state.doc) return;
  document.documentElement.lang = state.settings.language;
  document.documentElement.dataset.theme = state.settings.theme;
  const controls = by('window-buttons');
  if (controls.dataset.lang !== state.settings.language) {
    controls.dataset.lang = state.settings.language;
    controls.replaceChildren(
      ...[
        ['minus', 'minimize', t('Minimalizuj', 'Minimize')],
        ['square', 'maximize', t('Maksymalizuj', 'Maximize')],
        ['x', 'close', t('Zamknij', 'Close')],
      ].map(([sym, action, name]) =>
        ib(
          sym,
          name,
          run(() => api('window', { action })),
        ),
      ),
    );
  }
  const portrait = project().height > project().width;
  by('work').classList.toggle('portrait', portrait);
  by('splitter').setAttribute('aria-orientation', portrait ? 'vertical' : 'horizontal');
  by('splitter').ariaLabel = t('Rozmiar podglądu', 'Preview size');
  toolbar();
  drawRail();
  drawLibrary();
  drawInspector();
  status();
  state.editor?.refresh();
  document.title = rootProject().name + ' · Cutting edge';
}
function wireKeys() {
  window.addEventListener(
    'keydown',
    run(async (e) => {
      if (!state.doc || by('overlays').children.length || e.defaultPrevented) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable)
        return;
      const key = e.key.toLowerCase(),
        ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && ['z', 'y', 's', 'o', 'n'].includes(key)) {
        e.preventDefault();
        if (key === 'z') history(!e.shiftKey);
        else if (key === 'y') history(false);
        else if (key === 's') {
          await flush();
          notify(t('Projekt zapisany.', 'Project saved.'));
        } else if (key === 'o') await openProject();
        else newProject();
        return;
      }
      if (ctrl || e.altKey) return;
      switch (key) {
        case ' ':
          e.preventDefault();
          state.editor.playPause();
          break;
        case 's':
          split();
          break;
        case 'm':
          await toggleTimeline();
          break;
        case 'g':
          await toggleScene();
          break;
        case 'delete':
        case 'backspace':
          e.preventDefault();
          remove();
          break;
        case 'arrowleft':
        case 'arrowright':
          e.preventDefault();
          state.editor.seek(Math.max(0, time() + (key === 'arrowleft' ? -1 : 1) / project().fps));
          break;
        case 'escape':
          clearMenu();
          selectIds([]);
          break;
      }
    }),
  );
}
function wireSplitter() {
  const divider = by('splitter'),
    work = by('work');
  const set = (val, isPortrait) => {
    const n = Math.max(isPortrait ? 22 : 19, Math.min(isPortrait ? 54 : 66, val));
    work.style.setProperty(isPortrait ? '--port' : '--low', n + '%');
    localStorage.setItem(isPortrait ? 'port' : 'low', String(n));
  };
  for (const k of ['low', 'port'])
    if (localStorage.getItem(k)) set(+localStorage.getItem(k), k === 'port');
  divider.onpointerdown = (e) => {
    divider.setPointerCapture(e.pointerId);
    const r = work.getBoundingClientRect(),
      portrait = work.classList.contains('portrait');
    divider.onpointermove = (ev) =>
      set(
        portrait ? ((r.right - ev.clientX) / r.width) * 100 : ((r.bottom - ev.clientY) / r.height) * 100,
        portrait,
      );
    divider.onlostpointercapture = () => (divider.onpointermove = null);
  };
  divider.onkeydown = (e) => {
    if (!e.key.startsWith('Arrow')) return;
    e.preventDefault();
    const portrait = work.classList.contains('portrait');
    set(
      +(localStorage.getItem(portrait ? 'port' : 'low') || 35) +
        (['ArrowUp', 'ArrowLeft'].includes(e.key) ? 2 : -2),
      portrait,
    );
  };
}
async function boot() {
  Object.assign(state.commands, { draw, selection, status, reloadLibrary });
  wireSplitter();
  wireKeys();
  new MutationObserver(() => {
    if (externalDoc) openWhenIdle();
  }).observe(by('overlays'), { childList: true });
  const { doc, settings: stored, version, warning } = await api('boot');
  state.settings = stored;
  state.version = version;
  state.status = t('Zapisano', 'Saved');
  state.doc = doc;
  const first = doc.project.clips.find(
    (c) => c.kind === 'media' && doc.project.assets[c.assetId]?.kind === 'video',
  );
  if (first) state.selection = [first.id];
  state.editor = mountEditor({
    stage: by('stage'),
    timeline: by('timeline'),
    transport: by('transport'),
    getProject: project,
    getSelection: () => state.selection,
    select: selectIds,
    commit,
    onTime: () => {},
    flags: () => ({
      timelineSnap: state.settings.timelineSnap,
      sceneSnap: state.settings.sceneSnap,
      edgeDragMode: state.settings.edgeDragMode,
      language: state.settings.language,
    }),
    translate: t,
    assetUrl: mediaUrl,
    dropAsset: addAsset,
    cropSource: run(editSourceCrop),
    inspect: (id) => {
      const c = project().clips.find((c) => c.id === id);
      if (!c) return;
      selectIds([id]);
      if (c.kind === 'compound') jumpIn(c);
      else if (c.kind === 'text') textDialog(c);
      else if (c.kind === 'caption') editCaptions(c);
      else {
        state.panel = 'inspect';
        drawInspector();
      }
    },
  });
  window.cutting.subscribe((event, data) => {
    if (event === 'progress') state.jobs.get(data.job)?.update(data.value);
    if (event === 'jobStatus') state.jobs.get('transcribe')?.update(data);
    if (event === 'assistantEvent') chatEvent(data);
    if (event === 'error') error(data);
    if (event === 'externalOpen') openWhenIdle(data);
    if (event === 'closeRequested' && !closing) {
      closing = true;
      flush()
        .then(() => api('window', { action: 'closeReady' }))
        .catch((e) => {
          closing = false;
          error(e);
        });
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  by('app').ariaBusy = 'false';
  draw();
  if (warning) error(warning);
  if (doc.missing?.length) error(t('Brakujące pliki: ', 'Missing files: ') + doc.missing.join(', '));
}
boot().catch((e) => {
  console.error(e);
  error(e);
});
