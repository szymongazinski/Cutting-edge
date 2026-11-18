import { fullBox, isVisual, loops, sceneAt } from './model.mjs';
import { bounds, clamp, cropEdge, resizeBox, sceneTargets, snapBox, snapTime } from './editor-math.mjs';
import { assetDragType, button, element, icon, isAssetDrag, label, setBox } from './editor-dom.mjs';
import { gifPlayer } from './editor-gif.mjs';

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// libass sizes an em by the font's ascent + descent. CSS font-size uses
// units-per-em. Measuring the selected Windows face keeps previews, including
// bold/italic variants, at the same scale as its ASS render.
const fontScales = new Map();
let measure;
function subtitleFontScale(family, bold, italic) {
  const face = (italic ? 'italic ' : '') + (bold ? 'bold ' : '') + '1024px ' + family;
  if (fontScales.has(face)) return fontScales.get(face);
  measure ||= document.createElement('canvas').getContext('2d');
  measure.font = face;
  const metrics = measure.measureText('Hg');
  const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  const scale = height > 0 ? 1024 / height : 1;
  fontScales.set(face, scale);
  return scale;
}

export function createPreview(container, api) {
  const events = new AbortController();
  const listen = (node, event, fn) => node.addEventListener(event, fn, { signal: events.signal });
  container.classList.add('ce-stage');
  const frame = element('div', 'ce-stage-frame', container);
  const output = element('div', 'ce-stage-output', frame);
  const overlay = element('div', 'ce-stage-overlay', frame);
  const guideX = element('i', 'ce-scene-guide-x', overlay);
  const guideY = element('i', 'ce-scene-guide-y', overlay);
  const empty = element('div', 'ce-stage-empty', frame);
  icon('clapperboard', empty);
  const emptyText = element('span', 'ce-empty-text', empty);
  const warning = element('div', 'ce-stage-warning', container);
  warning.setAttribute('role', 'status');
  const cropButton = button(frame, 'ce-stage-crop ce-icon-btn', '', () => {
    cropMode = !cropMode;
    render();
  });
  icon('crop', cropButton);
  const cache = new Map(),
    selections = new Map();
  let cropMode = false,
    priorSingle = null,
    drag = null,
    renderIndex = 0;
  let audioContext,
    destroyed = false,
    queued = false,
    pendingGuides = {};
  let lastPlanTime = NaN,
    upcoming = [];

  function schedule() {
    if (queued || destroyed) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!destroyed) render();
    });
  }

  function fit() {
    const p = api.project();
    const css = getComputedStyle(container);
    const w = Math.max(
      1,
      container.clientWidth - parseFloat(css.paddingLeft || 0) - parseFloat(css.paddingRight || 0),
    );
    const h = Math.max(
      1,
      container.clientHeight - parseFloat(css.paddingTop || 0) - parseFloat(css.paddingBottom || 0),
    );
    const scale = Math.min(w / p.width, h / p.height);
    frame.style.width = p.width * scale + 'px';
    frame.style.height = p.height * scale + 'px';
    output.style.width = p.width + 'px';
    output.style.height = p.height + 'px';
    output.style.transform = 'scale(' + scale + ')';
  }

  function dispose(record) {
    record.outer.remove();
    record.gif?.destroy();
    if (record.media) {
      record.media.pause();
      record.media.removeAttribute('src');
      record.media.load();
    }
    record.sourceNode?.disconnect();
    record.gainNode?.disconnect();
    cache.delete(record.id);
  }

  function createRecord(node, signature) {
    const { clip, asset } = node;
    const outer = element('div', 'ce-layer');
    const under = element('div', 'ce-layer-source', outer);
    const record = { id: clip.id, name: clip.name, signature, outer, under, stamp: -1 };
    const fail = () => {
      record.error = true;
      schedule();
    };
    if (clip.kind === 'compound') {
      record.space = element('div', 'ce-layer-space', under);
    } else if (clip.kind === 'text' || clip.kind === 'caption') {
      record.space = element('div', 'ce-layer-words', under);
      record.words = element('div', 'ce-layer-glyphs', record.space);
    } else if (asset) {
      const url = api.assetUrl(asset.previewPath || asset.path);
      const rawGif = asset.kind === 'video' && /\.gif(?:$|[?#])/i.test(asset.previewPath || asset.path);
      if (rawGif) {
        const canvas = element('canvas', 'ce-stage-media', under);
        record.gif = gifPlayer(canvas, url, fail);
      } else if (asset.kind === 'image') {
        const img = element('img', 'ce-stage-media', under);
        img.alt = '';
        img.draggable = false;
        img.addEventListener('error', fail, { once: true });
        img.src = url;
      } else {
        const media = element(asset.kind === 'audio' ? 'audio' : 'video', 'ce-stage-media', under);
        media.playsInline = true;
        media.preload = 'auto';
        media.crossOrigin = 'anonymous';
        media.loop = loops(asset);
        media.disablePictureInPicture = true;
        media.addEventListener('loadedmetadata', schedule);
        media.addEventListener('seeked', schedule);
        media.addEventListener('canplay', schedule);
        media.addEventListener('error', () => {
          if (media.hasAttribute('src')) fail();
        });
        media.src = url;
        record.media = media;
      }
    } else record.error = true;
    cache.set(clip.id, record);
    return record;
  }

  function recordFor(node) {
    const { clip, asset } = node;
    const signature = [clip.kind, asset?.kind, asset?.previewPath || asset?.path].join('|');
    const r = cache.get(clip.id);
    if (r?.signature === signature) return r;
    if (r) dispose(r);
    return createRecord(node, signature);
  }

  function planUpcoming(p, time) {
    const result = [],
      horizon = time + 1.8;
    function visit(clips, origin, parentStart, parentEnd) {
      for (const clip of clips) {
        const original = origin + clip.start;
        const start = Math.max(original, parentStart),
          end = Math.min(original + clip.duration, parentEnd);
        if (end <= Math.max(time, start) || start > horizon) continue;
        if (clip.kind === 'compound') {
          visit(clip.children, original - clip.in, start, end);
          continue;
        }
        const asset = p.assets[clip.assetId];
        if (clip.kind !== 'media' || !asset || start <= time) continue;
        let sourceTime = clip.in + start - original;
        if (loops(asset) && asset.duration > 0) sourceTime %= asset.duration;
        if (asset.kind !== 'image' && asset.duration > 0 && sourceTime >= asset.duration) continue;
        result.push({ clip, asset, sourceTime, start });
      }
    }
    visit(p.clips, 0, 0, Infinity);
    return result.sort((a, b) => a.start - b.start).slice(0, 8);
  }

  // A trimmed cut needs an independent decoder already at its source offset.
  // Detached, paused elements keep the preroll inaudible and outside the stage.
  function prime(p, time) {
    if (!Number.isFinite(lastPlanTime) || time < lastPlanTime || time - lastPlanTime > 0.2) {
      upcoming = planUpcoming(p, time);
      lastPlanTime = time;
    }
    const warm = new Set();
    for (const node of upcoming) {
      if (node.start <= time) continue;
      const r = recordFor(node);
      warm.add(r.id);
      if (r.stamp === renderIndex) continue;
      r.gif?.seek(node.sourceTime);
      const m = r.media;
      if (!m || r.error) continue;
      m.muted = true;
      if (m.readyState >= 1 && !m.seeking && Math.abs(m.currentTime - node.sourceTime) > 0.004) {
        try {
          m.currentTime = node.sourceTime;
        } catch {
          /* Decoder metadata can change during preload. */
        }
      }
    }
    return warm;
  }

  function setGain(record, volume) {
    const { media } = record;
    const val = Math.max(0, volume);
    if (val > 1 && !record.gainNode && !record.cannotBoost) {
      try {
        audioContext ||= new AudioContext();
        record.sourceNode = audioContext.createMediaElementSource(media);
        record.gainNode = audioContext.createGain();
        record.sourceNode.connect(record.gainNode).connect(audioContext.destination);
      } catch {
        record.cannotBoost = true;
      }
    }
    if (record.gainNode) {
      record.gainNode.gain.value = val;
      if (media.volume !== 1) media.volume = 1;
      if (api.playing() && audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
    } else if (media.volume !== Math.min(1, val)) media.volume = Math.min(1, val);
    media.muted = val === 0;
  }

  function sync(record, node) {
    if (record.gif) record.gif.seek(node.sourceTime);
    const m = record.media;
    if (!m) return;
    setGain(record, node.volume);
    const playing = api.playing();
    if (!playing && !m.paused) m.pause();
    if (m.readyState < 1 || record.error) return;
    const fps = api.project().fps || 30;
    const target = Number.isFinite(m.duration)
      ? clamp(node.sourceTime, 0, Math.max(0, m.duration - 0.001))
      : node.sourceTime;
    const drift = target - m.currentTime;
    // Keep paused scrubbing sample-accurate. The master clock governs every
    // decoder, including audio-only tracks and independent compound children.
    if (
      (!playing && Math.abs(drift) > 0.002 && Math.abs((record.lastSeek ?? -1) - target) > 0.0004) ||
      (playing && !m.seeking && Math.abs(drift) > Math.max(0.11, 2 / fps))
    ) {
      try {
        m.currentTime = target;
        record.lastSeek = target;
      } catch {
        /* Metadata can change while seeking. */
      }
    }
    if (playing) {
      record.lastSeek = undefined;
      if (m.paused && !record.playPromise && !m.ended && !record.playRejected) {
        record.playPromise = m
          .play()
          .catch((e) => {
            if (e.name !== 'AbortError') record.playRejected = true;
          })
          .finally(() => {
            record.playPromise = null;
          });
      }
      const rate = m.seeking || Math.abs(drift) < 0.025 ? 1 : clamp(1 + drift * 0.35, 0.96, 1.04);
      if (Math.abs(m.playbackRate - rate) > 0.004) m.playbackRate = rate;
    } else {
      record.playRejected = false;
      if (m.playbackRate !== 1) m.playbackRate = 1;
    }
  }

  function paint(nodes, parent, isRoot, p) {
    let prior = null;
    for (const node of nodes) {
      const { clip, asset } = node;
      const r = recordFor(node);
      r.stamp = renderIndex;
      if (isRoot) r.outer.dataset.topId = clip.id;
      else delete r.outer.dataset.topId;
      const next = prior ? prior.nextElementSibling : parent.firstElementChild;
      if (next !== r.outer) parent.insertBefore(r.outer, next);
      prior = r.outer;
      const b = clip.box || fullBox(),
        c = clip.crop || fullBox();
      const layoutKey = [b.x, b.y, b.w, b.h, c.x, c.y, c.w, c.h, p.width, p.height].join(',');
      if (r.layoutKey !== layoutKey) {
        setBox(r.outer, b);
        setBox(r.under, { x: -c.x / c.w, y: -c.y / c.h, w: 1 / c.w, h: 1 / c.h });
        if (r.space) {
          const compound = clip.kind === 'compound';
          r.space.style.width = (compound ? p.width : b.w * p.width) + 'px';
          r.space.style.height = (compound ? p.height : b.h * p.height) + 'px';
          r.space.style.transform =
            'scale(' + (compound ? b.w / c.w : 1 / c.w) + ',' + (compound ? b.h / c.h : 1 / c.h) + ')';
        }
        r.layoutKey = layoutKey;
      }
      r.outer.hidden =
        asset?.kind === 'audio' ||
        Boolean(r.words && !node.text) ||
        (clip.kind === 'compound' && !isVisual(p, clip));
      if (r.words) {
        if (r.words.textContent !== node.text) r.words.textContent = node.text;
        const s = clip.style || {};
        const styleKey = JSON.stringify(s) + p.height;
        if (r.styleKey !== styleKey) {
          r.space.style.background = s.background || 'transparent';
          const style = r.words.style;
          style.fontFamily = '"' + String(s.font || 'Arial').replace(/["\\\r\n]/g, '') + '", sans-serif';
          const size = s.size || p.height * 0.05;
          style.fontSize = size * subtitleFontScale(style.fontFamily, s.bold, s.italic) + 'px';
          style.lineHeight = size + 'px';
          style.fontWeight = s.bold ? '700' : '400';
          style.fontStyle = s.italic ? 'italic' : 'normal';
          style.color = s.color || '#ffffff';
          style.webkitTextStrokeColor = s.stroke || '#000000';
          style.webkitTextStrokeWidth = 2 * (s.strokeWidth ?? 2) + 'px';
          r.styleKey = styleKey;
        }
      }
      sync(r, node);
      if (node.children) paint(node.children, r.space, false, p);
    }
  }

  function paintSelection(nodes, p) {
    const selected = new Set(api.selection());
    const active = new Set();
    for (const { clip } of nodes) {
      if (!selected.has(clip.id) || !isVisual(p, clip)) continue;
      active.add(clip.id);
      let node = selections.get(clip.id);
      if (!node) {
        node = element('div', 'ce-stage-selection', overlay);
        node.dataset.topId = clip.id;
        for (const edge of handles) {
          const grip = element('i', 'ce-stage-grip ce-grip-' + edge, node);
          grip.dataset.handle = edge;
        }
        selections.set(clip.id, node);
      }
      setBox(node, clip.box || fullBox());
      node.classList.toggle('ce-is-cropping', cropMode && selected.size === 1);
    }
    for (const [id, n] of selections)
      if (!active.has(id)) {
        n.remove();
        selections.delete(id);
      }
    const single = active.size === 1 ? [...active][0] : null;
    if (single !== priorSingle) {
      cropMode = false;
      priorSingle = single;
    }
    cropButton.hidden = !single;
    cropButton.classList.toggle('ce-active', cropMode);
    cropButton.setAttribute('aria-pressed', String(cropMode));
    label(
      cropButton,
      api.t('Kadruj uchwytami (Alt podczas przeciągania)', 'Crop with handles (Alt while dragging)'),
    );
    guideX.hidden = !Number.isFinite(pendingGuides.x);
    guideY.hidden = !Number.isFinite(pendingGuides.y);
    if (!guideX.hidden) guideX.style.left = pendingGuides.x * 100 + '%';
    if (!guideY.hidden) guideY.style.top = pendingGuides.y * 100 + '%';
  }

  function render() {
    const p = api.project();
    renderIndex++;
    const nodes = sceneAt(p, api.time());
    paint(nodes, output, true, p);
    const warm = prime(p, api.time());
    const inactive = [];
    let problem = '';
    for (const r of cache.values()) {
      if (r.stamp === renderIndex) {
        if (r.error) problem = r.name || '…';
      } else {
        if (r.outer.isConnected) r.outer.remove();
        if (r.media && !r.media.paused) r.media.pause();
        if (!warm.has(r.id)) inactive.push(r);
      }
    }
    if (inactive.length > 12)
      inactive
        .sort((a, b) => b.stamp - a.stamp)
        .slice(12)
        .forEach(dispose);
    empty.hidden = Boolean(p.clips.length);
    emptyText.textContent = api.t('Przeciągnij materiał na oś czasu', 'Drag media onto the timeline');
    warning.hidden = !problem;
    if (problem) warning.textContent = api.t('Problem z podglądem pliku ', 'Cannot preview ') + problem;
    paintSelection(nodes, p);
  }

  function dragStart(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const clicked = e.target.closest('[data-top-id]')?.dataset.topId;
    if (!clicked) {
      if (!e.shiftKey && !e.ctrlKey) api.select([]);
      return;
    }
    const edge = e.target.closest('[data-handle]')?.dataset.handle;
    if (!edge && !api.pick(clicked, e.shiftKey || e.ctrlKey || e.metaKey)) return;
    api.pause();
    const p = api.project();
    const ids = new Set(edge ? [clicked] : api.selection());
    const active = sceneAt(p, api.time())
      .map((n) => n.clip)
      .filter((c) => isVisual(p, c));
    const moving = active.filter((c) => ids.has(c.id));
    if (!moving.length) return;
    const rect = frame.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      rect,
      edge,
      crop: Boolean(edge && (e.altKey || cropMode)),
      moving,
      others: active.filter((c) => !ids.has(c.id)).map((c) => c.box || fullBox()),
      group: bounds(moving.map((c) => c.box || fullBox())),
      patches: null,
    };
    container.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function dragMove(e) {
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.patches && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 3) return;
    let dx = (e.clientX - drag.x) / drag.rect.width,
      dy = (e.clientY - drag.y) / drag.rect.height;
    const tx = 7 / drag.rect.width,
      ty = 7 / drag.rect.height;
    const magnet = api.flags().sceneSnap !== false;
    const patches = new Map();
    pendingGuides = {};
    if (!drag.edge) {
      const b = drag.group;
      const moved = snapBox({ ...b, x: b.x + dx, y: b.y + dy }, drag.others, tx, ty, magnet);
      pendingGuides = moved;
      for (const c of drag.moving) {
        const box = c.box || fullBox();
        patches.set(c.id, {
          box: { ...box, x: box.x + moved.box.x - b.x, y: box.y + moved.box.y - b.y },
        });
      }
    } else {
      const c = drag.moving[0],
        b = c.box || fullBox(),
        edge = drag.edge;
      const anchors = sceneTargets(drag.others);
      const left = edge.includes('w'),
        right = edge.includes('e'),
        top = edge.includes('n'),
        bottom = edge.includes('s');
      const sx = snapTime([b.x + (left ? 0 : b.w) + dx], anchors.x, tx, magnet && (left || right));
      const sy = snapTime([b.y + (top ? 0 : b.h) + dy], anchors.y, ty, magnet && (top || bottom));
      dx += sx.delta;
      dy += sy.delta;
      const patch = drag.crop
        ? cropEdge({ box: b, crop: c.crop || fullBox() }, edge, dx, dy)
        : { box: resizeBox(b, edge, dx, dy, !e.shiftKey) };
      patches.set(c.id, patch);
      if (sx.guide !== null && Math.abs(patch.box.x + (left ? 0 : patch.box.w) - sx.guide) < 0.0001)
        pendingGuides.x = sx.guide;
      if (sy.guide !== null && Math.abs(patch.box.y + (top ? 0 : patch.box.h) - sy.guide) < 0.0001)
        pendingGuides.y = sy.guide;
    }
    drag.patches = patches;
    api.preview(patches, false);
  }

  function endDrag(e, cancel = false) {
    if (!drag || drag.id !== e.pointerId) return;
    const patches = drag.patches;
    drag = null;
    pendingGuides = {};
    if (container.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId);
    if (!cancel && patches) api.apply(patches);
    else api.preview(null, false);
  }

  listen(container, 'pointerdown', dragStart);
  listen(container, 'pointermove', dragMove);
  listen(container, 'pointerup', (e) => endDrag(e));
  listen(container, 'pointercancel', (e) => endDrag(e, true));
  listen(container, 'lostpointercapture', (e) => endDrag(e, true));
  listen(container, 'dblclick', (e) => {
    const id = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-top-id]')?.dataset.topId;
    if (id) api.inspect(id);
  });
  listen(container, 'dragover', (e) => {
    if (isAssetDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  listen(container, 'drop', (e) => {
    if (!isAssetDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData(assetDragType);
    if (id)
      api.drop(
        id,
        api.time(),
        Math.min(
          999,
          api.project().clips.reduce((n, c) => Math.max(n, c.track + 1), 0),
        ),
      );
  });
  const observer = new ResizeObserver(fit);
  observer.observe(container);
  return {
    render,
    refresh() {
      lastPlanTime = NaN;
      fit();
      render();
    },
    reset() {
      for (const r of [...cache.values()]) dispose(r);
      cropMode = false;
      upcoming = [];
      lastPlanTime = NaN;
    },
    destroy() {
      destroyed = true;
      events.abort();
      observer.disconnect();
      for (const r of [...cache.values()]) dispose(r);
      if (audioContext) void audioContext.close().catch(() => {});
      container.replaceChildren();
      container.classList.remove('ce-stage');
    },
  };
}
