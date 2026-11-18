import {
  el,
  btn,
  ib,
  group,
  fields,
  field,
  select,
  number,
  input,
  modal,
  formAction,
  api,
  notify,
  run,
  humanTime,
} from './dom.mjs';
import {
  state,
  t,
  project,
  rootProject,
  selected,
  chosen,
  assetById,
  commit,
  selectIds,
  switchDoc,
  prefs,
  flush,
  busy,
  time,
  subset,
} from './session.mjs';
import { makeCompound, makeClip, cutSilence, endTime } from './model.mjs';
import { fitCues, fitTitle, measureText, reframeBox } from './layout.mjs';
const cancel = () => t('Anuluj', 'Cancel');
export const ratioLabel = (w, h) => {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  return w / g + ':' + h / g;
};
const ratios = [
  [1920, 1080],
  [1080, 1920],
  [1080, 1080],
  [1080, 1350],
  [1280, 720],
  [720, 1280],
  [3840, 2160],
  [2160, 3840],
];
function outputFields(v) {
  const width = number(v.width, { min: 16, max: 8192, step: 2 }),
    height = number(v.height, { min: 16, max: 8192, step: 2 });
  const resolution = select(
    [
      ...ratios.map(([w, h]) => [w + 'x' + h, ratioLabel(w, h) + '  ·  ' + w + ' × ' + h]),
      ['custom', t('Własne wymiary', 'Custom size')],
    ],
    ratios.some(([w, h]) => w === v.width && h === v.height) ? v.width + 'x' + v.height : 'custom',
  );
  const sync = () => {
    if (resolution.value !== 'custom') {
      const [w, h] = resolution.value.split('x');
      width.value = w;
      height.value = h;
    }
  };
  resolution.onchange = sync;
  width.oninput = height.oninput = () => {
    resolution.value = 'custom';
  };
  const format = select(
    ['mp4', 'mov', 'mkv', 'webm'].map((f) => [f, f.toUpperCase()]),
    v.format,
  );
  const fps = number(v.fps, { min: 1, max: 120, step: 'any' });
  const quality = select(
    [
      ['draft', t('Robocza', 'Draft')],
      ['balanced', t('Zrównoważona', 'Balanced')],
      ['high', t('Wysoka', 'High')],
    ],
    v.quality,
  );
  return {
    ui: el(
      'div',
      { class: 'stack' },
      field(t('Proporcje i rozdzielczość', 'Aspect ratio and resolution'), resolution),
      fields(
        field(t('Szerokość (px)', 'Width (px)'), width),
        field(t('Wysokość (px)', 'Height (px)'), height),
      ),
      fields(
        field(t('Format pliku', 'File format'), format),
        field(t('Klatki na sekundę', 'Frames per second'), fps),
      ),
      field(t('Jakość', 'Quality'), quality),
    ),
    value: () => ({
      width: +width.value,
      height: +height.value,
      fps: +fps.value,
      quality: quality.value,
      format: format.value,
    }),
  };
}
function resizeProject(p, values) {
  const old = { width: p.width, height: p.height };
  Object.assign(p, values);
  if (old.width === p.width && old.height === p.height) return;
  const resize = (list) => {
    for (const c of list) {
      if (c.kind === 'compound') {
        resize(c.children);
        continue;
      }
      if (c.kind === 'media' && p.assets[c.assetId]?.kind !== 'audio') {
        c.box = reframeBox(c.box, old.width, old.height, p.width, p.height);
      }
      if (c.style) {
        c.style.size = Math.max(
          1,
          Math.round((c.style.size * Math.min(p.width, p.height)) / Math.min(old.width, old.height)),
        );
        if (c.kind === 'caption') {
          const f = fitCues(c.cues, c.box, p, c.style, measureText);
          c.style = f.style;
          c.cues = f.cues;
        } else if (c.kind === 'text') Object.assign(c, fitTitle(c.text, c.box, p, c.style));
      }
    }
  };
  resize(p.clips);
}
export function newProject() {
  const s = state.settings,
    m = modal(t('Nowy projekt', 'New project'));
  const name = input('text', t('Bez tytułu', 'Untitled'), { required: true, maxLength: 110 });
  const f = outputFields({
    width: s.defaultWidth,
    height: s.defaultHeight,
    fps: s.defaultFps,
    format: s.defaultFormat,
    quality: s.defaultQuality,
  });
  m.body.append(field(t('Nazwa projektu', 'Project name'), name), f.ui);
  formAction(
    m,
    t('Utwórz projekt', 'Create project'),
    async () => {
      await flush();
      await switchDoc(await api('projectNew', { name: name.value.trim(), options: f.value() }));
    },
    cancel(),
  );
  requestAnimationFrame(() => name.select());
}
export function projectSettings(exporting = false) {
  const p = rootProject(),
    m = modal(
      exporting ? t('Eksport filmu', 'Export video') : t('Ustawienia projektu', 'Project settings'),
    );
  const f = outputFields(p),
    name = input('text', p.name, { required: true, maxLength: 110 });
  m.body.append(field(t('Nazwa projektu', 'Project name'), name), f.ui);
  if (exporting)
    m.body.append(
      el(
        'small',
        {},
        t('Długość filmu', 'Film duration') +
          ' · ' +
          humanTime(endTime(p)) +
          '  /  ' +
          state.settings.outputDir,
      ),
    );
  formAction(
    m,
    exporting ? t('Wybierz plik i eksportuj', 'Choose file and export') : t('Zapisz', 'Save'),
    async () => {
      commit(() => {
        resizeProject(rootProject(), f.value());
        rootProject().name = name.value.trim();
      });
      if (exporting) {
        if (!rootProject().clips.length) {
          notify(t('Dodaj klip na oś czasu.', 'Add a clip to the timeline.'), 'error');
          return false;
        }
        await flush();
        const dest = await busy('render', t('Eksport filmu', 'Exporting video'), () =>
          api('render', { project: rootProject() }),
        );
        if (dest) notify(t('Zapisano film w ', 'Video saved to ') + dest, 'info', true);
        if (!dest) return false;
      }
    },
    cancel(),
  );
}
export function settings() {
  const s = state.settings,
    m = modal(t('Ustawienia aplikacji', 'Application settings'), { wide: true });
  const lang = select(
      [
        ['pl', 'Polski'],
        ['en', 'English'],
      ],
      s.language,
    ),
    theme = select(
      [
        ['system', t('Systemowy', 'System')],
        ['dark', t('Ciemny', 'Dark')],
        ['light', t('Jasny', 'Light')],
      ],
      s.theme,
    ),
    edgeDragMode = select(
      [
        ['crop', t('Kadruj (Ctrl rozciąga)', 'Crop (Ctrl stretches)')],
        ['stretch', t('Rozciągaj (Ctrl kadruje)', 'Stretch (Ctrl crops)')],
      ],
      s.edgeDragMode || 'crop',
    );
  const dir = (name, value) => {
    const n = input('text', value, { required: true });
    return {
      ui: field(
        name,
        group(
          n,
          ib(
            'folder-open',
            t('Wybierz folder', 'Choose folder'),
            run(async () => {
              const d = await api('directory', { current: n.value });
              if (d) n.value = d;
            }),
          ),
        ),
      ),
      n,
    };
  };
  const projectDir = dir(t('Folder projektów', 'Project folder'), s.projectDir),
    outputDir = dir(t('Folder gotowych filmów', 'Export folder'), s.outputDir);
  const f = outputFields({
    width: s.defaultWidth,
    height: s.defaultHeight,
    fps: s.defaultFps,
    format: s.defaultFormat,
    quality: s.defaultQuality,
  });
  const update = el('small', {}, 'Cutting edge ' + state.version);
  const check = btn(
    'refresh-cw',
    t('Sprawdź aktualizacje', 'Check for updates'),
    run(async () => {
      check.disabled = true;
      try {
        const r = await api('updateCheck');
        update.textContent = r.available
          ? t('Dostępna wersja ', 'Available version ') + r.version
          : t('Masz najnowszą wersję.', 'You have the latest version.');
        if (r.available && !m.body.querySelector('#install-update')) {
          const b = btn(
            'download',
            t('Zainstaluj aktualizację', 'Install update'),
            run(async () => {
              await flush();
              await busy('updateInstall', t('Pobieranie aktualizacji', 'Downloading update'), () =>
                api('updateInstall'),
              );
            }),
            'primary',
          );
          b.id = 'install-update';
          m.body.append(b);
        }
      } finally {
        check.disabled = false;
      }
    }),
  );
  m.body.append(
    fields(field(t('Język', 'Language'), lang), field(t('Motyw', 'Appearance'), theme)),
    field(t('Uchwyty krawędzi źródła', 'Source edge handles'), edgeDragMode),
    projectDir.ui,
    outputDir.ui,
    el('h3', {}, t('Domyślne ustawienia nowych projektów', 'Defaults for new projects')),
    f.ui,
    group(check, update),
  );
  formAction(
    m,
    t('Zapisz ustawienia', 'Save settings'),
    async () => {
      const a = f.value();
      await prefs({
        language: lang.value,
        theme: theme.value,
        edgeDragMode: edgeDragMode.value,
        projectDir: projectDir.n.value,
        outputDir: outputDir.n.value,
        defaultWidth: a.width,
        defaultHeight: a.height,
        defaultFps: a.fps,
        defaultFormat: a.format,
        defaultQuality: a.quality,
      });
    },
    cancel(),
  );
}
export function shortcuts() {
  const m = modal(t('Skróty klawiszowe', 'Keyboard shortcuts')),
    table = el('div', { class: 'shortcuts' });
  const rows = [
    [t('Odtwórz / pauza', 'Play / pause'), 'Space'],
    [t('Powiększ oś czasu', 'Zoom timeline'), 'Ctrl + ' + t('kółko', 'wheel')],
    [t('Przełącz magnes na osi', 'Toggle timeline snapping'), 'M'],
    [t('Przełącz magnes sceny', 'Toggle scene snapping'), 'G'],
    [
      t('Przeciągaj krawędź źródła w drugim trybie', 'Use the alternate edge drag mode'),
      t('Przytrzymaj Ctrl', 'Hold Ctrl'),
    ],
    [t('Podziel klip', 'Split clip'), 'S'],
    [t('Zaznacz kilka klipów', 'Select multiple clips'), 'Ctrl / Shift + click'],
    [t('Usuń zaznaczenie z osi', 'Delete selection'), 'Delete'],
    [t('Cofnij / ponów', 'Undo / redo'), 'Ctrl + Z / Y'],
    [t('Zapisz projekt', 'Save project'), 'Ctrl + S'],
    [t('Otwórz projekt', 'Open project'), 'Ctrl + O'],
    [t('Nowy projekt', 'New project'), 'Ctrl + N'],
    [t('Klatka w lewo / w prawo', 'Previous / next frame'), '← / →'],
  ];
  for (const [a, b] of rows) table.append(el('span', {}, a), el('kbd', {}, b));
  m.body.append(table);
  m.foot.append(btn(null, 'OK', m.close));
}
export function syncClips() {
  const list = selected();
  if (list.length < 2) {
    notify(
      t(
        'Zaznacz co najmniej dwa klipy na osi, trzymając Ctrl.',
        'Ctrl-click at least two clips on the timeline.',
      ),
    );
    return;
  }
  const m = modal(t('Synchronizacja źródeł', 'Synchronize sources'));
  const min = Math.min(...list.map((c) => c.start)),
    name = input('text', t('Klip złożony', 'Compound clip'), { required: true });
  m.body.append(
    field(t('Nazwa klipu złożonego', 'Compound clip name'), name),
    el(
      'small',
      {},
      t(
        'Ustaw przesunięcia od początku wspólnego klipu. Odsłuch na osi czasu pozwala dopasować nagrania przed połączeniem.',
        'Set offsets from the common start. Audition the recordings on the timeline before grouping.',
      ),
    ),
  );
  const offsets = list.map((c) => {
    const n = number(c.start - min, { min: 0, max: 86400, step: 'any' });
    m.body.append(field(c.name + ' · ' + t('przesunięcie (s)', 'offset (s)'), n));
    return n;
  });
  const ids = list.map((c) => c.id);
  formAction(
    m,
    t('Połącz źródła', 'Create compound clip'),
    () => {
      const c = commit((p) => {
        for (const [index, id] of ids.entries())
          p.clips.find((c) => c.id === id).start = min + Number(offsets[index].value);
        const out = makeCompound(p, ids);
        out.name = name.value.trim();
        return out;
      });
      selectIds([c.id]);
    },
    cancel(),
  );
}
export function silenceDialog(libraryAsset) {
  const p = project(),
    picked = chosen(),
    available = Object.values(p.assets);
  const items = [
    ...p.clips
      .filter((c) => ['media', 'compound'].includes(c.kind))
      .map((c) => ['c:' + c.id, t('Klip', 'Clip') + ' · ' + c.name]),
    ...available.map((a) => ['a:' + a.id, t('Całe źródło', 'Full source') + ' · ' + a.name]),
  ];
  if (libraryAsset && !available.some((a) => a.id === libraryAsset.id))
    items.push(['a:' + libraryAsset.id, t('Całe źródło', 'Full source') + ' · ' + libraryAsset.name]);
  if (!items.length) {
    notify(t('Dodaj źródło dźwięku lub wideo.', 'Add an audio or video source.'));
    return;
  }
  const m = modal(t('Wytnij ciszę', 'Remove silence')),
    source = select(
      items,
      libraryAsset
        ? 'a:' + libraryAsset.id
        : picked && items.some((i) => i[0] === 'c:' + picked.id)
          ? 'c:' + picked.id
          : items[0][0],
    );
  const db = number(state.settings.silenceDb, { min: -100, max: 0, step: 0.5 }),
    duration = number(state.settings.silenceDuration, { min: 0.01, max: 120, step: 0.01 });
  m.body.append(
    field(t('Analizuj', 'Analyze'), source),
    fields(
      field(t('Próg ciszy (dB)', 'Silence threshold (dB)'), db),
      field(t('Minimalna cisza (s)', 'Minimum silence (s)'), duration),
    ),
  );
  formAction(
    m,
    t('Znajdź ciszę', 'Detect silence'),
    async () => {
      const [kind, id] = source.value.split(':');
      const doc = project(),
        asset = kind === 'a' ? assetById(id) || libraryAsset : null;
      const c = asset ? makeClip(doc, asset, 0, 0) : doc.clips.find((c) => c.id === id);
      const inputDoc = subset(doc, c);
      if (asset) inputDoc.assets = { ...inputDoc.assets, [asset.id]: asset };
      await prefs({ silenceDb: +db.value, silenceDuration: +duration.value });
      const ranges = await busy('silence', t('Analiza ciszy', 'Analyzing silence'), () =>
        api('silence', { project: inputDoc, db: +db.value, minDuration: +duration.value }),
      );
      const seconds = ranges.reduce((s, r) => s + Math.max(0, r.end - r.start), 0);
      if (!ranges.length) {
        notify(t('Nie wykryto ciszy przy podanych progach.', 'No silence found at these thresholds.'));
        return;
      }
      const review = modal(t('Wynik analizy', 'Silence analysis'));
      review.body.append(
        el('strong', {}, c.name),
        el('p', {}, t('Liczba przerw', 'Silent intervals') + ' · ' + ranges.length),
        el('p', {}, t('Łączny czas do wycięcia', 'Time to remove') + ' · ' + seconds.toFixed(2) + ' s'),
      );
      formAction(
        review,
        t('Wytnij ciszę', 'Remove silence'),
        () => {
          if (asset) {
            const scratch = { ...doc, assets: { ...doc.assets, [asset.id]: asset }, clips: [c] };
            cutSilence(scratch, c.id, ranges);
            if (!scratch.clips.length) {
              notify(
                t('Całe źródło mieści się poniżej progu.', 'The whole source is below the threshold.'),
              );
              return;
            }
            const result =
              scratch.clips.length === 1
                ? scratch.clips[0]
                : makeCompound(
                    scratch,
                    scratch.clips.map((c) => c.id),
                  );
            result.start = time();
            result.track = Math.max(-1, ...doc.clips.map((c) => c.track)) + 1;
            result.name = asset.name + ' · ' + t('bez ciszy', 'silence removed');
            commit((d) => {
              d.assets[asset.id] = asset;
              d.clips.push(result);
            });
            selectIds([result.id]);
          } else {
            const result = commit((d) => cutSilence(d, c.id, ranges));
            selectIds((result || []).map((a) => a.id));
          }
        },
        cancel(),
      );
    },
    cancel(),
  );
}
