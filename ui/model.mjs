// Editing decisions are expressed in seconds. Source files are never changed.
const EPS = 1e-8;
const tidy = (value) => Math.round(value * 1e9) / 1e9;
const limit = (value, low, high) => Math.max(low, Math.min(high, value));
const finish = (clip) => clip.start + clip.duration;
const freshId = () => crypto.randomUUID();

export const fullBox = () => ({ x: 0, y: 0, w: 1, h: 1 });
export const endTime = ({ clips = [] }) => clips.reduce((end, clip) => Math.max(end, finish(clip)), 0);

/** True for time-based visual effects that can repeat beyond their original duration. */
export const loops = (asset) =>
  asset?.kind === 'video' && ['visualfx', 'sticker'].includes(asset.category);

/** Whether a timeline item has a visual surface for direct manipulation. */
export function isVisual(project, clip) {
  if (clip.kind === 'media')
    return Boolean(project.assets[clip.assetId] && project.assets[clip.assetId].kind !== 'audio');
  if (clip.kind === 'compound') return clip.children.some((child) => isVisual(project, child));
  return true;
}

/** Whether a clip or any descendant supplies audio. */
export function hasSound(project, clip) {
  if (clip.kind === 'compound') return clip.children.some((child) => hasSound(project, child));
  const asset = project.assets[clip.assetId];
  return Boolean(asset && (asset.kind === 'audio' || asset.hasAudio));
}

export function makeClip(project, asset, start = 0, track = 0) {
  const box = fullBox();
  if (asset.kind !== 'audio' && asset.width > 0 && asset.height > 0) {
    const ratio = asset.width / asset.height / (project.width / project.height);
    box.w = Math.min(1, ratio);
    box.h = Math.min(1, 1 / ratio);
    box.x = (1 - box.w) / 2;
    box.y = (1 - box.h) / 2;
  }
  return {
    id: freshId(),
    name: asset.name,
    kind: 'media',
    assetId: asset.id,
    start: Math.max(0, start),
    in: 0,
    duration: asset.kind === 'image' ? 5 : asset.duration || 1 / (project.fps || 30),
    track: Math.max(0, Math.round(track)),
    box,
    crop: fullBox(),
    volume: 1,
    muted: false,
  };
}

export function makeCompound(project, ids) {
  const selected = new Set(ids);
  const children = project.clips.filter((clip) => selected.has(clip.id));
  if (children.length < 2) return null;
  const start = Math.min(...children.map((c) => c.start));
  const track = Math.min(...children.map((c) => c.track));
  const compound = {
    id: freshId(),
    name: children
      .map((c) => c.name)
      .join(' + ')
      .slice(0, 150),
    kind: 'compound',
    start,
    in: 0,
    duration: tidy(endTime({ clips: children }) - start),
    track,
    box: fullBox(),
    crop: fullBox(),
    volume: 1,
    muted: false,
    children: children.map((child) => ({
      ...child,
      start: tidy(child.start - start),
      track: child.track - track,
    })),
  };
  const first = project.clips.indexOf(children[0]);
  project.clips = project.clips.filter((clip) => !selected.has(clip.id));
  project.clips.splice(first, 0, compound);
  return compound;
}

function duplicate(clip) {
  const copy = structuredClone(clip);
  const renew = (item) => {
    item.id = freshId();
    item.children?.forEach(renew);
  };
  renew(copy);
  return copy;
}

export function splitClip(project, id, time) {
  const index = project.clips.findIndex((c) => c.id === id);
  const clip = project.clips[index];
  if (!clip || !Number.isFinite(time) || time <= clip.start + EPS || time >= finish(clip) - EPS)
    return null;
  const leftDuration = tidy(time - clip.start);
  const right = duplicate(clip);
  Object.assign(right, {
    start: time,
    in: tidy(clip.in + leftDuration),
    duration: tidy(clip.duration - leftDuration),
  });
  clip.duration = leftDuration;
  project.clips.splice(index + 1, 0, right);
  return right;
}

