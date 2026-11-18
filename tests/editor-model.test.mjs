import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeClip,
  makeCompound,
  cutSilence,
  splitClip,
  endTime,
  fullBox,
  trimTo,
  sceneAt,
} from '../ui/model.mjs';
import { anchoredZoom, snapTime, snapBox, cropEdge, resizeBox, timecode } from '../ui/editor-math.mjs';

const asset = (id, kind = 'video', category = 'media') => ({
  id,
  name: id,
  kind,
  category,
  path: id,
  duration: 10,
  width: 1920,
  height: 1080,
  hasAudio: kind !== 'image',
});
const project = (...assets) => ({
  schema: 1,
  id: 'p',
  width: 1920,
  height: 1080,
  fps: 30,
  assets: Object.fromEntries(assets.map((a) => [a.id, a])),
  clips: [],
});
const append = (p, a, start, track) => {
  const clip = makeClip(p, a, start, track);
  p.clips.push(clip);
  return clip;
};

test('media starts centered with its true aspect ratio in an arbitrary canvas', () => {
  const p = project();
  const slide = { ...asset('slide', 'image'), width: 1080, height: 1080, duration: 0 };
  const clip = makeClip(p, slide, 2, 1);
  assert.deepEqual(clip.box, { x: 0.21875, y: 0, w: 0.5625, h: 1 });
  assert.equal(clip.start, 2);
  assert.equal(clip.track, 1);
  assert.equal(clip.duration, 5);
  clip.crop.w = 0.6;
  assert.deepEqual(fullBox(), { x: 0, y: 0, w: 1, h: 1 });
});

test('regular recordings and sound effects stop at EOF; stills and animated effects extend', () => {
  for (const [kind, category, maxDuration] of [
    ['video', 'media', 8],
    ['audio', 'audiofx', 8],
    ['image', 'global', 40],
    ['video', 'sticker', 40],
    ['video', 'visualfx', 40],
    ['video', 'global', 8],
  ]) {
    const a = asset('a', kind, category);
    const p = project(a);
    const clip = { ...makeClip(p, a, 1, 0), in: 2, duration: 3 };
    assert.equal(trimTo(p, clip, 'end', 41).duration, maxDuration, category);
  }
});

test('left trim reveals available pre-roll while preserving source sync', () => {
  const a = asset('camera');
  const p = project(a);
  const clip = { ...makeClip(p, a, 5, 0), in: 2, duration: 4 };
  assert.deepEqual(trimTo(p, clip, 'start', 1), { start: 3, in: 0, duration: 6 });
  assert.deepEqual(trimTo(p, clip, 'start', 6), { start: 6, in: 3, duration: 3 });
  assert.ok(trimTo(p, clip, 'end', 4).duration >= 1 / p.fps - 1e-8);
});

test('extending loop left preserves the original phase when crossing its source start', () => {
  const a = asset('burst', 'video', 'visualfx');
  const p = project(a);
  const clip = { ...makeClip(p, a, 4, 0), in: 1, duration: 3 };
  const changed = { ...clip, ...trimTo(p, clip, 'start', 1) };
  p.clips.push(changed);
  assert.equal(changed.start, 1);
  assert.equal(changed.duration, 6);
  assert.equal(sceneAt(p, 4)[0].sourceTime, 1);
});

test('compounds preserve relative camera timing, source offsets, array order and mixed gain through nested splits', () => {
  const v = asset('screen'),
    c = asset('camera');
  const p = project(v, c);
  const screen = append(p, v, 5, 2);
  const camera = append(p, c, 7, 3);
  Object.assign(camera, { in: 1, duration: 5, volume: 0.6 });
  const inner = makeCompound(p, [camera.id, screen.id]);
  assert.deepEqual(
    inner.children.map((i) => [i.name, i.start]),
    [
      ['screen', 0],
      ['camera', 2],
    ],
  );
  assert.deepEqual([inner.start, inner.duration], [5, 10]);
  inner.volume = 0.5;
  const overlay = append(p, v, 5, 6);
  overlay.duration = 10;
  const outer = makeCompound(p, [inner.id, overlay.id]);
  outer.volume = 0.25;
  const right = splitClip(p, outer.id, 8);
  assert.ok(right.id !== outer.id);
  assert.deepEqual([right.start, right.in, right.duration], [8, 3, 7]);
  assert.ok(right.children !== outer.children);
  assert.notEqual(right.children[0].children[1].id, outer.children[0].children[1].id);
  const at = sceneAt(p, 9)[0].children[0].children;
  assert.deepEqual(
    at.map((i) => [i.clip.name, i.sourceTime, i.volume]),
    [
      ['screen', 4, 0.125],
      ['camera', 3, 0.075],
    ],
  );
  right.muted = true;
  assert.equal(sceneAt(p, 9)[0].children[0].children[1].volume, 0);
  assert.equal(splitClip(p, right.id, right.start), null);
  assert.equal(endTime(p), 15);
});

