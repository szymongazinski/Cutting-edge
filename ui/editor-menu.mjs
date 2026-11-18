import { hasSound, splitClip, visualSource } from './model.mjs';
import { clamp } from './editor-math.mjs';
import { button, element, icon } from './editor-dom.mjs';

export function attachClipMenu(stage, timeline, api) {
  const menu = element('div', 'ce-edit-menu');
  const events = new AbortController();
  const options = { signal: events.signal };

  function action(text, glyph, fn, disabled = false) {
    const b = button(menu, 'ce-menu-action', text, () => {
      menu.hidden = true;
      fn();
    });
    icon(glyph, b);
    b.append(document.createTextNode(text));
    b.disabled = disabled;
  }

  function show(e) {
    const target = e.target.closest('.ce-clip, [data-top-id]');
    const id = target?.dataset.clipId || target?.dataset.topId;
    if (!id) return;
    e.preventDefault();
    api.pick(id, false);
    api.pause();
    const p = api.project();
    const selected = new Set(api.selection());
    const clips = p.clips.filter((c) => selected.has(c.id));
    const clicked = clips.find((c) => c.id === id);
    menu.replaceChildren();
    action(api.t('Właściwości', 'Properties'), 'sliders-horizontal', () => api.inspect(id));
    if (api.cropSource && visualSource(p, clicked))
      action(api.t('Kadruj źródło', 'Crop source'), 'crop', () => api.cropSource(id));
    const now = api.time();
    action(
      api.t('Podziel przy głowicy', 'Split at playhead'),
      'scissors',
      () =>
        api.commit((p) => {
          for (const id of selected) splitClip(p, id, now);
        }),
      !clips.some((c) => c.start < now && c.start + c.duration > now),
    );
    const withSound = clips.filter((c) => hasSound(p, c)),
      mute = !withSound.every((c) => c.muted);
    action(
      mute ? api.t('Wycisz', 'Mute') : api.t('Włącz dźwięk', 'Unmute'),
      mute ? 'volume-x' : 'volume-2',
      () =>
        api.commit((p) =>
          p.clips
            .filter((c) => selected.has(c.id) && hasSound(p, c))
            .forEach((c) => {
              c.muted = mute;
            }),
        ),
      !withSound.length,
    );
    action(api.t('Usuń zaznaczenie', 'Delete selected clips'), 'trash-2', () => {
      api.commit((p) => {
        p.clips = p.clips.filter((c) => !selected.has(c.id));
      });
      api.select([]);
    });
    e.currentTarget.append(menu);
    menu.hidden = false;
    menu.style.left = clamp(e.clientX, 3, window.innerWidth - menu.offsetWidth - 3) + 'px';
    menu.style.top = clamp(e.clientY, 3, window.innerHeight - menu.offsetHeight - 3) + 'px';
    menu.firstElementChild?.focus();
  }

  stage.addEventListener('contextmenu', show, options);
  timeline.addEventListener('contextmenu', show, options);
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!menu.contains(e.target)) menu.hidden = true;
    },
    { ...options, capture: true },
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') menu.hidden = true;
    },
    options,
  );
  return () => {
    events.abort();
    menu.remove();
  };
}
