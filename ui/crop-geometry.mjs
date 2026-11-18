import { clamp } from './editor-math.mjs';

// A plane can be the source projected onto the workspace (CSS pixels) or the scene (normalized).
export function cropOnPlane(plane, crop) {
  return {
    x: plane.x + crop.x * plane.w,
    y: plane.y + crop.y * plane.h,
    w: crop.w * plane.w,
    h: crop.h * plane.h,
  };
}

export function planeForFrame(frame, crop) {
  const w = frame.w / crop.w;
  const h = frame.h / crop.h;
  return { x: frame.x - crop.x * w, y: frame.y - crop.y * h, w, h };
}

export function fitCropView(crop, source, viewport) {
  const padding = Math.min(20, viewport.w / 8, viewport.h / 8);
  const availableW = viewport.w - 2 * padding;
  const availableH = viewport.h - 2 * padding;
  const fitSource = Math.min(availableW / source.w, availableH / source.h);
  const fitCrop = Math.min(availableW / (crop.w * source.w), availableH / (crop.h * source.h));
  const scale = Math.max(fitSource, 0.84 * fitCrop);
  const w = source.w * scale;
  const h = source.h * scale;

  // Center on the selected pixels while retaining surrounding source wherever it is available.
  function position(size, extent, focus) {
    if (size <= extent - 2 * padding) return (extent - size) / 2;
    return clamp(extent / 2 - focus * size, extent - padding - size, padding);
  }
  return {
    x: position(w, viewport.w, crop.x + crop.w / 2),
    y: position(h, viewport.h, crop.y + crop.h / 2),
    w, h,
  };
}

export function keepFrameVisible(plane, crop, viewport) {
  const frame = cropOnPlane(plane, crop);
  if (frame.x >= 0 && frame.y >= 0 && frame.x + frame.w <= viewport.w && frame.y + frame.h <= viewport.h)
    return plane;
  const padding = Math.min(14, viewport.w / 8, viewport.h / 8);
  const scale = Math.min(1, (viewport.w - 2 * padding) / frame.w, (viewport.h - 2 * padding) / frame.h);
  const w = frame.w * scale;
  const h = frame.h * scale;
  const x = clamp(frame.x + (frame.w - w) / 2, padding, viewport.w - padding - w);
  const y = clamp(frame.y + (frame.h - h) / 2, padding, viewport.h - padding - h);
  return planeForFrame({ x, y, w, h }, crop);
}

export function moveCrop(crop, dx, dy) {
  return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.w), y: clamp(crop.y + dy, 0, 1 - crop.h) };
}

function resizedCrop(crop, w, h, anchorX, anchorY) {
  return {
    x: clamp(crop.x + (crop.w - w) * anchorX, 0, 1 - w),
    y: clamp(crop.y + (crop.h - h) * anchorY, 0, 1 - h),
    w, h,
  };
}

function minimumScale(crop, source) {
  // Already-saved subpixel crops must also open and respond without jumping.
  return Math.min(1, Math.max(1 / (source.w * crop.w), 1 / (source.h * crop.h)));
}

export function zoomCrop(crop, factor, anchorX, anchorY, source) {
  const scale = clamp(factor, minimumScale(crop, source), Math.min(1 / crop.w, 1 / crop.h));
  return resizedCrop(crop, crop.w * scale, crop.h * scale, anchorX, anchorY);
}

export function correctSlotCrop(crop, oldCover, cover, source) {
  const next = zoomCrop(cover, crop.w / oldCover.w, 0.5, 0.5, source);
  const dx = crop.x + crop.w / 2 - (next.x + next.w / 2);
  const dy = crop.y + crop.h / 2 - (next.y + next.h / 2);
  return moveCrop(next, dx, dy);
}

export function trimCrop({ crop, box }, edge, dx, dy, source, fixedSlot = false) {
  const west = edge.includes('w'), east = edge.includes('e');
  const north = edge.includes('n'), south = edge.includes('s');
  const widthChange = west ? -dx : east ? dx : 0;
  const heightChange = north ? -dy : south ? dy : 0;
  const maxW = west ? crop.x + crop.w : east ? 1 - crop.x : 1;
  const maxH = north ? crop.y + crop.h : south ? 1 - crop.y : 1;
  let w, h;
  if (fixedSlot || edge.length === 2) {
    const changeX = widthChange / crop.w;
    const changeY = heightChange / crop.h;
    const change = Math.abs(changeX) >= Math.abs(changeY) ? changeX : changeY;
    const scale = clamp(1 + change, minimumScale(crop, source), Math.min(maxW / crop.w, maxH / crop.h));
    w = crop.w * scale;
    h = crop.h * scale;
  } else {
    w = clamp(crop.w + widthChange, Math.min(crop.w, 1 / source.w), maxW);
    h = clamp(crop.h + heightChange, Math.min(crop.h, 1 / source.h), maxH);
  }
  const next = resizedCrop(crop, w, h, west ? 1 : east ? 0 : 0.5, north ? 1 : south ? 0 : 0.5);
  return { crop: next, box: fixedSlot ? box : cropOnPlane(planeForFrame(box, crop), next) };
}
