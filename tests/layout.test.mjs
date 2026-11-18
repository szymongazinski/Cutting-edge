import test from 'node:test';
import assert from 'node:assert/strict';
import * as layout from '../ui/layout.mjs';
const { coverCrop, fitCues, subtitleText, templateFrom, stylePreset } = layout;
test('returning to the original aspect ratio restores media size and placement', () => {
  const frame = { x: 0, y: 0, w: 1, h: 1 };
  const portrait = layout.reframeBox(frame, 1920, 1080, 1080, 1920);
  const back = layout.reframeBox(portrait, 1080, 1920, 1920, 1080);
  assert.deepEqual(back, frame);
  const pip = { x: 0.01, y: 0.63, w: 0.35, h: 0.3 };
  const p = layout.reframeBox(pip, 1920, 1080, 1080, 1920);
  const restored = layout.reframeBox(p, 1080, 1920, 1920, 1080);
  for (const prop of Object.keys(pip)) assert.ok(Math.abs(pip[prop] - restored[prop]) < 1e-7);
});
test('portrait template slot retains a chosen point in a widescreen replacement', () => {
  const crop = coverCrop(1920, 1080, 360, 640, 1, 0.5);
  assert.ok(Math.abs(((crop.w / crop.h) * 1920) / 1080 - 360 / 640) < 1e-6);
  assert.equal(crop.x + crop.w, 1);
});
test('long captions split into timed readable chunks with one shared point size', () => {
  const box = { x: 0, y: 0, w: 0.38, h: 0.18 };
  const segs = [
    {
      start: 1,
      end: 7,
      text: 'Czasem najlepsza droga prowadzi przez zupełnie inne niespodziewane miejsca w górach.',
    },
  ];
  const fit = fitCues(
    segs,
    box,
    { width: 1280, height: 720 },
    stylePreset('classic', 720),
    (s, size) => [...s].length * size * 0.56,
  );
  assert.ok(fit.cues.length > 1);
  assert.ok(fit.style.size >= 24);
  assert.equal(fit.cues[0].start, 1);
  assert.equal(fit.cues.at(-1).end, 7);
  assert.ok(
    fit.cues.every((c) =>
      c.text.split('\n').every((l) => l.length * fit.style.size * 0.56 <= 1280 * 0.38),
    ),
  );
  assert.match(subtitleText(fit.cues, 'srt'), /00:00:01,000/);
  assert.match(subtitleText(fit.cues, 'vtt'), /^WEBVTT/);
});
test('templates store slots and typography independently from the source files', () => {
  const proj = {
    width: 1920,
    height: 1080,
    clips: [
      {
        id: 'a',
        kind: 'media',
        name: 'Screen',
        assetId: 'private',
        track: 3,
        box: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      },
    ],
  };
  const tpl = templateFrom(proj, 'Layout');
  assert.equal(tpl.slots.length, 1);
  assert.equal(tpl.slots[0].box.w, 0.8);
  assert.ok(!JSON.stringify(tpl).includes('private'));
});
test('automatic caption sizing makes short lines larger in a taller frame, consistently across cues', () => {
  const cues = [
      { start: 0, end: 1, text: 'Hej' },
      { start: 1, end: 2, text: 'Tak' },
    ],
    project = { width: 1920, height: 1080 };
  const measure = (s, size) => [...s].length * size * 0.57,
    base = stylePreset('classic', 1080);
  const fit = (h) => fitCues(cues, { x: 0, y: 0, w: 0.8, h }, project, base, measure, { auto: true });
  assert.ok(fit(0.28).style.size > fit(0.12).style.size * 1.8);
  assert.equal(fit(0.28).cues.length, 2);
});
test('compound capture exposes separate screen, camera and caption slots in compositing order', () => {
  const full = { x: 0, y: 0, w: 1, h: 1 },
    p = {
      width: 1920,
      height: 1080,
      assets: { sound: { kind: 'audio' } },
      clips: [
        {
          id: 'group',
          kind: 'compound',
          name: 'Screen and camera',
          box: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
          track: 0,
          children: [
            { kind: 'media', name: 'Camera', track: 2, box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
            { kind: 'media', name: 'Voice', track: 1, box: full, assetId: 'sound' },
            { kind: 'media', name: 'Screen', track: 0, box: full },
            { kind: 'caption', name: 'Speech', track: 3, box: { x: 0, y: 0.8, w: 1, h: 0.2 } },
          ],
        },
      ],
    };
  const result = layout.templateFrom(p, 'Combined');
  assert.deepEqual(
    result.slots.map((s) => s.name),
    ['Screen', 'Camera', 'Speech'],
  );
  assert.ok(Math.abs(result.slots[1].box.w - 0.4) < 1e-7);
  assert.equal(result.slots[1].box.x, 0.5);
});
