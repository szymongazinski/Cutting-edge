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
} from './dom.mjs';
import {
  state,
  t,
  project,
  commit,
  selectIds,
  time,
  textClip,
  importFiles,
  library,
  redraw,
} from './session.mjs';
import { templateFrom, stylePreset, fitTitle } from './layout.mjs';
import { placement, cropDialog } from './geometry-form.mjs';
import { makeClip } from './model.mjs';
const labels = () => ({
  media: t('Obraz / wideo', 'Image / video'),
  text: t('Tekst', 'Text'),
  caption: t('Napisy', 'Captions'),
});
export function editTemplate(existing) {
  const p = project(),
    m = modal(existing ? t('Edytuj szablon', 'Edit template') : t('Utwórz szablon', 'Create template'), {
      wide: true,
    });
  const data = existing
    ? structuredClone(existing)
    : templateFrom(p, t('Mój układ', 'My layout'), state.selection.length > 1 ? state.selection : []);
  if (!data.slots.length)
    data.slots.push({
      kind: 'media',
      name: t('Obraz', 'Picture'),
      track: 0,
      box: { x: 0, y: 0, w: 1, h: 1 },
    });
  const name = input('text', data.name, { required: true, maxLength: 100 }),
    host = el('div', { class: 'stack' }),
    slotSelect = select([], ''),
    placeHost = el('div', { class: 'stack' });
  let index = 0,
    place,
    slotName,
    slotType,
    slotTrack;
  const capture = () => {
    if (!place || !data.slots[index]) return;
    const s = data.slots[index];
    s.name = slotName.value.trim() || labels()[s.kind];
    s.kind = slotType.value;
    s.track = +slotTrack.value;
    s.box = place.value();
  };
  function draw() {
    slotSelect.replaceChildren(
      ...data.slots.map((s, i) => el('option', { value: String(i) }, i + 1 + '. ' + s.name)),
    );
    slotSelect.value = String(index);
    const s = data.slots[index];
    placeHost.replaceChildren();
    if (!s) {
      place = null;
      return;
    }
    slotName = input('text', s.name, { required: true });
    slotType = select(Object.entries(labels()), s.kind);
    slotTrack = number(s.track, { min: 0, max: 40, step: 1 });
    place = placement(s.box, data.width / data.height);
    placeHost.append(
      field(t('Nazwa pola', 'Slot name'), slotName),
      fields(field(t('Rodzaj', 'Type'), slotType), field(t('Ścieżka', 'Track'), slotTrack)),
      place.ui,
    );
  }
  slotSelect.onchange = () => {
    capture();
    index = +slotSelect.value;
    draw();
  };
  const add = btn('plus', t('Dodaj pole', 'Add slot'), () => {
    capture();
    index = data.slots.length;
    data.slots.push({
      kind: 'media',
      name: t('Pole ', 'Slot ') + (index + 1),
      track: index,
      box: { x: 0.07, y: 0.57, w: 0.35, h: 0.35 },
    });
    draw();
  });
  const remove = ib('trash-2', t('Usuń pole', 'Remove slot'), () => {
    data.slots.splice(index, 1);
    index = Math.max(0, index - 1);
    place = null;
    draw();
  });
  draw();
  host.append(
    field(t('Nazwa szablonu', 'Template name'), name),
    group(slotSelect, add, remove),
    placeHost,
  );
  m.body.append(host);
  formAction(
    m,
    t('Zapisz szablon', 'Save template'),
    async () => {
      capture();
      if (!data.slots.length) {
        notify(t('Dodaj co najmniej jedno pole.', 'Add at least one slot.'), 'error');
        return false;
      }
      data.name = name.value.trim();
      state.templates = await api('templateSave', { template: data });
      redraw();
    },
    t('Anuluj', 'Cancel'),
  );
}
export async function applyTemplate(tpl) {
  const shared = await library('global');
  const p = project(),
    m = modal(t('Zastosuj szablon', 'Apply template') + ' · ' + tpl.name, { wide: true });
  const list = el('div', { class: 'stack' }),
    originalStart = time(),
    length = number(5, { min: 1 / p.fps, max: 36000, step: 'any' });
  const rows = [];
  const localAssets = new Map(
    [...Object.values(p.assets), ...shared].filter((a) => a.kind !== 'audio').map((a) => [a.id, a]),
  );
  for (const slot of tpl.slots) {
    const row = { slot };
    rows.push(row);
    if (slot.kind === 'media') {
      const s = select(
        [
          ['', t('Wybierz źródło', 'Choose a source')],
          ...[...localAssets.values()].map((a) => [a.id, a.name]),
        ],
        '',
      );
      const browse = ib(
        'import',
        t('Importuj plik', 'Import file'),
        run(async () => {
          const items = await importFiles('media');
          for (const a of items.filter((a) => a.kind !== 'audio')) {
            localAssets.set(a.id, a);
            for (const r of rows) {
              if (r.select && ![...r.select.options].some((o) => o.value === a.id))
                r.select.append(el('option', { value: a.id }, a.name));
            }
            s.value = a.id;
          }
        }),
      );
      row.select = s;
      list.append(field(slot.name, group(s, browse)));
    } else if (slot.kind === 'text') {
      row.text = input('text', slot.text || slot.name);
      list.append(field(slot.name, row.text));
    } else
      list.append(
        el(
          'div',
          { class: 'snippet' },
          slot.name + ' · ' + t('ramka do generowania napisów', 'caption generation box'),
        ),
      );
  }
  m.body.append(
    list,
    field(t('Długość układu (s)', 'Layout duration (s)'), length),
    el(
      'small',
      {},
      t(
        'Układ zostanie dodany w miejscu głowicy. Każde źródło możesz wykadrować osobno.',
        'The layout starts at the playhead. You can crop each source separately.',
      ),
    ),
  );
  formAction(
    m,
    t('Umieść na osi', 'Place on timeline'),
    async () => {
      if (rows.some((r) => r.select && !r.select.value)) {
        notify(
          t('Wybierz źródło dla każdego pola mediów.', 'Choose a source for each media slot.'),
          'error',
        );
        return false;
      }
      const ready = [];
      for (const r of rows) {
        if (!r.select) {
          ready.push(r);
          continue;
        }
        const a = localAssets.get(r.select.value),
          b = r.slot.box;
        if (!a) return false;
        let crop = { x: 0, y: 0, w: 1, h: 1 };
        if (
          Math.abs(a.width / a.height / ((b.w * p.width) / (b.h * p.height)) - 1) > 0.005 ||
          a.width > b.w * p.width + 1 ||
          a.height > b.h * p.height + 1
        ) {
          crop = await cropDialog(a, b);
          if (!crop) return false;
        }
        ready.push({ ...r, asset: a, crop });
      }
      const ids = [];
      commit((doc) => {
        const base =
          Math.max(
            -1,
            ...doc.clips
              .filter(
                (c) => c.start < originalStart + +length.value && c.start + c.duration > originalStart,
              )
              .map((c) => c.track),
          ) + 1;
        for (const r of ready) {
          const s = r.slot;
          let c;
          if (r.asset) {
            doc.assets[r.asset.id] = r.asset;
            c = makeClip(doc, r.asset, originalStart, base + s.track);
            c.duration =
              r.asset.kind === 'image' || ['sticker', 'visualfx'].includes(r.asset.category)
                ? +length.value
                : Math.min(+length.value, c.duration);
            c.box = { ...s.box };
            c.crop = r.crop;
          } else {
            c = textClip(
              s.kind,
              r.text?.value || '',
              s.box,
              s.style || stylePreset('classic', p.height),
              +length.value,
              originalStart,
              base + s.track,
            );
            c.name = s.name;
            if (c.kind === 'text') Object.assign(c, fitTitle(c.text, c.box, p, c.style));
          }
          doc.clips.push(c);
          ids.push(c.id);
        }
      });
      selectIds(ids);
    },
    t('Anuluj', 'Cancel'),
  );
}
