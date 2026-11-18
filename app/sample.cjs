const path = require('node:path');
const { randomUUID } = require('node:crypto');
const box = () => ({ x: 0, y: 0, w: 1, h: 1 });
const clip = (kind, name, start, duration, track, add) => ({
  id: randomUUID(),
  kind,
  name,
  start,
  in: 0,
  duration,
  track,
  box: box(),
  crop: box(),
  volume: 1,
  muted: false,
  ...add,
});
async function sample(ws, library, sampleDir) {
  const pl = ws.settings.language === 'pl';
  const doc = await ws.create(pl ? 'Na grani — projekt przykładowy' : 'Ridgeline — sample project', {
    width: 1920,
    height: 1080,
    fps: 30,
    format: 'mp4',
    quality: 'balanced',
  });
  const p = doc.project;
  const files = ['Ridgeline.mp4', 'Trail-detail.mp4', 'Alpine-wind.wav'];
  for (const file of files) {
    const a = await library.inspect(path.join(sampleDir, file), 'media');
    p.assets[a.id] = a;
  }
  const [first, detail, sound] = Object.values(p.assets);
  p.clips = [
    clip('media', first.name, 0, 5, 1, { assetId: first.id }),
    clip('media', detail.name, 5, 3, 1, { assetId: detail.id }),
    clip('media', sound.name, 0, 8, 0, { assetId: sound.id, volume: 0.6 }),
    clip('text', pl ? 'Tytuł otwarcia' : 'Opening title', 0, 3.5, 2, {
      text: pl ? 'Na grani' : 'Ridgeline',
      box: { x: 0.07, y: 0.58, w: 0.42, h: 0.26 },
      style: {
        font: 'Georgia',
        size: 116,
        color: '#fff8e9',
        stroke: '#27251f',
        strokeWidth: 0,
        background: 'transparent',
        bold: false,
        italic: true,
      },
    }),
  ];
  await ws.save(doc.path, p);
  return doc;
}
module.exports = { sample };
