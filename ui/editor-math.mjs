export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const clean = (n) => Math.round(n * 1e9) / 1e9;

/** Scroll offset that keeps the pointer over the same time after a zoom. */
export const anchoredZoom = (before, after, scrollLeft, px) =>
  Math.max(0, ((scrollLeft + px) * after) / before - px);

export function timecode(seconds, fps = 30) {
  const base = Math.max(1, Math.round(fps));
  const f = Math.max(0, Math.round(seconds * fps));
  const s = Math.floor(f / base);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, f % base]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/** Find one translation that aligns any moving edge with a nearby anchor. */
export function snapTime(points, targets, tolerance, enabled = true) {
  let delta = 0;
  let guide = null;
  let distance = tolerance + 1e-10;
  if (enabled) {
    for (const anchor of targets) {
      for (const p of points) {
        const d = Math.abs(anchor - p);
        if (d < distance) {
          distance = d;
          delta = clean(anchor - p);
          guide = anchor;
        }
      }
    }
  }
  return { delta, guide };
}

const points = (pos, size) => [pos, pos + size * 0.5, pos + size];
export function sceneTargets(others) {
  const x = [0, 0.5, 1],
    y = [0, 0.5, 1];
  for (const b of others) {
    x.push(...points(b.x, b.w));
    y.push(...points(b.y, b.h));
  }
  return { x, y };
}

export function snapBox(box, otherBoxes, toleranceX, toleranceY, enabled = true) {
  const guides = sceneTargets(otherBoxes);
  const x = snapTime(points(box.x, box.w), guides.x, toleranceX, enabled);
  const y = snapTime(points(box.y, box.h), guides.y, toleranceY, enabled);
  return {
    box: { ...box, x: clean(box.x + x.delta), y: clean(box.y + y.delta) },
    x: x.guide,
    y: y.guide,
  };
}

export function bounds(boxes) {
  const left = Math.min(...boxes.map((b) => b.x)),
    top = Math.min(...boxes.map((b) => b.y));
  return {
    x: left,
    y: top,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - left,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - top,
  };
}

// Corner resizing normally preserves the shape as seen on the stage.
export function resizeBox(b, handle, dx, dy, lockAspect) {
  const west = handle.includes('w'),
    east = handle.includes('e');
  const north = handle.includes('n'),
    south = handle.includes('s');
  let w = Math.max(0.002, b.w + (west ? -dx : east ? dx : 0));
  let h = Math.max(0.002, b.h + (north ? -dy : south ? dy : 0));
  if (lockAspect && (west || east) && (north || south)) {
    const scaleX = w / b.w,
      scaleY = h / b.h;
    const scale = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
    w = b.w * scale;
    h = b.h * scale;
  }
  return {
    x: clean(west ? b.x + b.w - w : b.x),
    y: clean(north ? b.y + b.h - h : b.y),
    w: clean(w),
    h: clean(h),
  };
}

// The source pixels that remain visible keep their stage position when cropping.
export function cropEdge({ box, crop }, handle, dx, dy) {
  const b = { ...box },
    c = { ...crop };
  function axis(pos, size, delta, near, far) {
    if (!handle.includes(near) && !handle.includes(far)) return;
    const sourcePerStage = crop[size] / box[size];
    const minimum = Math.min(0.002, crop[size]);
    if (handle.includes(near)) {
      const diff = clamp(delta * sourcePerStage, -crop[pos], crop[size] - minimum);
      c[pos] = clean(crop[pos] + diff);
      c[size] = clean(crop[size] - diff);
      b[pos] = clean(box[pos] + diff / sourcePerStage);
      b[size] = clean(box[size] - diff / sourcePerStage);
    } else {
      const diff = clamp(delta * sourcePerStage, minimum - crop[size], 1 - crop[pos] - crop[size]);
      c[size] = clean(crop[size] + diff);
      b[size] = clean(box[size] + diff / sourcePerStage);
    }
  }
  axis('x', 'w', dx, 'w', 'e');
  axis('y', 'h', dy, 'n', 's');
  return { box: b, crop: c };
}
