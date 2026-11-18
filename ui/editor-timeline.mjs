import { endTime, hasSound, loops, trimTo } from './model.mjs';
import { anchoredZoom, clamp, snapTime, timecode } from './editor-math.mjs';
import { assetDragType, button, element, icon, isAssetDrag, label } from './editor-dom.mjs';

const kinds = {
  video: ['film', 'Wideo', 'Video'],
  image: ['image', 'Obraz', 'Image'],
  audio: ['audio-lines', 'Dźwięk', 'Audio'],
  text: ['type', 'Tekst', 'Text'],
  caption: ['captions', 'Napisy', 'Captions'],
  compound: ['layers', 'Grupa', 'Group'],
  visualfx: ['sparkles', 'Efekt', 'Effect'],
  sticker: ['sticker', 'Naklejka', 'Sticker'],
  empty: ['layers', 'Ścieżka', 'Track'],
};
const kindOf = (c, a) =>
  c.kind !== 'media'
    ? c.kind
    : ['sticker', 'visualfx'].includes(a?.category)
      ? a.category
      : a?.kind || 'video';
const mark = (node) => {
  node.setAttribute('aria-hidden', 'true');
  return node;
};

export function createTimeline(container, api) {
  container.classList.add('ce-timeline');
  const scroller = element('div', 'ce-timeline-scroll', container);
  const sheet = element('div', 'ce-timeline-sheet', scroller);
  const rulerRow = element('div', 'ce-ruler-row ce-row', sheet);
  const corner = element('div', 'ce-ruler-corner ce-lane-label', rulerRow);
  const cornerText = element('span', 'ce-ruler-title', corner);
  const addTrack = button(corner, 'ce-add-track ce-icon-btn', '', () => {
    manualTracks = Math.min(1000, count + 1);
    refresh();
    scroller.scrollTop = 0;
  });
  icon('plus', addTrack);
  const ruler = element('div', 'ce-ruler', rulerRow);
  const ticks = element('div', 'ce-ticks', ruler);
  const headTop = mark(element('i', 'ce-head-cap', ruler));
  const rowArea = element('div', 'ce-rows', sheet);
  const playhead = mark(element('div', 'ce-timeline-head', sheet));
  const magnetLine = mark(element('div', 'ce-timeline-guide', sheet));
  const marquee = mark(element('div', 'ce-timeline-marquee', sheet));
  const events = new AbortController();
  const listen = (node, type, fn, options = {}) =>
    node.addEventListener(type, fn, { ...options, signal: events.signal });
  const rows = new Map(),
    items = new Map();
  let zoom = 83,
    manualTracks = 0,
    count = 3,
    priorProject,
    minRight = 0;
  let drag = null,
    draggingAsset = false,
    guide = null,
    lastTickKey = '',
    scrollFrame = 0,
    autoScroll = 0;
  let destroyed = false;
  magnetLine.hidden = marquee.hidden = true;

  const gutter = () => corner.offsetWidth;
  const viewWidth = () => Math.max(20, scroller.clientWidth - gutter());
  const laneHeight = () => rows.values().next().value?.row.offsetHeight || 43;
  const atX = (x) =>
    Math.max(0, (x - scroller.getBoundingClientRect().left - gutter() + scroller.scrollLeft) / zoom);
  function trackAt(y) {
    const index = Math.floor((y - rowArea.getBoundingClientRect().top) / Math.max(1, laneHeight()));
    return clamp(count - 1 - index, 0, count - 1);
  }
  const rounded = (t) => Math.round(t * api.project().fps) / api.project().fps;

  function paintRuler() {
    const fps = api.project().fps || 30;
    const candidates = [
      1 / fps,
      2 / fps,
      5 / fps,
      10 / fps,
      0.25,
      0.5,
      1,
      2,
      5,
      10,
      15,
      30,
      60,
      120,
      300,
      600,
      1200,
      1800,
      3600,
      7200,
      21600,
    ];
    const step = candidates.sort((a, b) => a - b).find((s) => s * zoom >= 65) || 21600;
    const subdivisions =
      step <= 2 / fps
        ? 1
        : step < 1
          ? Math.max(1, Math.min(5, Math.round(step * fps)))
          : step === 2
            ? 4
            : 5;
    const minor = step / subdivisions;
    const first = Math.max(0, Math.floor(scroller.scrollLeft / zoom / minor) - 2);
    const last = Math.ceil((scroller.scrollLeft + viewWidth()) / zoom / minor) + 2;
    const key = [zoom, first, last, fps].join('|');
    if (key === lastTickKey) return;
    lastTickKey = key;
    sheet.style.setProperty('--ce-grid', step * zoom + 'px');
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      const major = i % subdivisions === 0;
      const tick = element('span', 'ce-tick' + (major ? ' ce-major' : ''), frag);
      tick.style.left = i * minor * zoom + 'px';
      if (major) {
        const tc = timecode(i * minor, fps);
        tick.textContent = step < 1 ? tc.slice(3) : i * minor >= 3600 ? tc.slice(0, 8) : tc.slice(3, 8);
      }
    }
    ticks.replaceChildren(frag);
  }

  function paintHead(follow = false) {
    const t = api.time(),
      x = t * zoom;
    if (
      follow &&
      scroller.clientWidth > 0 &&
      (x > scroller.scrollLeft + viewWidth() - 12 || x < scroller.scrollLeft)
    ) {
      scroller.scrollLeft = Math.max(0, x - viewWidth() * 0.15);
    }
    playhead.style.left = gutter() + x + 'px';
    headTop.style.left = x + 'px';
    magnetLine.hidden = !Number.isFinite(guide);
    if (Number.isFinite(guide)) magnetLine.style.left = gutter() + guide * zoom + 'px';
  }

  function layoutWidth(p) {
    const view = viewWidth(),
      horizon = Math.max(endTime(p), api.time()) * zoom;
    const content = Math.max(view + 1, horizon + Math.max(130, view * 0.3), minRight);
    sheet.style.width = Math.ceil(Math.min(30_000_000, content) + gutter()) + 'px';
  }

  function rowFor(track) {
    let r = rows.get(track);
    if (r) return r;
    const row = element('div', 'ce-row ce-lane', rowArea);
    row.dataset.lane = track;
    const head = element('div', 'ce-lane-label', row);
    const number = element('span', 'ce-lane-number', head);
    number.textContent = 'T' + (track + 1);
    const name = element('span', 'ce-lane-name', head);
    const mute = button(head, 'ce-lane-mute ce-icon-btn', '', () => {
      const clips = api.project().clips.filter((c) => c.track === track && hasSound(api.project(), c));
      if (!clips.length) return;
      const next = !clips.every((c) => c.muted);
      api.commit((p) =>
        p.clips
          .filter((c) => c.track === track && hasSound(p, c))
          .forEach((c) => {
            c.muted = next;
          }),
      );
    });
    const soundIcon = icon('volume-2', mute);
    const body = element('div', 'ce-lane-body', row);
    r = { row, head, name, mute, soundIcon, body };
    rows.set(track, r);
    return r;
  }

  function paintRows(p, groups) {
    const tracks = Math.max(3, manualTracks, ...[...groups.keys()].map((t) => t + 1));
    count = Math.min(1000, tracks);
    let prior = null;
    for (let t = count - 1; t >= 0; t--) {
      const r = rowFor(t),
        clips = groups.get(t) || [];
      const next = prior ? prior.nextElementSibling : rowArea.firstElementChild;
      if (r.row !== next) rowArea.insertBefore(r.row, next);
      prior = r.row;
      const types = new Set(clips.map((c) => kindOf(c, p.assets[c.assetId])));
      const k = types.size === 1 ? [...types][0] : 'empty';
      r.name.textContent = api.t(kinds[k][1], kinds[k][2]);
      const sounds = clips.filter((c) => hasSound(p, c));
      const muted = Boolean(sounds.length && sounds.every((c) => c.muted));
      r.mute.disabled = !sounds.length;
      r.mute.setAttribute('aria-pressed', String(muted));
      label(
        r.mute,
        api.t(
          muted ? 'Włącz dźwięk ścieżki ' : 'Wycisz ścieżkę ',
          muted ? 'Unmute track ' : 'Mute track ',
        ) +
          (t + 1),
      );
      r.soundIcon.style.setProperty(
        '--ce-icon',
        'url("../assets/icons/volume-' + (muted ? 'x' : '2') + '.svg")',
      );
      r.row.classList.toggle('ce-empty-lane', !clips.length);
      r.head.title = api.t('Zaznacz klipy na ścieżce ', 'Select clips on track ') + (t + 1);
    }
    for (const [t, r] of rows)
      if (t >= count) {
        r.row.remove();
        rows.delete(t);
      }
  }

  function newItem(clip) {
    const node = element('div', 'ce-clip');
    node.dataset.clipId = clip.id;
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    const strip = element('div', 'ce-filmstrip', node);
    const wave = element('canvas', 'ce-waveform', node);
    const top = element('div', 'ce-clip-title', node);
    const badge = icon('film', top);
    const title = element('span', 'ce-clip-name', top);
    const muted = element('span', 'ce-clip-muted', top);
    icon('volume-x', muted);
    for (const edge of ['start', 'end']) {
      const handle = element('i', 'ce-trim ce-trim-' + edge, node);
      handle.dataset.trim = edge;
    }
    const i = { node, strip, wave, badge, title, muted };
    items.set(clip.id, i);
    return i;
  }

  function paintWave(i, clip, asset) {
    const points = asset?.waveform;
    if (!points?.length) {
      i.wave.hidden = true;
      return;
    }
    const left = Math.max(0, Math.floor(scroller.scrollLeft - clip.start * zoom - 20));
    const right = Math.min(
      clip.duration * zoom,
      scroller.scrollLeft + viewWidth() - clip.start * zoom + 20,
    );
    const w = Math.ceil(right - left);
    if (w <= 0) {
      i.wave.hidden = true;
      return;
    }
    i.wave.hidden = false;
    const key = [clip.in, asset.id, zoom, left, w, points.length].join('/');
    if (i.waveKey === key) return;
    i.waveKey = key;
    const height = 22;
    i.wave.width = Math.min(3200, w);
    i.wave.height = height;
    i.wave.style.left = left + 'px';
    i.wave.style.width = w + 'px';
    const ctx = i.wave.getContext('2d');
    const samplesDuration = asset.waveformDuration || asset.duration || 1;
    const peak = Math.max(0.000001, ...points);
    const drawW = i.wave.width;
    ctx.fillStyle = '#d2fae3';
    for (let x = 0; x < drawW; x += 3) {
      let t = clip.in + (left + (x * w) / drawW) / zoom;
      if (loops(asset) && asset.duration > 0) t %= asset.duration;
      if (t >= samplesDuration) continue;
      const pos = (t / samplesDuration) * points.length;
      const a = points[Math.floor(pos)] || 0,
        b = points[Math.min(points.length - 1, Math.floor(pos) + 1)] || 0;
      const amplitude = a + (b - a) * (pos - Math.floor(pos));
      const h = Math.max(1, Math.min(1, amplitude / peak) * (height - 2));
      ctx.fillRect(x, (height - h) / 2, 1.8, h);
    }
  }

  function paintClips(p) {
    const selected = new Set(api.selection()),
      seen = new Set(),
      history = new Map();
    const grouped = new Map();
    for (const c of p.clips) {
      if (!grouped.has(c.track)) grouped.set(c.track, []);
      grouped.get(c.track).push(c);
    }
    paintRows(p, grouped);
    for (const c of p.clips) {
      seen.add(c.id);
      const a = p.assets[c.assetId],
        k = kindOf(c, a),
        type = kinds[k];
      const i = items.get(c.id) || newItem(c),
        parent = rows.get(c.track)?.body;
      if (!parent) continue;
      const prev = history.get(parent),
        next = prev ? prev.nextElementSibling : parent.firstElementChild;
      if (next !== i.node) parent.insertBefore(i.node, next);
      history.set(parent, i.node);
      i.node.dataset.kind = k;
      i.node.style.left = c.start * zoom + 'px';
      i.node.style.width = Math.max(2, c.duration * zoom) + 'px';
      i.node.classList.toggle('ce-selected', selected.has(c.id));
      i.node.classList.toggle('ce-silent', Boolean(c.muted));
      i.node.setAttribute('aria-pressed', String(selected.has(c.id)));
      i.node.setAttribute('aria-label', c.name || api.t(type[1], type[2]));
      i.node.title =
        (c.name || api.t(type[1], type[2])) +
        ' · ' +
        timecode(c.start, p.fps) +
        ' – ' +
        timecode(c.start + c.duration, p.fps);
      if (i.title.textContent !== c.name)
        i.title.textContent = c.name || c.text || api.t(type[1], type[2]);
      i.muted.hidden = !c.muted;
      i.badge.style.setProperty('--ce-icon', 'url("../assets/icons/' + type[0] + '.svg")');
      const thumbnail = a?.thumbnail;
      if (i.thumbnail !== thumbnail) {
        i.thumbnail = thumbnail;
        i.strip.style.backgroundImage = thumbnail
          ? 'url("' + api.assetUrl(thumbnail).replace(/["\\]/g, '\\$&') + '")'
          : '';
      }
      i.strip.hidden = !thumbnail;
      paintWave(i, c, a);
    }
    for (const [id, i] of items)
      if (!seen.has(id)) {
        i.node.remove();
        items.delete(id);
      }
  }

  function refresh() {
    const p = api.project();
    if (p.id !== priorProject) {
      manualTracks = 0;
      minRight = 0;
      priorProject = p.id;
      scroller.scrollLeft = scroller.scrollTop = 0;
    }
    cornerText.textContent = api.t('Ścieżki', 'Tracks');
    label(addTrack, api.t('Dodaj ścieżkę', 'Add track'));
    layoutWidth(p);
    paintClips(p);
    paintRuler();
    paintHead();
  }

  function scrollPaint() {
    scrollFrame = 0;
    if (destroyed) return;
    paintRuler();
    paintHead();
    const p = api.project();
    for (const c of p.clips) {
      const i = items.get(c.id);
      if (i && p.assets[c.assetId]?.waveform) paintWave(i, c, p.assets[c.assetId]);
    }
    if (drag?.event) move(drag.event);
  }

  function setZoom(value, anchorPx = viewWidth() / 2) {
    if (!Number.isFinite(value)) return zoom;
    const fixed = clamp(anchorPx, 0, viewWidth());
    const maximum = Math.min(2200, 27_000_000 / Math.max(1, endTime(api.project())));
    const next = clamp(value, 0.02, maximum);
    const left = anchoredZoom(zoom, next, scroller.scrollLeft, fixed);
    zoom = next;
    minRight = left + viewWidth() + 2;
    refresh();
    scroller.scrollLeft = left;
    paintRuler();
    api.zoomChanged(zoom);
    return zoom;
  }

  function fit() {
    const duration = endTime(api.project());
    scroller.scrollLeft = 0;
    setZoom(duration ? (viewWidth() - 20) / duration : 83, 0);
  }

  function magnets(exclude) {
    const targets = [0, api.time()];
    for (const c of api.project().clips)
      if (!exclude.has(c.id)) targets.push(c.start, c.start + c.duration);
    return targets;
  }

  function snapPoint(time, candidates, magnet) {
    const snapped = snapTime([time], candidates, 8 / zoom, magnet);
    return { t: Math.max(0, snapped.guide ?? (magnet ? rounded(time) : time)), guide: snapped.guide };
  }

  function begin(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const row = e.target.closest('[data-lane]');
    const clipId = e.target.closest('.ce-clip')?.dataset.clipId;
    if (e.target.closest('.ce-lane-label')) {
      if (row)
        api.select(
          api
            .project()
            .clips.filter((c) => c.track === Number(row.dataset.lane))
            .map((c) => c.id),
        );
      return;
    }
    const grab = {
      id: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      t: atX(e.clientX),
      track: trackAt(e.clientY),
      patches: null,
    };
    if (clipId) {
      const edge = e.target.closest('[data-trim]')?.dataset.trim;
      if (!api.pick(clipId, !edge && (e.ctrlKey || e.shiftKey || e.metaKey))) return;
      const ids = new Set(edge ? [clipId] : api.selection());
      const clips = api.project().clips.filter((c) => ids.has(c.id));
      const primary = clips.find((c) => c.id === clipId);
      drag = { ...grab, mode: edge || 'move', clips, primary, targets: magnets(ids) };
      api.pause();
    } else if (row && e.shiftKey) {
      drag = { ...grab, mode: 'select', base: api.selection() };
    } else {
      drag = { ...grab, mode: 'seek' };
      api.pause();
      if (row && !e.ctrlKey) api.select([]);
      api.seek(grab.t);
    }
    scroller.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function ensureAutoScroll() {
    if (autoScroll || !drag || drag.mode === 'seek') return;
    function tick() {
      autoScroll = 0;
      if (!drag?.event || destroyed) return;
      const rect = scroller.getBoundingClientRect(),
        e = drag.event;
      const right = e.clientX - rect.right + 22,
        left = rect.left + gutter() + 22 - e.clientX;
      const down = e.clientY - rect.bottom + 14,
        up = rect.top + rulerRow.offsetHeight + 14 - e.clientY;
      const dx = right > 0 ? Math.min(16, right / 2) : left > 0 ? -Math.min(16, left / 2) : 0;
      const dy = down > 0 ? Math.min(9, down / 2) : up > 0 ? -Math.min(9, up / 2) : 0;
      if (dx || dy) {
        if (dx > 0 && scroller.scrollLeft + viewWidth() + 5 >= sheet.offsetWidth - gutter()) {
          minRight = scroller.scrollLeft + viewWidth() + 160;
          layoutWidth(api.project());
        }
        scroller.scrollBy(dx, dy);
        autoScroll = requestAnimationFrame(tick);
      }
    }
    autoScroll = requestAnimationFrame(tick);
  }

  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const t = atX(e.clientX),
      track = trackAt(e.clientY);
    drag.event = e;
    if (drag.mode === 'seek') {
      api.seek(t);
      return;
    }
    if (
      !drag.patches &&
      !drag.moved &&
      Math.hypot(e.clientX - drag.clientX, e.clientY - drag.clientY) < 3
    )
      return;
    drag.moved = true;
    ensureAutoScroll();
    if (drag.mode === 'select') {
      const a = Math.min(t, drag.t),
        b = Math.max(t, drag.t),
        top = Math.max(track, drag.track),
        bottom = Math.min(track, drag.track);
      marquee.hidden = false;
      marquee.style.left = gutter() + a * zoom + 'px';
      marquee.style.width = (b - a) * zoom + 'px';
      marquee.style.top = rulerRow.offsetHeight + (count - 1 - top) * laneHeight() + 'px';
      marquee.style.height = (top - bottom + 1) * laneHeight() + 'px';
      const ids = api
        .project()
        .clips.filter(
          (c) => c.start < b && c.start + c.duration > a && c.track >= bottom && c.track <= top,
        )
        .map((c) => c.id);
      drag.selected = [...new Set([...drag.base, ...ids])];
      for (const [id, i] of items) i.node.classList.toggle('ce-selected', drag.selected.includes(id));
      return;
    }
    const magnet = api.flags().timelineSnap !== false;
    const patches = new Map();
    const primary = drag.primary,
      dt = t - drag.t;
    if (drag.mode === 'move') {
      const min = Math.min(...drag.clips.map((c) => c.start));
      const d = Math.max(-min, dt);
      const points = drag.clips.flatMap((c) => [c.start + d, c.start + c.duration + d]);
      const snap = snapTime(points, drag.targets, 8 / zoom, magnet);
      const delta = Math.max(
        -min,
        snap.guide !== null ? d + snap.delta : magnet ? rounded(primary.start + d) - primary.start : d,
      );
      guide = snap.guide;
      const tracks = drag.clips.map((c) => c.track);
      const trackDelta = clamp(track - drag.track, -Math.min(...tracks), count - 1 - Math.max(...tracks));
      for (const c of drag.clips)
        patches.set(c.id, { start: Math.max(0, c.start + delta), track: c.track + trackDelta });
    } else {
      const origin = primary.start + (drag.mode === 'end' ? primary.duration : 0);
      const snap = snapPoint(origin + dt, drag.targets, magnet);
      const patch = trimTo(api.project(), primary, drag.mode, snap.t);
      const edge = patch.start + (drag.mode === 'end' ? patch.duration : 0);
      guide = Math.abs(edge - snap.t) < 0.00001 ? snap.guide : null;
      patches.set(primary.id, patch);
    }
    drag.patches = patches;
    api.preview(patches, true);
  }

  function end(e, cancel = false) {
    if (!drag || e.pointerId !== drag.id) return;
    const current = drag;
    drag = null;
    guide = null;
    marquee.hidden = true;
    cancelAnimationFrame(autoScroll);
    autoScroll = 0;
    if (scroller.hasPointerCapture(e.pointerId)) scroller.releasePointerCapture(e.pointerId);
    if (current.mode === 'select' && !cancel && current.selected) api.select(current.selected);
    if (current.patches && !cancel) api.apply(current.patches);
    else api.preview(null, true);
  }

  listen(
    scroller,
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const amount =
        (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewWidth() : 1);
      setZoom(
        zoom * 2 ** (-clamp(amount, -500, 500) / 260),
        e.clientX - scroller.getBoundingClientRect().left - gutter(),
      );
    },
    { passive: false },
  );
  listen(scroller, 'scroll', () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(scrollPaint);
  });
  listen(scroller, 'pointerdown', begin);
  listen(scroller, 'pointermove', move);
  listen(scroller, 'pointerup', (e) => end(e));
  listen(scroller, 'pointercancel', (e) => end(e, true));
  listen(scroller, 'lostpointercapture', (e) => end(e, true));
  // Chromium retargets the synthesized double-click to the capture owner.
  listen(scroller, 'dblclick', (e) => {
    const id = document.elementFromPoint(e.clientX, e.clientY)?.closest('.ce-clip')?.dataset.clipId;
    if (id) api.inspect(id);
  });
  listen(scroller, 'keydown', (e) => {
    const id = e.target.closest('.ce-clip')?.dataset.clipId;
    if (id && e.key === 'Enter') {
      e.preventDefault();
      api.select([id]);
      api.inspect(id);
    }
  });
  function assetPosition(e) {
    return snapPoint(atX(e.clientX), magnets(new Set()), api.flags().timelineSnap !== false);
  }
  listen(scroller, 'dragover', (e) => {
    if (!isAssetDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    draggingAsset = true;
    const track = trackAt(e.clientY);
    guide = assetPosition(e).t;
    for (const [t, r] of rows) r.row.classList.toggle('ce-drop-track', t === track);
    paintHead();
  });
  function endAssetDrag() {
    if (!draggingAsset) return;
    draggingAsset = false;
    guide = null;
    for (const r of rows.values()) r.row.classList.remove('ce-drop-track');
    paintHead();
  }
  listen(scroller, 'dragleave', (e) => {
    if (!scroller.contains(e.relatedTarget)) endAssetDrag();
  });
  listen(scroller, 'drop', (e) => {
    if (!isAssetDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData(assetDragType),
      time = assetPosition(e).t,
      track = trackAt(e.clientY);
    endAssetDrag();
    if (id) api.drop(id, time, track);
  });
  const observer = new ResizeObserver(() => {
    if (!destroyed) refresh();
  });
  observer.observe(scroller);
  return {
    refresh,
    setZoom,
    fit,
    getZoom: () => zoom,
    paintHead,
    reveal() {
      layoutWidth(api.project());
      paintHead(true);
    },
    destroy() {
      destroyed = true;
      events.abort();
      observer.disconnect();
      cancelAnimationFrame(scrollFrame);
      cancelAnimationFrame(autoScroll);
      container.replaceChildren();
      container.classList.remove('ce-timeline');
    },
  };
}
