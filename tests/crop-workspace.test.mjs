import test from 'node:test';
import assert from 'node:assert/strict';
import {
  correctSlotCrop, cropOnPlane, fitCropView, keepFrameVisible, moveCrop, planeForFrame, trimCrop, zoomCrop,
} from '../ui/crop-geometry.mjs';

const source = { w: 1000, h: 500 };
const full = { x: 0, y: 0, w: 1, h: 1 };

function closeRect(result, expected) {
  for (const key of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(result[key] - expected[key]) < 1e-9, `${key}: expected ${expected[key]}, got ${result[key]}`);
  }
}

test('each free edge trims just its axis and leaves the remaining pixels in their stretched scene position', () => {
  const crop = { x: 0.25, y: 0.2, w: 0.5, h: 0.4 };
  const box = { x: 0.1, y: 0.3, w: 0.6, h: 0.25 };
  for (const [edge, dx, dy, expectedCrop, expectedBox] of [
    ['w', 0.125, 0.2, { ...crop, x: 0.375, w: 0.375 }, { ...box, x: 0.25, w: 0.45 }],
    ['e', -0.125, 0.2, { ...crop, w: 0.375 }, { ...box, w: 0.45 }],
    ['n', 0.2, 0.1, { ...crop, y: 0.3, h: 0.3 }, { ...box, y: 0.3625, h: 0.1875 }],
    ['s', 0.2, -0.1, { ...crop, h: 0.3 }, { ...box, h: 0.1875 }],
  ]) {
    const result = trimCrop({ crop, box }, edge, dx, dy, source);
    closeRect(result.crop, expectedCrop);
    closeRect(result.box, expectedBox);
  }
});

test('all four corners keep the crop aspect and the opposite corner fixed', () => {
  const crop = { x: 0.2, y: 0.1, w: 0.6, h: 0.4 };
  for (const [edge, dx, dy, x, y] of [
    ['nw', 0.15, 0.1, 0.35, 0.2],
    ['ne', -0.15, 0.1, 0.2, 0.2],
    ['sw', 0.15, -0.1, 0.35, 0.1],
    ['se', -0.15, -0.1, 0.2, 0.1],
  ]) {
    const result = trimCrop({ crop, box: full }, edge, dx, dy, source);
    closeRect(result.crop, { x, y, w: 0.45, h: 0.3 });
  }
  const atLimit = trimCrop({ crop, box: full }, 'nw', -2, -3, source);
  closeRect(atLimit.crop, { x: 0.05, y: 0, w: 0.75, h: 0.5 });
});

test('template side drags keep the slot fixed, preserve aspect and use space available at the source boundary', () => {
  const crop = { x: 0.2, y: 0, w: 0.4, h: 0.25 };
  const result = trimCrop({ crop, box: full }, 'e', 0.2, 0.1, source, true);
  closeRect(result.crop, { x: 0.2, y: 0, w: 0.6, h: 0.375 });
  assert.equal(result.box, full);
  const narrow = trimCrop({ crop, box: full }, 'n', 0.5, 0.125, source, true);
  closeRect(narrow.crop, { x: 0.3, y: 0.125, w: 0.2, h: 0.125 });
  assert.equal(narrow.box, full);
});

test('the smallest edge crop is one source pixel and enlarging stops at the last source pixel', () => {
  const result = trimCrop({ crop: full, box: full }, 'w', 3, 0, source);
  closeRect(result.crop, { x: 0.999, y: 0, w: 0.001, h: 1 });
  const restored = trimCrop(result, 'w', -3, 0, source);
  closeRect(restored.crop, full);
  closeRect(restored.box, full);
});

