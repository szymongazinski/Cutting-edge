import {
  el,
  icon,
  ib,
  btn,
  group,
  input,
  select,
  field,
  modal,
  formAction,
  api,
  run,
  mediaUrl,
  humanTime,
  by,
} from './dom.mjs';
import { state, t, project, assetById, importFiles, library, addAsset, redraw } from './session.mjs';
import { captionDialog, textDialog, exportCaptions, presetTiles } from './captions.mjs';
import { editTemplate, applyTemplate } from './templates.mjs';
import { silenceDialog, settings } from './dialogs.mjs';
const names = () => ({
  media: t('Media projektu', 'Project media'),
  global: t('Media globalne', 'Global media'),
  audiofx: t('Efekty audio', 'Audio effects'),
  visualfx: t('Efekty wizualne', 'Visual effects'),
  sticker: t('Naklejki', 'Stickers'),
  captions: t('Tekst i napisy', 'Text and captions'),
  templates: t('Szablony', 'Templates'),
});
const symbols = {
  media: 'film',
  global: 'globe',
  audiofx: 'audio-lines',
  visualfx: 'sparkles',
  sticker: 'sticker',
  captions: 'captions',
  templates: 'layout-template',
};
let ticket = 0;
const loading = new Set();
const familyNames = new Map([
  ['Straight Arrow Thin', 'Prosta strzałka cienka'],
  ['Straight Arrow Bold', 'Prosta strzałka gruba'],
  ['Curved Arrow Thin', 'Zakręcona strzałka cienka'],
  ['Curved Arrow Bold', 'Zakręcona strzałka gruba'],
  ['Draw-On Straight Arrow Thin', 'Rysowana cienka strzałka prosta'],
  ['Draw-On Straight Arrow Bold', 'Rysowana gruba strzałka prosta'],
  ['Draw-On Curved Arrow Thin', 'Rysowana cienka strzałka zakręcona'],
  ['Draw-On Curved Arrow Bold', 'Rysowana gruba strzałka zakręcona'],
  ['Clean Circle', 'Kółko'],
  ['Sketched Circle', 'Kółko odręczne'],
  ['Double Circle', 'Kółko podwójne'],
  ['Single Underline', 'Podkreślenie pojedyncze'],
  ['Double Underline', 'Podkreślenie podwójne'],
]);
const colorNames = new Map([
  ['Coral', 'Koralowy'], ['Gold', 'Złoty'], ['Mint', 'Miętowy'],
  ['Violet', 'Fioletowy'], ['White', 'Biały'], ['Ink', 'Atramentowy'],
]);
const familyLabel = (name) => t(familyNames.get(name) ?? name, name);
const variantLabel = (name) => t(colorNames.get(name) ?? name, name);
const familyKey = (name) => name.normalize('NFC').toLowerCase();
function stickerFamilies(assets) {
  const folders = new Set(assets.map((asset) => asset.group || asset.name));
  const folderKeys = new Set([...folders].map(familyKey));
  const choices = new Map();
  for (const folder of folders) {
    const translated = familyLabel(folder);
    let label = translated, value = translated;
    if (translated !== folder && folderKeys.has(familyKey(translated))) {
      // A real folder has claimed this translation. Keep both folders selectable.
      const qualified = `${translated} (${folder})`;
      label = folderKeys.has(familyKey(qualified)) ? folder : qualified;
      value = folder;
    }
    choices.set(folder, { label, value });
  }
  return choices;
}
function folderForInput(choices, input) {
  const typed = input.trim();
  if (!typed || choices.has(typed)) return typed || undefined;
  const key = familyKey(typed);
  for (const folder of choices.keys()) if (familyKey(folder) === key) return folder;
  for (const [folder, { label }] of choices) {
    const translated = familyNames.get(folder);
    if (familyKey(label) === key || (translated && familyKey(translated) === key)) return folder;
  }
  return typed;
}
export async function changeCategory(cat) {
  state.category = cat;
  state.query = '';
  state.assetId = null;
  redraw();
  await reloadLibrary();
}
export async function reloadLibrary() {
  const cat = state.category,
    seq = ++ticket;
  if (cat === 'templates') state.templates = await api('templates');
  else if (cat !== 'captions' && cat !== 'media') {
    loading.add(cat);
    drawLibrary();
    try {
      await library(cat, true);
    } finally {
      loading.delete(cat);
    }
  }
  if (seq === ticket && cat === state.category) drawLibrary();
}
export function drawRail() {
  const categories = [
    ['media', t('Media', 'Media')],
    ['audiofx', t('Audio', 'Audio')],
    ['visualfx', t('Efekty', 'Effects')],
    ['sticker', t('Naklejki', 'Stickers')],
    ['captions', t('Napisy', 'Captions')],
    ['templates', t('Szablony', 'Templates')],
  ];
  const rail = by('rail');
  rail.replaceChildren(
    ...categories.map(([cat, label]) =>
      el(
        'button',
        {
          type: 'button',
          class:
            'railbtn ' +
            (state.category === cat || (cat === 'media' && state.category === 'global') ? 'active' : ''),
          title: names()[cat],
          onclick: run(() => changeCategory(cat)),
        },
        icon(symbols[cat]),
        label,
      ),
    ),
    el('div', { class: 'rail-spacer' }),
    el(
      'button',
      { class: 'railbtn', title: t('Ustawienia', 'Settings'), onclick: settings },
      icon('settings'),
      t('Opcje', 'Settings'),
    ),
  );
}
function tile(title, body, symbol, onClick) {
  return el(
    'button',
    { type: 'button', class: 'tool-card', onclick: run(onClick) },
    icon(symbol),
    el('div', {}, el('strong', {}, title), el('small', {}, body)),
  );
}
function startImport(cat) {
  if (cat !== 'sticker') return importFiles(cat);
  const m = modal(t('Dodaj naklejkę lub wariant', 'Add sticker or variant'));
  const choices = stickerFamilies(state.library.sticker || []);
  const list = el(
    'datalist',
    { id: 'sticker-groups' },
    [...choices.values()].map(({ label, value }) => el('option', { value, label })),
  );
  const family = input('text', '', {
    list: 'sticker-groups',
    placeholder: t('np. Strzałka', 'e.g. Arrow'),
  });
  m.body.append(
    list,
    field(t('Rodzina naklejek', 'Sticker family'), family),
    el(
      'small',
      {},
      t(
        'Wybierz istniejącą rodzinę, aby dodać kolor lub wersję. Nazwa pliku stanie się nazwą wariantu.',
        'Choose an existing family to add a color or version. The filename becomes the variant name.',
      ),
    ),
  );
  formAction(
    m,
    t('Wybierz pliki', 'Choose files'),
    () => importFiles('sticker', undefined, folderForInput(choices, family.value)),
    t('Anuluj', 'Cancel'),
  );
}
const searchFilter = (a, q, displayName) =>
  [a.name, a.group, a.variant, displayName, familyLabel(a.group), variantLabel(a.variant)]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase()
    .includes(q.toLocaleLowerCase());
