import { el } from './dom.mjs';
import { setBox } from './editor-dom.mjs';
import { clamp } from './editor-math.mjs';
import {
  correctSlotCrop, cropOnPlane, fitCropView, keepFrameVisible, moveCrop, planeForFrame, trimCrop, zoomCrop,
} from './crop-geometry.mjs';

const edgeNames = {
  nw: ['Lewy górny róg', 'Top left corner'],
  n: ['Górna krawędź', 'Top edge'],
  ne: ['Prawy górny róg', 'Top right corner'],
  e: ['Prawa krawędź', 'Right edge'],
  se: ['Prawy dolny róg', 'Bottom right corner'],
  s: ['Dolna krawędź', 'Bottom edge'],
  sw: ['Lewy dolny róg', 'Bottom left corner'],
  w: ['Lewa krawędź', 'Left edge'],
};
const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function originalIfEqual(rect, original) {
  return ['x', 'y', 'w', 'h'].every((key) => Math.abs(rect[key] - original[key]) < 1e-10)
    ? original
    : rect;
}

export function createCropCanvas({ media, sourceWidth, sourceHeight, crop, box, fixedSlot = false, t }) {
  let original = { crop, box };
  let sourceSize = { w: Math.max(1, sourceWidth), h: Math.max(1, sourceHeight) };
  const selection = el('div', { class: 'crop-selection' });
  const grips = {};
  for (const [edge, names] of Object.entries(edgeNames)) {
    const name = t(...names);
    grips[edge] = el('button', {
      type: 'button', class: 'crop-grip', 'data-edge': edge, title: name, 'aria-label': name,
      'aria-keyshortcuts': 'ArrowUp ArrowDown ArrowLeft ArrowRight',
    });
    selection.append(grips[edge]);
  }
  media.classList.add('crop-media');
  media.draggable = false;
  const source = el('div', { class: 'crop-source' }, media, selection);
  const element = el('div', {
    class: 'crop-workspace', tabIndex: 0, role: 'group', 'aria-label': t('Obszar kadrowania', 'Crop workspace'),
    'aria-keyshortcuts': 'ArrowUp ArrowDown ArrowLeft ArrowRight + -',
  }, source);
  const events = new AbortController();
  const on = (type, listener, options = {}) =>
    element.addEventListener(type, listener, { signal: events.signal, ...options });
  let current = original;
  let plane = null;
  let viewport = null;
  let drag = null;
  let pendingSize = null;

  function draw() {
    setBox(selection, current.crop);
    if (!plane) return;
    Object.assign(source.style, {
      left: plane.x + 'px', top: plane.y + 'px', width: plane.w + 'px', height: plane.h + 'px',
    });
  }

  function endDrag(cancel) {
    if (!drag) return;
    const ended = drag;
    drag = null;
    delete element.dataset.drag;
    if (element.hasPointerCapture(ended.id)) element.releasePointerCapture(ended.id);
    if (cancel) {
      current = ended.start;
      plane = ended.plane;
      draw();
    }
    if (pendingSize) {
      const { w, h, correctedCrop } = pendingSize;
      pendingSize = null;
      setSourceSize(w, h, correctedCrop);
    }
  }

  function fit(force = false) {
    const w = element.clientWidth, h = element.clientHeight;
    if (!w || !h || (!force && w === viewport?.w && h === viewport?.h)) return;
    endDrag(true);
    viewport = { w, h };
    plane = fitCropView(current.crop, sourceSize, viewport);
    draw();
  }

  function setSourceSize(w, h, correctedCrop) {
    if (events.signal.aborted || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    if (drag) {
      pendingSize = { w, h, correctedCrop };
      return;
    }
    const aspectChanged = w * sourceSize.h !== h * sourceSize.w;
    const before = current.crop;
    sourceSize = { w, h };
    if (fixedSlot && correctedCrop) {
      const previous = original.crop;
      const untouched = originalIfEqual(before, previous) === previous;
      const next = untouched ? correctedCrop : correctSlotCrop(before, previous, correctedCrop, sourceSize);
      original = { crop: correctedCrop, box };
      current = { crop: next, box };
    }
    if (aspectChanged || originalIfEqual(current.crop, before) !== before) fit(true);
  }

  function modeAt(event) {
    const grip = event.target.closest('[data-edge]');
    if (grip) return grip.dataset.edge;
    const r = selection.getBoundingClientRect();
    const x = event.clientX - r.left, y = event.clientY - r.top;
    const hitX = Math.min(7, r.width / 4), hitY = Math.min(7, r.height / 4);
    if (x >= -hitX && x <= r.width + hitX && y >= -hitY && y <= r.height + hitY) {
      const side = x <= hitX ? 'w' : x >= r.width - hitX ? 'e' : '';
      const end = y <= hitY ? 'n' : y >= r.height - hitY ? 's' : '';
      return end + side || 'pan';
    }
    return source.contains(event.target) ? 'move' : '';
  }

  on('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || drag) return;
    fit();
    if (!plane) return;
    const mode = modeAt(event);
    if (!mode) return;
    event.preventDefault();
    (grips[mode] || element).focus({ preventScroll: true });
    element.setPointerCapture(event.pointerId);
    element.dataset.drag = mode;
    drag = {
      mode, id: event.pointerId, x: event.clientX, y: event.clientY,
      start: current, plane, frame: cropOnPlane(plane, current.crop),
    };
  });

  function updateDrag(event) {
    const dx = (event.clientX - drag.x) / drag.plane.w;
    const dy = (event.clientY - drag.y) / drag.plane.h;
    if (drag.mode === 'pan') {
      const next = moveCrop(drag.start.crop, -dx, -dy);
      current = { crop: next, box: drag.start.box };
      plane = planeForFrame(drag.frame, next);
    } else if (drag.mode === 'move') {
      current = { crop: moveCrop(drag.start.crop, dx, dy), box: drag.start.box };
    } else {
      current = trimCrop(drag.start, drag.mode, dx, dy, sourceSize, fixedSlot);
    }
    draw();
  }

  on('pointermove', (event) => {
    if (drag?.id === event.pointerId) updateDrag(event);
    else if (!drag && plane) element.dataset.hover = modeAt(event);
  });
  on('pointerleave', () => { delete element.dataset.hover; });
  on('pointerup', (event) => {
    if (drag?.id !== event.pointerId) return;
    const movedFrame = drag.mode !== 'pan';
    updateDrag(event);
    endDrag(false);
    if (movedFrame) {
      plane = keepFrameVisible(plane, current.crop, viewport);
      draw();
    }
  });
  const cancelPointer = (event) => {
    if (drag?.id === event.pointerId) endDrag(true);
  };
  on('pointercancel', cancelPointer);
  on('lostpointercapture', cancelPointer);

  function zoom(factor, focusX, focusY) {
    const frame = cropOnPlane(plane, current.crop);
    const next = zoomCrop(current.crop, factor, focusX, focusY, sourceSize);
    plane = planeForFrame(frame, next);
    current = { crop: next, box: current.box };
    draw();
  }

  on('wheel', (event) => {
    event.preventDefault();
    if (drag || !event.deltaY) return;
    fit();
    if (!plane) return;
    const frame = selection.getBoundingClientRect();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.h : 1;
    const factor = Math.exp(clamp(event.deltaY * unit * 0.002, -2, 2));
    zoom(factor, (event.clientX - frame.left) / frame.width, (event.clientY - frame.top) / frame.height);
  }, { passive: false });

  on('keydown', (event) => {
    if (drag || event.ctrlKey || event.metaKey || event.altKey) return;
    fit();
    if (!plane) return;
    if (['+', '=', '-', '_'].includes(event.key)) {
      event.preventDefault();
      zoom(event.key === '+' || event.key === '=' ? 1 / 1.2 : 1.2, 0.5, 0.5);
      return;
    }
    const direction = arrows[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const dx = direction[0] * step / sourceSize.w, dy = direction[1] * step / sourceSize.h;
    const edge = event.target.closest('[data-edge]')?.dataset.edge;
    if (edge) {
      current = trimCrop(current, edge, dx, dy, sourceSize, fixedSlot);
      plane = keepFrameVisible(plane, current.crop, viewport);
    } else {
      const frame = cropOnPlane(plane, current.crop);
      const next = moveCrop(current.crop, -dx, -dy);
      current = { crop: next, box: current.box };
      plane = planeForFrame(frame, next);
    }
    draw();
  });

  const observer = new ResizeObserver(() => fit());
  observer.observe(element);
  // The dialog attaches its workspace immediately after construction. Size this first
  // layout before callers can hit-test it; the observer follows later layout changes.
  queueMicrotask(() => { if (element.isConnected && !events.signal.aborted) fit(); });
  draw();
  return {
    element,
    getResult: () => ({
      crop: originalIfEqual(current.crop, original.crop),
      box: originalIfEqual(current.box, original.box),
    }),
    setSourceSize,
    reset() {
      endDrag(true);
      current = original;
      fit(true);
    },
    destroy() {
      pendingSize = null;
      endDrag(false);
      events.abort();
      observer.disconnect();
    },
  };
}
