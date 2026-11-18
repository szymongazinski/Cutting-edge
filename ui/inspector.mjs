import { el, icon, btn, field, fields, section, input, number, api, notify, run, by } from './dom.mjs';
import { state, t, project, selected, chosen, commit, changeClip, jumpIn } from './session.mjs';
import { syncClips, silenceDialog, projectSettings } from './dialogs.mjs';
import { editSourceCrop, boxFields } from './geometry-form.mjs';
import { textDialog, editCaptions, captionDialog } from './captions.mjs';
import { renderChat } from './chat.mjs';
const symbols = { media: 'film', compound: 'layers', caption: 'captions', text: 'type' };
export function drawInspector() {
  const tabs = by('inspector-tabs'),
    host = by('properties');
  tabs.replaceChildren(
    ...[
      ['inspect', 'sliders-horizontal', t('Inspektor', 'Inspector')],
      ['chat', 'bot', 'ChatGPT'],
    ].map(([id, sym, name]) =>
      el(
        'button',
        {
          type: 'button',
          class: state.panel === id ? 'active' : '',
          onclick: () => {
            state.panel = id;
            drawInspector();
          },
        },
        icon(sym),
        name,
      ),
    ),
  );
  if (state.panel === 'chat') {
    renderChat(host);
    return;
  }
  host.className = '';
  host.replaceChildren();
  const p = project(),
    list = selected(),
    c = chosen();
  if (!c) {
    host.append(
      el('div', { class: 'prop-title' }, icon('clapperboard'), el('strong', {}, p.name)),
      section(
        t('Ustawienia filmu', 'Film settings'),
        el('div', { class: 'micro' }, p.width + ' × ' + p.height + '  ·  ' + p.fps + ' FPS'),
        btn('settings-2', t('Zmień ustawienia filmu', 'Change film settings'), () => projectSettings()),
      ),
      el(
        'div',
        { class: 'empty' },
        el(
          'p',
          {},
          t(
            'Wybierz klip, aby zmienić jego położenie, kadr lub głośność.',
            'Select a clip to adjust its position, crop or volume.',
          ),
        ),
      ),
    );
    return;
  }
  if (list.length > 1) {
    host.append(
      el(
        'div',
        { class: 'prop-title' },
        icon('layers'),
        el('strong', {}, t('Zaznaczone klipy', 'Selected clips') + ' · ' + list.length),
      ),
      section(
        t('Synchronizacja', 'Synchronization'),
        ...list.map((c) => el('span', { class: 'micro' }, c.name + ' · ' + c.start.toFixed(2) + ' s')),
        btn('link-2', t('Synchronizuj i połącz', 'Synchronize and group'), syncClips, 'active'),
      ),
    );
    return;
  }
  const a = p.assets[c.assetId];
  const name = input('text', c.name, { maxLength: 128 });
  name.onchange = () => {
    if (name.value.trim()) changeClip(c.id, { name: name.value.trim() });
  };
  const start = number(c.start, { step: 'any' }),
    dur = number(c.duration, { min: 1 / p.fps, max: 86400, step: 'any' });
  const update = (n, fn) => {
    n.onchange = () => {
      if (n.reportValidity()) fn(+n.value);
    };
  };
  update(start, (v) => changeClip(c.id, { start: v }));
  update(dur, (v) => changeClip(c.id, { duration: v }));
  host.append(
    el(
      'div',
      { class: 'prop-title' },
      icon(a?.kind === 'audio' ? 'audio-lines' : symbols[c.kind]),
      el('strong', {}, c.name),
    ),
    section(
      t('Klip', 'Clip'),
      field(t('Nazwa', 'Name'), name),
      fields(field(t('Początek (s)', 'Start (s)'), start), field(t('Długość (s)', 'Duration (s)'), dur)),
    ),
  );
  if (c.kind === 'text' || c.kind === 'caption') {
    host.append(
      section(
        t('Typografia', 'Typography'),
        el('span', { class: 'micro' }, c.style.font + ' · ' + c.style.size + ' px'),
        btn(
          c.kind === 'text' ? 'type' : 'captions',
          c.kind === 'text'
            ? t('Edytuj tekst i styl', 'Edit text and style')
            : t('Edytuj napisy i styl', 'Edit captions and style'),
          () => (c.kind === 'text' ? textDialog(c) : editCaptions(c)),
        ),
      ),
    );
    if (c.kind === 'caption' && !c.cues.length)
      host.append(
        btn('captions', t('Generuj w tej ramce', 'Generate in this box'), captionDialog, 'active'),
      );
  }
  if (a?.kind !== 'audio') {
    const geom = boxFields(c.box);
    geom.controls.onchange = () => {
      if (!geom.controls.querySelector(':invalid')) changeClip(c.id, { box: geom.value() });
    };
    const content = [geom.controls];
    if (a)
      content.push(
        btn(
          'crop',
          t('Kadruj źródło', 'Crop source'),
          run(() => editSourceCrop(c.id)),
        ),
      );
    host.append(section(t('Położenie i kadr', 'Position and framing'), ...content));
  }
  if (a?.hasAudio || c.kind === 'compound') {
    const db = c.volume > 0 ? 20 * Math.log10(c.volume) : -60;
    const gain = number(db, { min: -60, max: 18, step: 0.1 });
    gain.value = db.toFixed(1);
    update(gain, (v) => changeClip(c.id, { volume: Math.pow(10, v / 20) }));
    host.append(
      section(
        t('Dźwięk', 'Audio'),
        field(t('Wzmocnienie (dB)', 'Gain (dB)'), gain),
        btn(
          c.muted ? 'volume-x' : 'volume-2',
          c.muted ? t('Włącz dźwięk', 'Unmute') : t('Wycisz źródło', 'Mute source'),
          () => changeClip(c.id, { muted: !c.muted }),
          c.muted ? 'active' : '',
        ),
        btn('scissors-line-dashed', t('Wytnij ciszę', 'Remove silence'), () => silenceDialog()),
      ),
    );
  }
  if (c.kind === 'compound')
    host.append(
      section(
        t('Źródła', 'Sources'),
        el('small', {}, c.children.map((x) => x.name).join(' · ')),
        btn('layers', t('Edytuj zawartość', 'Edit contents'), () => jumpIn(c)),
      ),
    );
  if (a) {
    const relink = btn(
      'folder-search',
      t('Wskaż plik źródłowy', 'Relink source'),
      run(async () => {
        const reply = await api('mediaImport', { category: 'media' });
        if (reply.errors?.length) notify(reply.errors.join('\n'), 'error');
        if (!reply.assets?.length) return;
        const replacement = reply.assets[0];
        if (replacement.kind !== a.kind) {
          notify(t('Wybierz plik tego samego rodzaju.', 'Choose the same kind of media.'), 'error');
          return;
        }
        commit((doc) => {
          doc.assets[a.id] = {
            ...replacement,
            id: a.id,
            category: a.category,
            group: a.group,
            variant: a.variant,
          };
          const fix = (list) => {
            for (const target of list) {
              if (target.kind === 'compound') fix(target.children);
              else if (
                target.assetId === a.id &&
                a.kind !== 'image' &&
                !['visualfx', 'sticker'].includes(a.category)
              ) {
                target.in = Math.min(target.in, Math.max(0, replacement.duration - 1 / doc.fps));
                target.duration = Math.min(target.duration, replacement.duration - target.in);
              }
            }
          };
          fix(state.doc.project.clips);
        });
      }),
    );
    host.append(
      section(
        t('Plik źródłowy', 'Source file'),
        el('small', { title: a.path, style: { overflowWrap: 'anywhere' } }, a.name),
        relink,
      ),
    );
  }
}
