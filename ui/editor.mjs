import { endTime } from './model.mjs';
import { clamp, timecode } from './editor-math.mjs';
import { button, element, icon, label } from './editor-dom.mjs';
import { createPreview } from './editor-preview.mjs';
import { createTimeline } from './editor-timeline.mjs';
import { attachClipMenu } from './editor-menu.mjs';

/** Mount one timeline, stage and transport. Zoom is expressed in CSS pixels per second. */
export function mountEditor({
  stage,
  timeline,
  transport,
  getProject,
  getSelection,
  select,
  commit,
  onTime,
  flags,
  translate,
  assetUrl,
  dropAsset,
  inspect,
  cropSource,
}) {
  const t = translate || ((pl, en) => en);
  let now = 0,
    running = false,
    raf = 0,
    origin = 0,
    draft = null,
    preview,
    lanes;
  let currentId = getProject().id,
    gone = false;
  const readSelection = () => getSelection() || [];
  function project() {
    const base = getProject();
    if (!draft?.size) return base;
    return {
      ...base,
      clips: base.clips.map((c) => (draft.has(c.id) ? { ...c, ...draft.get(c.id) } : c)),
    };
  }

  transport.classList.add('ce-transport');
  const bar = element('div', 'ce-transport-bar', transport);
  const times = element('div', 'ce-times', bar);
  const current = element('output', 'ce-current', times);
  const duration = element('span', 'ce-duration', times);
  const nav = element('div', 'ce-nav', bar);
  const navButton = (name, handler) => {
    const b = button(nav, 'ce-icon-btn ce-nav-' + name, '', handler);
    const shape = element('i', 'ce-symbol ce-symbol-' + name, b);
    shape.setAttribute('aria-hidden', 'true');
    return b;
  };
  const first = navButton('first', () => seek(0));
  const back = navButton('back', () => {
    pause();
    seek((Math.round(now * project().fps) - 1) / project().fps);
  });
  const play = navButton('play', playPause);
  const forward = navButton('forward', () => {
    pause();
    seek(Math.min(endTime(project()), (Math.round(now * project().fps) + 1) / project().fps));
  });
  const last = navButton('last', () => {
    pause();
    seek(endTime(project()));
  });
  const zoomGroup = element('div', 'ce-zoom', bar);
  const zoomOut = button(zoomGroup, 'ce-icon-btn', '', () => lanes.setZoom(lanes.getZoom() / 1.35));
  icon('minus', zoomOut);
  const slider = element('input', 'ce-zoom-range', zoomGroup);
  slider.type = 'range';
  slider.min = '-5.644';
  slider.max = '11.104';
  slider.step = '.01';
  slider.addEventListener('input', () => lanes.setZoom(2 ** Number(slider.value)));
  const zoomIn = button(zoomGroup, 'ce-icon-btn', '', () => lanes.setZoom(lanes.getZoom() * 1.35));
  icon('plus', zoomIn);
  const zoomFit = button(zoomGroup, 'ce-icon-btn ce-fit', '', () => lanes.fit());
  icon('scan', zoomFit);

  function updateLabels() {
    current.setAttribute('aria-label', t('Kod czasowy głowicy', 'Playhead timecode'));
    duration.title = t('Czas trwania sekwencji', 'Sequence duration');
    label(first, t('Początek sekwencji', 'Go to start'));
    label(back, t('Poprzednia klatka', 'Previous frame'));
    label(forward, t('Następna klatka', 'Next frame'));
    label(last, t('Koniec sekwencji', 'Go to end'));
    label(zoomOut, t('Oddal oś czasu', 'Zoom out of timeline'));
    label(zoomIn, t('Przybliż oś czasu', 'Zoom in to timeline'));
    label(zoomFit, t('Dopasuj sekwencję do szerokości', 'Fit sequence to width'));
    label(slider, t('Skala osi czasu (Ctrl + kółko myszy)', 'Timeline zoom (Ctrl + mouse wheel)'));
    nav.setAttribute('aria-label', t('Sterowanie odtwarzaniem', 'Playback controls'));
    zoomGroup.setAttribute('aria-label', t('Skala osi czasu', 'Timeline zoom'));
  }

  function display() {
    const p = project(),
      tc = timecode(now, p.fps);
    if (current.textContent !== tc) current.textContent = tc;
    duration.textContent = timecode(endTime(p), p.fps);
    play.classList.toggle('ce-playing', running);
    label(play, running ? t('Pauza (spacja)', 'Pause (Space)') : t('Odtwórz (spacja)', 'Play (Space)'));
    play.setAttribute('aria-pressed', String(running));
  }

  function publish(follow = false) {
    display();
    preview?.render();
    lanes?.paintHead(follow);
    onTime?.(now);
  }

  function tick(stamp) {
    raf = 0;
    if (!running || gone) return;
    const end = endTime(project());
    now = clamp((stamp - origin) / 1000, 0, end);
    if (now >= end) running = false;
    publish(true);
    if (running) raf = requestAnimationFrame(tick);
  }

  function pause() {
    if (!running) return;
    now = clamp((performance.now() - origin) / 1000, 0, endTime(project()));
    running = false;
    cancelAnimationFrame(raf);
    raf = 0;
    publish();
  }

  function playPause() {
    if (running) {
      pause();
      return;
    }
    const end = endTime(project());
    if (end <= 0) return;
    if (now >= end - 0.000001) now = 0;
    running = true;
    origin = performance.now() - now * 1000;
    publish(true);
    raf = requestAnimationFrame(tick);
  }

  function seek(seconds) {
    if (!Number.isFinite(seconds)) return;
    now = clamp(seconds, 0, 864000);
    if (running) origin = performance.now() - now * 1000;
    lanes?.reveal();
    publish();
  }

  function refresh() {
    if (gone) return;
    if (currentId !== getProject().id) {
      cancelAnimationFrame(raf);
      running = false;
      draft = null;
      now = 0;
      currentId = getProject().id;
      preview.reset();
      onTime?.(now);
    }
    updateLabels();
    display();
    preview.refresh();
    lanes.refresh();
    slider.value = String(Math.log2(lanes.getZoom()));
  }

  const api = {
    project,
    time: () => now,
    playing: () => running,
    selection: readSelection,
    flags: flags || (() => ({ timelineSnap: true, sceneSnap: true })),
    t,
    assetUrl,
    select,
    commit,
    inspect,
    cropSource,
    drop: dropAsset,
    pause,
    seek,
    pick(id, toggle) {
      const ids = readSelection(),
        chosen = ids.includes(id);
      if (toggle) {
        select(chosen ? ids.filter((i) => i !== id) : [...ids, id]);
        return !chosen;
      }
      if (!chosen) select([id]);
      return true;
    },
    preview(patches, affectsTimeline) {
      draft = patches;
      if (affectsTimeline) lanes.refresh();
      preview.render();
    },
    apply(patches) {
      draft = null;
      commit((p) => {
        for (const c of p.clips) if (patches.has(c.id)) Object.assign(c, patches.get(c.id));
      });
      refresh();
    },
    zoomChanged(value) {
      slider.value = String(Math.log2(value));
    },
  };
  preview = createPreview(stage, api);
  lanes = createTimeline(timeline, api);
  const detachClipMenu = attachClipMenu(stage, timeline, api);
  refresh();
  return {
    refresh,
    pause,
    playPause,
    seek,
    getTime: () => now,
    setZoom: (value, anchorPx) => lanes.setZoom(value, anchorPx),
    getZoom: () => lanes.getZoom(),
    destroy() {
      gone = true;
      running = false;
      cancelAnimationFrame(raf);
      detachClipMenu();
      preview.destroy();
      lanes.destroy();
      transport.replaceChildren();
      transport.classList.remove('ce-transport');
    },
  };
}