test('ripple uses the visible beginning of a trimmed compound and removes the same absolute time on intersecting tracks', () => {
  const a = asset('screen');
  const p = project(a);
  const a1 = append(p, a, 2, 0);
  const a2 = append(p, a, 3, 1);
  const group = makeCompound(p, [a1.id, a2.id]);
  Object.assign(group, { start: 5, in: 2, duration: 7 });
  const bed = append(p, a, 0, 2);
  bed.duration = 10;
  const tail = append(p, a, 14, 0);
  tail.duration = 2;
  const pieces = cutSilence(p, group.id, [
    { start: 5, end: 9 },
    { start: 2, end: 4 },
    { start: 1, end: 3 },
  ]);
  assert.deepEqual(
    pieces.map((c) => [c.start, c.in, c.duration]),
    [
      [5, 2, 1],
      [6, 6, 1],
    ],
  );
  assert.equal(pieces[0].id, group.id);
  assert.deepEqual(
    p.clips.filter((c) => c.assetId === a.id && c.track === 2).map((c) => [c.start, c.in, c.duration]),
    [
      [0, 0, 6],
      [6, 9, 1],
    ],
  );
  assert.equal(p.clips.find((c) => c.id === tail.id).start, 9);
  assert.equal(sceneAt(p, 6.5).find((n) => n.clip.kind === 'compound').children[1].sourceTime, 5.5);
});

test('full silence deletes the clip; invalid intervals have no side effects', () => {
  const a = asset('sound', 'audio');
  const p = project(a);
  const c = append(p, a, 3, 0);
  const following = append(p, a, 14, 0);
  cutSilence(p, c.id, [
    { start: 7, end: 5 },
    { start: 99, end: 102 },
  ]);
  assert.deepEqual(
    p.clips.map((i) => i.start),
    [3, 14],
  );
  cutSilence(p, c.id, [{ start: -8, end: 35 }]);
  assert.deepEqual(
    p.clips.map((i) => [i.id, i.start]),
    [[following.id, 4]],
  );
});

test('looping picture and captions both use the local visible source time, and layers stack stably', () => {
  const a = asset('sticker', 'video', 'sticker');
  const p = project(a);
  const sticker = append(p, a, 2, 0);
  Object.assign(sticker, { in: 9, duration: 12 });
  p.clips.push({
    id: 'words',
    kind: 'caption',
    start: 0,
    in: 1,
    duration: 8,
    track: 0,
    cues: [
      { start: 0, end: 2, text: 'pierwsze' },
      { start: 4, end: 5, text: 'drugie' },
    ],
  });
  const four = sceneAt(p, 3);
  assert.deepEqual(
    four.map((n) => n.clip.id),
    [sticker.id, 'words'],
  );
  assert.equal(four[0].sourceTime, 0);
  assert.equal(four[1].text, 'drugie');
  assert.equal(sceneAt(p, 4).find((n) => n.clip.id === 'words').text, '');
});

test('older projects with an overlong regular clip show the underlying picture after source EOF', () => {
  const a = asset('still', 'image'),
    b = asset('video');
  const p = project(a, b);
  const still = append(p, a, 0, 0),
    movie = append(p, b, 0, 1);
  still.duration = 10;
  movie.in = 8;
  movie.duration = 8;
  assert.deepEqual(
    sceneAt(p, 1.8).map((n) => n.clip.id),
    [still.id, movie.id],
  );
  assert.deepEqual(
    sceneAt(p, 2).map((n) => n.clip.id),
    [still.id],
  );
});

test('zoom keeps the same second beneath the mouse across inverse changes', () => {
  const left = anchoredZoom(75, 144, 426, 319);
  assert.equal((left + 319) / 144, (426 + 319) / 75);
  assert.ok(Math.abs(anchoredZoom(144, 75, left, 319) - 426) < 1e-8);
  assert.equal(anchoredZoom(100, 10, 80, 300), 0);
});

test('timeline magnets can align the far edge of a group and respect tolerance and toggle', () => {
  assert.deepEqual(snapTime([2.03, 5.03], [0, 5.1], 0.1, true), { delta: 0.07, guide: 5.1 });
  assert.deepEqual(snapTime([2.03, 5.03], [0, 5.1], 0.1, false), { delta: 0, guide: null });
  assert.deepEqual(snapTime([2.03], [2.5], 0.1, true), { delta: 0, guide: null });
});

test('scene magnets align to neighboring edges and canvas center while preserving size', () => {
  const box = { x: 0.295, y: 0.399, w: 0.4, h: 0.3 };
  const neighbor = { x: 0.15, y: 0.2, w: 0.15, h: 0.2 };
  const result = snapBox(box, [neighbor], 0.01, 0.01, true);
  assert.ok(Math.abs(result.box.x - 0.3) < 1e-8 && Math.abs(result.box.y - 0.4) < 1e-8);
  assert.equal(result.box.w, 0.4);
  assert.deepEqual(snapBox(box, [neighbor], 0.01, 0.01, false).box, box);
});

test('trimming picture crop adjusts the destination by the same proportion and bounds it to the source', () => {
  const clip = { box: { x: 0.2, y: 0.2, w: 0.6, h: 0.5 }, crop: fullBox() };
  const trimmed = cropEdge(clip, 'w', 0.15, 0);
  assert.ok(Math.abs(trimmed.crop.x - 0.25) < 1e-8 && Math.abs(trimmed.box.x - 0.35) < 1e-8);
  assert.ok(Math.abs(trimmed.crop.w - 0.75) < 1e-8 && Math.abs(trimmed.box.w - 0.45) < 1e-8);
  assert.deepEqual(cropEdge(clip, 'e', 0.5, 0), clip);
  const resize = resizeBox(clip.box, 'se', 0.3, 0.1, true);
  assert.ok(Math.abs(resize.w / resize.h - 1.2) < 1e-8);
});

test('timecode carries rounded frames into the next minute', () => {
  assert.equal(timecode(59.999, 25), '00:01:00:00');
  assert.equal(timecode(3601.12, 25), '01:00:01:03');
});