function normalizedSilence(ranges, clip) {
  const intervals = [];
  const ordered = (ranges || [])
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => [clip.start + Math.max(0, r.start), clip.start + Math.min(clip.duration, r.end)])
    .filter(([a, b]) => b - a > EPS)
    .sort((a, b) => a[0] - b[0]);
  for (const pair of ordered) {
    const tail = intervals.at(-1);
    if (tail && pair[0] <= tail[1] + EPS) tail[1] = Math.max(tail[1], pair[1]);
    else intervals.push(pair);
  }
  return intervals;
}

// A global ripple keeps overlays, external sound and subsequent shots in sync.
// Subtract absolute silent intervals, changing only a surviving fragment's
// outer start, source offset and duration; child timing stays local.
export function cutSilence(project, id, ranges) {
  const target = project.clips.find((c) => c.id === id);
  if (!target) return [];
  const cuts = normalizedSilence(ranges, target);
  if (!cuts.length) return [target];
  const result = [];
  const targetPieces = [];
  for (const clip of project.clips) {
    let cursor = clip.start;
    const last = finish(clip);
    let removed = 0;
    let first = true;
    const take = (from, to) => {
      if (to - from < EPS) return;
      const part = first ? { ...clip } : duplicate(clip);
      first = false;
      Object.assign(part, {
        start: tidy(from - removed),
        in: tidy(clip.in + from - clip.start),
        duration: tidy(to - from),
      });
      result.push(part);
      if (id === clip.id) targetPieces.push(part);
    };
    for (const [a, b] of cuts) {
      if (a >= last - EPS) break;
      take(cursor, Math.min(a, last));
      removed += b - a;
      cursor = Math.max(cursor, b);
    }
    take(cursor, last);
  }
  project.clips = result;
  return targetPieces;
}

/** Calculate start/in/duration for an edge drag, constrained by available source. */
export function trimTo(project, clip, edge, time) {
  const asset = project.assets[clip.assetId];
  const loop = loops(asset);
  const unlimited = clip.kind === 'text' || asset?.kind === 'image' || loop;
  let sourceDuration = Infinity;
  if (clip.kind === 'compound') sourceDuration = endTime({ clips: clip.children });
  else if (clip.kind === 'media' && !unlimited && asset?.duration > 0) sourceDuration = asset.duration;
  const frame = Math.min(clip.duration, 1 / (project.fps || 30));
  if (edge === 'end') {
    const maximum = Math.max(frame, sourceDuration - clip.in);
    return { start: clip.start, in: clip.in, duration: tidy(limit(time - clip.start, frame, maximum)) };
  }
  const earliest = unlimited ? 0 : Math.max(0, clip.start - clip.in);
  const start = limit(time, earliest, finish(clip) - frame);
  let offset = clip.in + start - clip.start;
  if (loop && offset < 0 && asset.duration > 0)
    offset = ((offset % asset.duration) + asset.duration) % asset.duration;
  return { start: tidy(start), in: tidy(Math.max(0, offset)), duration: tidy(finish(clip) - start) };
}

/** Active compositing tree, in paint order, with source time and absolute linear gain. */
export function sceneAt(project, time) {
  function sample(clips, t, parentGain) {
    return clips
      .filter((clip) => {
        if (t < clip.start || t >= finish(clip)) return false;
        const asset = project.assets[clip.assetId];
        return (
          !asset ||
          asset.kind === 'image' ||
          loops(asset) ||
          !(asset.duration > 0) ||
          clip.in + t - clip.start < asset.duration
        );
      })
      .sort((a, b) => a.track - b.track)
      .map((clip) => {
        const asset = project.assets[clip.assetId];
        let sourceTime = clip.in + t - clip.start;
        if (loops(asset) && asset.duration > 0) sourceTime %= asset.duration;
        const volume = clip.muted ? 0 : parentGain * (clip.volume ?? 1);
        const node = { clip, asset, sourceTime, volume };
        if (clip.kind === 'compound') node.children = sample(clip.children, sourceTime, volume);
        if (clip.kind === 'text') node.text = clip.text || '';
        if (clip.kind === 'caption') {
          node.text =
            clip.cues?.find((cue) => sourceTime >= cue.start && sourceTime < cue.end)?.text || '';
        }
        return node;
      });
  }
  return sample(project.clips, time, 1);
}
