import {
  el,
  btn,
  group,
  field,
  fields,
  number,
  input,
  select,
  modal,
  formAction,
  api,
  notify,
} from './dom.mjs';
import {
  state,
  t,
  project,
  chosen,
  commit,
  selectIds,
  time,
  subset,
  textClip,
  busy,
  prefs,
} from './session.mjs';
import {
  stylePreset,
  presets,
  defaultCaptionBox,
  fitCues,
  measureText,
  subtitleText,
  projectCues,
  visibleCues,
  replaceVisibleCues,
} from './layout.mjs';
import { placement } from './geometry-form.mjs';
import { endTime } from './model.mjs';
const presetNames = {
  classic: ['Klasyczny', 'Classic'],
  impact: ['Kontrast', 'Impact'],
  neon: ['Neon', 'Neon'],
  label: ['Etykieta', 'Label'],
};
export function presetTiles(value, onChange) {
  const box = el('div', { class: 'sample-styles' });
  let current = value;
  const draw = () => {
    box.replaceChildren(
      ...presets.map((id) => {
        const s = stylePreset(id, project().height);
        return el(
          'button',
          {
            type: 'button',
            class: 'style-tile ' + (id === current ? 'active' : ''),
            onclick: () => {
              current = id;
              onChange(id);
              draw();
            },
          },
          el(
            'b',
            {
              style: {
                color: s.color,
                fontFamily: s.font,
                paintOrder: 'stroke fill',
                WebkitTextStroke: s.strokeWidth ? '2px ' + s.stroke : '0',
                backgroundColor: s.background,
              },
            },
            'Aa',
          ),
          el('small', {}, t(...presetNames[id])),
        );
      }),
    );
  };
  draw();
  return box;
}
export function styleControls(initial) {
  const fonts = [
    'Arial',
    'Arial Black',
    'Calibri',
    'Cambria',
    'Consolas',
    'Georgia',
    'Impact',
    'Segoe UI',
    'Tahoma',
    'Times New Roman',
    'Verdana',
  ];
  const font = input('text', initial.font || 'Arial', { list: 'ce-fonts' }),
    dl = el(
      'datalist',
      { id: 'ce-fonts' },
      fonts.map((f) => el('option', { value: f })),
    );
  const size = number(initial.size || 52, { min: 1, max: 2000, step: 1 }),
    color = input('color', initial.color || '#ffffff'),
    stroke = input('color', initial.stroke || '#000000'),
    strokeWidth = number(initial.strokeWidth || 0, { min: 0, max: 50, step: 0.5 });
  const bold = input('checkbox', '', { checked: initial.bold }),
    italic = input('checkbox', '', { checked: initial.italic }),
    bg = input(
      'color',
      initial.background && initial.background !== 'transparent' ? initial.background : '#ffffff',
    ),
    bgOn = input('checkbox', '', {
      checked: !!initial.background && initial.background !== 'transparent',
    });
  const check = (n, label) => el('label', { class: 'check' }, n, label);
  const ui = el(
    'div',
    { class: 'stack' },
    dl,
    fields(field(t('Czcionka', 'Font'), font), field(t('Rozmiar (px)', 'Size (px)'), size)),
    group(check(bold, t('Pogrubienie', 'Bold')), check(italic, t('Kursywa', 'Italic'))),
    fields(
      field(t('Kolor liter', 'Text color'), color),
      field(t('Kolor obrysu', 'Outline color'), stroke),
    ),
    fields(
      field(t('Grubość obrysu', 'Outline width'), strokeWidth),
      field(t('Kolor tła', 'Background color'), bg),
    ),
    check(bgOn, t('Tło napisów', 'Caption background')),
  );
  return {
    ui,
    value: () => ({
      font: font.value.trim() || 'Arial',
      size: +size.value,
      color: color.value,
      stroke: stroke.value,
      strokeWidth: +strokeWidth.value,
      bold: bold.checked,
      italic: italic.checked,
      background: bgOn.checked ? bg.value : 'transparent',
    }),
  };
}
export function textDialog(clip = null) {
  const p = project(),
    m = modal(clip ? t('Edycja tekstu', 'Edit text') : t('Dodaj tekst', 'Add text'), { wide: true });
  const content = el('textarea', {
    value: clip?.text || '',
    placeholder: t('Wpisz tekst', 'Enter text'),
    required: true,
  });
  const sty = styleControls(clip?.style || stylePreset(state.preset, p.height));
  const place = placement(clip?.box || { x: 0.08, y: 0.38, w: 0.84, h: 0.22 });
  const start = number(clip?.start ?? time(), { step: 'any' }),
    dur = number(clip?.duration || 3, { min: 1 / p.fps, step: 'any' });
  m.body.append(
    field(t('Tekst', 'Text'), content),
    fields(field(t('Początek (s)', 'Start (s)'), start), field(t('Długość (s)', 'Duration (s)'), dur)),
    sty.ui,
    place.ui,
  );
  formAction(
    m,
    t('Zastosuj', 'Apply'),
    () => {
      let id;
      commit((doc) => {
        if (clip) {
          const c = doc.clips.find((c) => c.id === clip.id);
          Object.assign(c, {
            text: content.value,
            name: content.value.slice(0, 38),
            start: +start.value,
            duration: +dur.value,
            style: sty.value(),
            box: place.value(),
          });
          id = c.id;
        } else {
          const c = textClip('text', content.value, place.value(), sty.value(), +dur.value, +start.value);
          doc.clips.push(c);
          id = c.id;
        }
      });
      selectIds([id]);
    },
    t('Anuluj', 'Cancel'),
  );
}
export function captionDialog() {
  const p = project(),
    sel = chosen(),
    m = modal(t('Generuj napisy', 'Generate captions'), { wide: true });
  const sources = [
    ['all', t('Cały film', 'Entire film')],
    ...p.clips.filter((c) => ['media', 'compound'].includes(c.kind)).map((c) => [c.id, c.name]),
  ];
  const source = select(sources, sel && sources.some(([v]) => v === sel.id) ? sel.id : 'all');
  const slots = p.clips.filter((c) => c.kind === 'caption');
  const slot = select(
    [
      ['new', t('Nowa ramka', 'New box')],
      ...slots.map((c) => [c.id, c.name + ' · ' + c.start.toFixed(1) + ' s']),
    ],
    sel?.kind === 'caption' ? sel.id : 'new',
  );
  const language = select(
    [
      ['auto', t('Wykryj język', 'Detect language')],
      ['pl', 'Polski'],
      ['en', 'English'],
    ],
    state.settings.captionLanguage,
  );
  const model = select(
    [
      ['large-v3', 'Whisper large-v3'],
      ['large-v3-turbo', 'Whisper large-v3-turbo'],
      ['small', 'Whisper small'],
    ],
    state.settings.captionModel,
  );
  const fmt = select(
    [
      ['srt', 'SubRip (.srt)'],
      ['vtt', 'WebVTT (.vtt)'],
    ],
    'srt',
  );
  let style = sel?.kind === 'caption' ? { ...sel.style } : stylePreset(state.preset, p.height);
  const boxHost = el('div');
  let place;
  const setPlace = () => {
    const c = slots.find((c) => c.id === slot.value);
    place = placement(c?.box || defaultCaptionBox());
    boxHost.replaceChildren(place.ui);
    if (c) style = { ...c.style };
  };
  slot.onchange = setPlace;
  setPlace();
  const tiles = presetTiles(state.preset, (id) => {
    state.preset = id;
    style = stylePreset(id, p.height);
  });
  m.body.append(
    field(t('Źródło mowy', 'Speech source'), source),
    fields(
      field(t('Język mowy', 'Speech language'), language),
      field(t('Lokalny model ListenActive', 'Local ListenActive model'), model),
    ),
    field(t('Plik napisów', 'Subtitle file'), fmt),
    field(t('Miejsce napisów', 'Caption placement'), slot),
    boxHost,
    tiles,
    el(
      'small',
      {},
      t(
        'ListenActive rozpoznaje mowę na tym komputerze. Pierwsze użycie wybranego modelu może wymagać pobrania.',
        'ListenActive transcribes on this computer. Using a model for the first time may require a download.',
      ),
    ),
  );
  formAction(
    m,
    t('Generuj napisy', 'Generate captions'),
    async () => {
      const clip = p.clips.find((c) => c.id === source.value),
        doc = subset(p, clip),
        start = clip?.start || 0,
        duration = clip?.duration || endTime(p);
      if (duration <= 0) {
        notify(t('Oś czasu jest pusta.', 'The timeline is empty.'), 'error');
        return false;
      }
      await prefs({ captionLanguage: language.value, captionModel: model.value });
      const raw = await busy(
        'transcribe',
        t('ListenActive rozpoznaje mowę', 'ListenActive is transcribing'),
        () => api('transcribe', { project: doc, language: language.value, model: model.value }),
        model.value,
      );
      if (!raw?.length) {
        notify(t('Model nie wykrył mowy.', 'The model did not detect speech.'));
        return false;
      }
      const chosenBox = place.value();
      const fit = fitCues(raw, chosenBox, p, style, measureText, { auto: true });
      if (!fit.cues.length) {
        notify(t('Brak napisów do zapisania.', 'No captions to save.'));
        return false;
      }
      const target = slot.value;
      const c = commit((now) => {
        let c = now.clips.find((c) => c.id === target);
        if (!c) {
          c = textClip('caption', '', chosenBox, fit.style, duration, start);
          now.clips.push(c);
        }
        Object.assign(c, { in: 0, start, duration, box: chosenBox, style: fit.style, cues: fit.cues });
        return c;
      });
      selectIds([c.id]);
      const output = await api('subtitles', {
        name: (clip?.name || p.name) + ' - ' + t('napisy', 'captions'),
        format: fmt.value,
        text: subtitleText(fit.cues, fmt.value),
        automatic: true,
      });
      notify(t('Zapisano napisy w ', 'Subtitles saved to ') + output, 'info', true);
    },
    t('Anuluj', 'Cancel'),
  );
}
export function editCaptions(c) {
  const m = modal(t('Edytuj napisy', 'Edit captions'), { wide: true }),
    style = styleControls(c.style),
    place = placement(c.box);
  const list = el('div', { class: 'stack' });
  const rows = [];
  function row(cue) {
    const start = number(cue.start, { step: 'any' }),
      end = number(cue.end, { step: 'any' }),
      text = el('textarea', { value: cue.text, required: true });
    const div = el(
      'div',
      { class: 'snippet stack' },
      fields(field(t('Od (s)', 'From (s)'), start), field(t('Do (s)', 'To (s)'), end)),
      text,
    );
    const entry = { start, end, text, div };
    rows.push(entry);
    div.append(
      btn(
        'trash-2',
        t('Usuń fragment', 'Remove cue'),
        () => {
          div.remove();
          rows.splice(rows.indexOf(entry), 1);
        },
        'ghost',
      ),
    );
    list.append(div);
  }
  visibleCues(c).forEach(row);
  m.body.append(
    style.ui,
    place.ui,
    list,
    btn('plus', t('Dodaj fragment', 'Add cue'), () => {
      const start = +(rows.at(-1)?.end.value || 0);
      row({ start, end: start + 1, text: '' });
    }),
  );
  formAction(
    m,
    t('Zapisz', 'Save'),
    () => {
      const raw = rows
        .map((r) => ({ start: +r.start.value, end: +r.end.value, text: r.text.value }))
        .sort((a, b) => a.start - b.start);
      if (raw.some((r) => r.end <= r.start)) {
        notify(
          t('Koniec fragmentu musi wypadać po początku.', 'Each cue must end after it starts.'),
          'error',
        );
        return false;
      }
      const f = fitCues(raw, place.value(), project(), style.value(), measureText);
      commit((p) =>
        Object.assign(
          p.clips.find((x) => x.id === c.id),
          replaceVisibleCues(c, f.cues),
          { style: f.style, box: place.value() },
        ),
      );
    },
    t('Anuluj', 'Cancel'),
  );
}
export async function exportCaptions() {
  const p = project(),
    cues = projectCues(p);
  if (!cues.length) {
    notify(t('Brak napisów do eksportu.', 'No captions to export.'));
    return;
  }
  const m = modal(t('Eksport napisów', 'Export subtitles'));
  const format = select(
    ['srt', 'vtt'].map((v) => [v, v.toUpperCase()]),
    'srt',
  );
  m.body.append(field(t('Format', 'Format'), format));
  formAction(
    m,
    t('Zapisz plik', 'Save file'),
    async () => {
      const file = await api('subtitles', {
        name: p.name,
        format: format.value,
        text: subtitleText(cues, format.value),
      });
      if (file) notify(file);
    },
    t('Anuluj', 'Cancel'),
  );
}
