const full = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });
function number(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function between(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
function coord(rect) {
  return { x: number(rect?.x), y: number(rect?.y), w: number(rect?.w, 1), h: number(rect?.h, 1) };
}
function intersection(a, b) {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x,
    h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
function rootBox(parent, child) {
  return {
    x: parent.x + child.x * parent.w,
    y: parent.y + child.y * parent.h,
    w: parent.w * child.w,
    h: parent.h * child.h,
  };
}
function sourceRect(visible, placed, crop) {
  return {
    x: crop.x + ((visible.x - placed.x) * crop.w) / placed.w,
    y: crop.y + ((visible.y - placed.y) * crop.h) / placed.h,
    w: (visible.w * crop.w) / placed.w,
    h: (visible.h * crop.h) / placed.h,
  };
}
function projectDuration(project) {
  return (project.clips || []).reduce(
    (end, clip) => Math.max(end, number(clip.start) + Math.max(0, number(clip.duration))),
    0,
  );
}

// Intersect time and picture bounds at each compound. Flattened child leaves keep
// their position within the group's track ordering and inherit all ancestor gains.
function timeline(project, { audioOnly = false, from = 0, until = projectDuration(project) } = {}) {
  const result = [];
  function visit(clips, context) {
    const ordered = (clips || []).slice().sort((a, b) => number(a.track) - number(b.track));
    for (const clip of ordered) {
      const start = number(clip.start);
      const local = Math.max(context.from, start);
      const end = Math.min(context.until, start + number(clip.duration));
      if (end - local < 1e-8) continue;
      const sourceTime = Math.max(0, number(clip.in)) + local - start;
      const outputTime = context.outputTime + local - context.from;
      const volume = clip.muted ? 0 : context.volume * Math.max(0, number(clip.volume, 1));
      const localBox = coord(clip.box),
        placed = rootBox(context.transform, localBox);
      const crop = intersection(coord(clip.crop), full);
      const visible = !audioOnly && context.visible && crop && intersection(context.visible, placed);
      if (clip.kind === 'compound') {
        const transform = visible
          ? {
              x: placed.x - (crop.x * placed.w) / crop.w,
              y: placed.y - (crop.y * placed.h) / crop.h,
              w: placed.w / crop.w,
              h: placed.h / crop.h,
            }
          : full;
        visit(clip.children, {
          from: sourceTime,
          until: sourceTime + end - local,
          outputTime,
          transform,
          visible,
          volume,
        });
        continue;
      }
      if (clip.kind !== 'media' && !visible) continue;
      const asset = clip.kind === 'media' ? project.assets?.[clip.assetId] : null;
      if (clip.kind === 'media' && !asset)
        throw new Error('Missing media asset: ' + (clip.name || clip.assetId));
      const canLoop = asset?.kind === 'video' && ['sticker', 'visualfx'].includes(asset.category);
      const duration =
        !asset || asset.kind === 'image' || canLoop || !(asset.duration > 0)
          ? end - local
          : Math.min(end - local, asset.duration - sourceTime);
      if (duration <= 0) continue;
      const picture =
        visible && (!asset || asset.kind !== 'audio')
          ? { box: visible, crop: sourceRect(visible, placed, crop), localBox }
          : null;
      const audio = !!asset && volume > 0 && (asset.hasAudio || asset.kind === 'audio');
      if (!picture && !audio) continue;
      result.push({
        clip,
        asset,
        picture,
        audio,
        volume,
        start: outputTime,
        duration,
        sourceTime,
        loop: canLoop,
      });
    }
  }
  visit(project.clips, {
    from,
    until,
    outputTime: 0,
    transform: full,
    visible: !audioOnly && full,
    volume: 1,
  });
  return result;
}

// Keep decoder counts and Windows CreateProcess command lines bounded. Split
// sequential edits on frame/sample boundaries; simultaneous layers are grouped
// separately while preserving their back-to-front order.
function batches(leaves) {
  const groups = [];
  let group = [],
    characters = 0;
  for (const leaf of leaves) {
    const inputSize = 140 + 2 * (leaf.asset?.path?.length || 0);
    if (group.length && (group.length >= 32 || characters + inputSize > 24000)) {
      groups.push(group);
      group = [];
      characters = 0;
    }
    group.push(leaf);
    characters += inputSize;
  }
  groups.push(group);
  return groups;
}
function processingRanges(project, audioOnly) {
  const hz = audioOnly ? 48000 : number(project.fps, 30),
    duration = projectDuration(project);
  const ranges = [];
  function divide(leaves, from, until) {
    if (batches(leaves).length > 1) {
      const points = new Set();
      for (const leaf of leaves) {
        for (const t of [leaf.start, leaf.start + leaf.duration]) {
          const frame = Math.round(t * hz) / hz;
          if (frame > from + 1e-8 && frame < until - 1e-8) points.add(frame);
        }
      }
      if (points.size) {
        const sorted = [...points].sort((a, b) => a - b);
        const middle = sorted[Math.floor(sorted.length / 2)];
        divide(
          leaves.filter((leaf) => leaf.start < middle - 1e-8),
          from,
          middle,
        );
        divide(
          leaves.filter((leaf) => leaf.start + leaf.duration > middle + 1e-8),
          middle,
          until,
        );
        return;
      }
    }
    ranges.push({ from, until });
  }
  divide(timeline(project, { audioOnly }), 0, duration);
  return ranges;
}

module.exports = { number, between, projectDuration, timeline, batches, processingRanges };