test('zoom preserves the source point at the wheel cursor and panning stops at each source boundary', () => {
  const crop = { x: 0.2, y: 0.1, w: 0.6, h: 0.5 };
  const zoomed = zoomCrop(crop, 0.5, 0.75, 0.25, source);
  closeRect(zoomed, { x: 0.425, y: 0.1625, w: 0.3, h: 0.25 });
  closeRect(zoomCrop(zoomed, 2, 0.75, 0.25, source), crop);
  closeRect(moveCrop(zoomed, -20, 20), { x: 0, y: 0.75, w: 0.3, h: 0.25 });
  closeRect(moveCrop(zoomed, 20, -20), { x: 0.7, y: 0, w: 0.3, h: 0.25 });
  closeRect(zoomCrop(full, 1e-10, 0.5, 0.5, source), { x: 0.499, y: 0.499, w: 0.002, h: 0.002 });
  closeRect(zoomCrop(full, 500, 0, 0, source), full);
});

test('reframing and zooming project the new source behind the same visible selection', () => {
  const startPlane = { x: 20, y: 50, w: 800, h: 400 };
  const startCrop = { x: 0.2, y: 0.1, w: 0.6, h: 0.5 };
  const frame = cropOnPlane(startPlane, startCrop);
  closeRect(frame, { x: 180, y: 90, w: 480, h: 200 });
  const moved = { x: 0.15, y: 0.05, w: 0.6, h: 0.5 };
  closeRect(planeForFrame(frame, moved), { x: 60, y: 70, w: 800, h: 400 });
  const zoomed = { x: 0.425, y: 0.1625, w: 0.3, h: 0.25 };
  closeRect(planeForFrame(frame, zoomed), { x: -500, y: -40, w: 1600, h: 800 });
});

test('opening shows the entire uncropped source and gives a small stored crop room for precise editing', () => {
  const viewport = { w: 820, h: 480 };
  const plane = fitCropView(full, source, viewport);
  assert.ok(plane.x >= 8 && plane.y >= 8 && plane.x + plane.w <= 812 && plane.y + plane.h <= 472);
  assert.ok(Math.abs(plane.w / plane.h - 2) < 1e-9);
  const crop = { x: 0.6, y: 0.2, w: 0.05, h: 0.06 };
  const existing = fitCropView(crop, source, viewport);
  const frame = cropOnPlane(existing, crop);
  assert.ok(frame.w > 550 && frame.h > 325, 'a small existing source region should fill most of the workspace');
  assert.ok(frame.x > 10 && frame.y > 10 && frame.x + frame.w < 810 && frame.y + frame.h < 470);
  assert.ok(Math.abs(existing.w / existing.h - 2) < 1e-9);
});

test('late source orientation preserves the chosen template focus and relative zoom on the corrected cover', () => {
  const oldCover = { x: 0.25, y: 0, w: 0.5, h: 1 };
  const newCover = { x: 0, y: 0.25, w: 1, h: 0.5 };
  const edited = { x: 0.4, y: 0.2, w: 0.25, h: 0.5 };
  closeRect(correctSlotCrop(edited, oldCover, newCover, source), { x: 0.275, y: 0.325, w: 0.5, h: 0.25 });
});

test('expanding a tight crop past the workspace keeps every handle reachable without changing source proportions', () => {
  const crop = { x: 0.4, y: 0.4, w: 0.5, h: 0.5 };
  const viewport = { w: 820, h: 480 };
  const plane = { x: -700, y: -300, w: 2000, h: 1000 };
  const adjusted = keepFrameVisible(plane, crop, viewport);
  const frame = cropOnPlane(adjusted, crop);
  assert.ok(frame.x >= 10 && frame.y >= 10 && frame.x + frame.w <= 810 && frame.y + frame.h <= 470);
  assert.ok(frame.w > 750 && Math.abs(adjusted.w / adjusted.h - 2) < 1e-9);
  const inBounds = { x: 20, y: 20, w: 700, h: 350 };
  assert.equal(keepFrameVisible(inBounds, full, viewport), inBounds);
  const nearEdge = { x: 40, y: 5, w: 778, h: 389 };
  assert.equal(keepFrameVisible(nearEdge, full, viewport), nearEdge);
});