function makeAsset(a, variants, familyName) {
  let current = a;
  const holder = el('div', {
    class: 'asset ' + (state.assetId === a.id ? 'active' : ''),
    draggable: true,
    tabIndex: 0,
    role: 'button',
  });
  function selectAsset() {
    state.assetId = current.id;
    document.querySelectorAll('.asset.active').forEach((n) => n.classList.remove('active'));
    holder.classList.add('active');
    state.commands.assetTools?.();
  }
  function paint() {
    const thumb = el('div', {
      class: 'asset-thumb ' + (['sticker', 'visualfx'].includes(current.category) ? 'fx' : ''),
    });
    if (current.thumbnail || current.kind === 'image') {
      const animated = current.category === 'sticker' && current.path.toLowerCase().endsWith('.gif');
      thumb.append(
        el('img', {
          src: mediaUrl(animated ? current.path : current.thumbnail || current.path),
          alt: '',
          draggable: false,
        }),
      );
    } else if (current.waveform?.length) {
      const peak = Math.max(0.001, ...current.waveform),
        step = Math.max(1, Math.floor(current.waveform.length / 40));
      thumb.append(
        el(
          'span',
          { class: 'wave' },
          current.waveform
            .filter((_, i) => i % step === 0)
            .map((v) => el('i', { style: { height: Math.max(3, (95 * v) / peak) + '%' } })),
        ),
      );
    } else thumb.append(icon(current.kind === 'audio' ? 'audio-lines' : 'film'));
    thumb.append(
      el(
        'span',
        { class: 'duration' },
        current.kind === 'image' ? t('Obraz', 'Still') : humanTime(current.duration),
      ),
    );
    if (variants?.length > 1) thumb.append(el('span', { class: 'variant-note' }, '×' + variants.length));
    const label = el(
      'div',
      { class: 'asset-name' },
      icon(
        current.kind === 'audio'
          ? 'audio-lines'
          : current.kind === 'image'
            ? 'image'
            : current.category === 'sticker'
              ? 'sticker'
              : 'film',
      ),
      el('span', {}, variants ? familyName : current.name),
    );
    const add = el(
      'button',
      {
        type: 'button',
        class: 'asset-add',
        title: t('Dodaj na oś czasu', 'Add to timeline'),
        onclick: (e) => {
          e.stopPropagation();
          selectAsset();
          addAsset(current.id);
        },
      },
      icon('plus'),
    );
    holder.replaceChildren(thumb, label, add);
    if (variants?.length > 1) {
      const picker = select(
        variants.map((v) => [v.id, variantLabel(v.variant)]),
        current.id,
      );
      picker.className = 'variant';
      picker.title = t('Wariant', 'Variant');
      picker.ariaLabel = picker.title;
      picker.onclick = (e) => e.stopPropagation();
      picker.ondblclick = (e) => e.stopPropagation();
      picker.onchange = (e) => {
        e.stopPropagation();
        current = variants.find((x) => x.id === picker.value);
        selectAsset();
        paint();
      };
      holder.append(picker);
    }
    holder.ariaLabel = variants
      ? [familyName, variantLabel(current.variant)].filter(Boolean).join(' · ')
      : current.name;
    holder.title =
      holder.ariaLabel +
      ' · ' +
      t('Przeciągnij lub kliknij dwukrotnie, aby dodać', 'Drag or double-click to add');
  }
  holder.onclick = selectAsset;
  holder.ondblclick = () => {
    selectAsset();
    addAsset(current.id);
  };
  holder.onkeydown = (e) => {
    if (e.target === holder && e.key === 'Enter') {
      selectAsset();
      addAsset(current.id);
    }
  };
  holder.ondragstart = (e) => {
    if (e.target.tagName === 'SELECT') {
      e.preventDefault();
      return;
    }
    state.assetId = current.id;
    e.dataTransfer.setData('text/x-cutting-asset', current.id);
    e.dataTransfer.effectAllowed = 'copy';
  };
  paint();
  return holder;
}
function drawAssets(content, assets, cat) {
  const families = cat === 'sticker' ? stickerFamilies(assets) : undefined;
  const filtered = assets.filter((a) => searchFilter(a, state.query, families?.get(a.group || a.name)?.label));
  content.replaceChildren();
  if (filtered.length) {
    const grid = el('div', { class: 'asset-grid' });
    if (cat === 'sticker') {
      const groups = Map.groupBy(filtered, (a) => a.group || a.name);
      for (const name of new Set([...familyNames.keys(), ...groups.keys()])) {
        const items = groups.get(name);
        if (items)
          grid.append(makeAsset(items.find((a) => a.id === state.assetId) || items[0], items, families.get(name).label));
      }
    } else for (const a of filtered) grid.append(makeAsset(a));
    content.append(grid);
  } else {
    content.append(
      el(
        'div',
        { class: 'empty' },
        icon(symbols[cat]),
        el(
          'span',
          {},
          loading.has(cat)
            ? t('Wczytywanie biblioteki…', 'Loading library…')
            : state.query
              ? t('Brak wyników.', 'No matches.')
              : t(
                  'Przeciągnij tutaj pliki lub wybierz je z dysku.',
                  'Drop files here or choose them from disk.',
                ),
        ),
      ),
    );
  }
  content.append(
    btn(
      'plus',
      t('Importuj pliki', 'Import files'),
      run(() => startImport(cat)),
      'drop-tile',
    ),
  );
}
export function drawLibrary() {
  const pane = by('library'),
    cat = state.category,
    isMedia = ['media', 'global', 'audiofx', 'visualfx', 'sticker'].includes(cat);
  pane.replaceChildren();
  const header = el(
    'div',
    { class: 'lib-top' },
    el(
      'h2',
      {},
      ['media', 'global'].includes(cat) ? t('Biblioteka mediów', 'Media library') : names()[cat],
    ),
  );
  if (isMedia)
    header.append(
      ib(
        'folder-plus',
        t('Dodaj pliki', 'Add files'),
        run(() => startImport(cat)),
      ),
    );
  pane.append(header);
  if (['media', 'global'].includes(cat)) {
    const tabs = el('div', { class: 'seg lib-tabs' });
    for (const [key, name] of [
      ['media', t('Projekt', 'Project')],
      ['global', t('Globalne', 'Global')],
    ])
      tabs.append(
        el(
          'button',
          { 'aria-selected': String(key === cat), onclick: run(() => changeCategory(key)) },
          name,
        ),
      );
    pane.append(tabs);
  }
  const content = el('div', { class: 'lib-content' });
  if (isMedia) {
    const assets = cat === 'media' ? Object.values(project().assets) : state.library[cat] || [];
    const search = input('search', state.query, {
      placeholder: t('Szukaj w bibliotece…', 'Search library…'),
      'aria-label': t('Szukaj w bibliotece', 'Search library'),
    });
    search.oninput = () => {
      state.query = search.value;
      drawAssets(content, assets, cat);
    };
    pane.append(el('div', { class: 'searchline' }, icon('search'), search));
    drawAssets(content, assets, cat);
    const bar = el('div', { class: 'lib-tools' });
    const update = () => {
      const count = assets.length,
        plForm = { one: 'plik', few: 'pliki', many: 'plików', other: 'pliku' }[
          new Intl.PluralRules('pl').select(count)
        ];
      bar.replaceChildren(
        el('span', { class: 'micro' }, count + ' ' + t(plForm, count === 1 ? 'file' : 'files')),
      );
      if (state.assetId) {
        bar.append(
          ib('plus', t('Dodaj na oś czasu', 'Add to timeline'), () => addAsset(state.assetId)),
          ib(
            'scissors-line-dashed',
            t('Wytnij ciszę w całym źródle', 'Remove silence from full source'),
            () => silenceDialog(assetById(state.assetId)),
          ),
        );
      }
      if (cat !== 'media')
        bar.append(
          ib('refresh-cw', t('Odśwież bibliotekę', 'Refresh library'), run(reloadLibrary)),
          ib(
            'folder-open',
            t('Otwórz folder biblioteki', 'Open library folder'),
            run(() => api('folderOpen', { category: cat })),
          ),
        );
    };
    update();
    state.commands.assetTools = update;
    pane.append(content, bar);
    pane.ondragover = (e) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        pane.classList.add('library-drag');
      }
    };
    pane.ondragleave = (e) => {
      if (!pane.contains(e.relatedTarget)) pane.classList.remove('library-drag');
    };
    pane.ondrop = (e) => {
      pane.classList.remove('library-drag');
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files].map((f) => window.cutting.filePath(f));
      run(() => importFiles(cat, files))();
    };
  } else {
    pane.ondragover = null;
    pane.ondrop = null;
    state.commands.assetTools = null;
    if (cat === 'captions') {
      content.append(
        tile(
          t('Generuj napisy', 'Generate captions'),
          t('Lokalny model ListenActive', 'Local ListenActive model'),
          'captions',
          captionDialog,
        ),
        tile(
          t('Dodaj tekst', 'Add text'),
          t('Tytuł lub własny podpis', 'Title or custom text'),
          'type',
          () => textDialog(),
        ),
        tile(t('Eksportuj napisy', 'Export subtitles'), 'SRT / WebVTT', 'download', exportCaptions),
        el(
          'h3',
          { style: { margin: '17px 0 8px', fontSize: '12px' } },
          t('Style napisów', 'Caption styles'),
        ),
        presetTiles(state.preset, (id) => {
          state.preset = id;
        }),
      );
    } else {
      content.append(btn('plus', t('Utwórz szablon', 'Create template'), () => editTemplate(), 'full'));
      if (!state.templates.length)
        content.append(
          el(
            'div',
            { class: 'empty' },
            el(
              'p',
              {},
              t(
                'Zapisz pozycje obrazu, kamery i napisów jako układ wielokrotnego użytku.',
                'Save your picture, camera and caption positions as a reusable layout.',
              ),
            ),
          ),
        );
      for (const tpl of state.templates) {
        const preview = el(
          'div',
          {
            style: {
              position: 'relative',
              height: '65px',
              background: 'var(--bg)',
              overflow: 'hidden',
              borderRadius: '4px',
            },
          },
          tpl.slots.map((s) =>
            el('i', {
              style: {
                position: 'absolute',
                left: s.box.x * 100 + '%',
                top: s.box.y * 100 + '%',
                width: s.box.w * 100 + '%',
                height: s.box.h * 100 + '%',
                background: s.kind === 'caption' ? '#b18c564a' : '#7bcc9540',
                border: '1px solid #83b893',
              },
            }),
          ),
        );
        const apply = btn(
          'plus',
          t('Zastosuj', 'Apply'),
          run(() => applyTemplate(tpl)),
          'active',
        );
        const edit = ib('pencil', t('Edytuj', 'Edit'), () => editTemplate(tpl));
        const remove = ib('trash-2', t('Usuń szablon', 'Delete template'), () => {
          const d = modal(t('Usunąć szablon?', 'Delete template?'));
          d.body.append(tpl.name);
          formAction(
            d,
            t('Usuń', 'Delete'),
            async () => {
              state.templates = await api('templateSave', { remove: tpl.id });
              redraw();
            },
            t('Anuluj', 'Cancel'),
          );
        });
        content.append(
          el(
            'div',
            { class: 'template-card', style: { marginTop: '9px' } },
            preview,
            el('strong', {}, tpl.name),
            group(apply, edit, remove),
          ),
        );
      }
    }
    pane.append(content);
  }
}
