const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const defaultCaptionBox = () => ({ x: 0.08, y: 0.69, w: 0.84, h: 0.22 });
export function reframeBox(box, oldWidth, oldHeight, width, height) {
  const aspect = (((oldWidth * box.w) / (oldHeight * box.h)) * height) / width;
  const scale = Math.max(box.w, box.h);
  const w = aspect >= 1 ? scale : scale * aspect,
    h = aspect >= 1 ? scale / aspect : scale;
  const ax = box.w < 1 ? box.x / (1 - box.w) : 0.5,
    ay = box.h < 1 ? box.y / (1 - box.h) : 0.5;
  return { x: ax * (1 - w), y: ay * (1 - h), w, h };
}
export function coverCrop(sw, sh, dw, dh, focusX = 0.5, focusY = 0.5) {
  const source = sw / Math.max(1, sh),
    target = dw / Math.max(1, dh);
  const w = Math.min(1, target / source),
    h = Math.min(1, source / target);
  return { x: (1 - w) * clamp(focusX, 0, 1), y: (1 - h) * clamp(focusY, 0, 1), w, h };
}
export const presets = ['classic', 'impact', 'neon', 'label'];
export function stylePreset(name, height) {
  const base = {
    font: 'Arial',
    size: Math.round(height * 0.058),
    bold: true,
    italic: false,
    color: '#ffffff',
    stroke: '#101214',
    strokeWidth: Math.max(2, Math.round(height * 0.0045)),
    background: 'transparent',
  };
  if (name === 'impact')
    return { ...base, font: 'Impact', color: '#ffe52b', strokeWidth: Math.round(height * 0.006) };
  if (name === 'neon') return { ...base, color: '#62ffd9', stroke: '#341744' };
  if (name === 'label') return { ...base, color: '#17191d', background: '#ffffff', strokeWidth: 0 };
  return base;
}
function splitWideWord(word, width, size, measure, style) {
  const result = [];
  let part = '';
  for (const ch of word) {
    if (part && measure(part + ch, size, style) > width) {
      result.push(part);
      part = '';
    }
    part += ch;
  }
  if (part) result.push(part);
  return result;
}
export function fitCues(segments, box, project, style, measure, { auto = false } = {}) {
  const width = Math.max(1, box.w * project.width * 0.94 - 2 * (style.strokeWidth || 0));
  const height = Math.max(1, box.h * project.height * 0.92 - 2 * (style.strokeWidth || 0));
  const usable = segments
    .map((s) => ({ ...s, text: String(s.text || '').trim() }))
    .filter((s) => s.text && s.end > s.start);
  const words = [...new Set(usable.flatMap((s) => s.text.split(/\s+/)))];
  const singleLineSize = Math.max(1, Math.floor(height / 1.23));
  const useTwoLines = auto && usable.some((s) => measure(s.text, singleLineSize, style) > width);
  const wanted = auto
    ? Math.max(1, Math.floor(singleLineSize / (useTwoLines ? 2 : 1)))
    : Math.max(1, Math.floor(style.size || project.height * 0.058));
  const floor = Math.min(wanted, Math.max(12, Math.round(project.height * 0.036)));
  const widest = words.reduce((max, w) => Math.max(max, measure(w, 100, style)), 1);
  const size = Math.max(
    1,
    Math.min(wanted, singleLineSize, Math.max(floor, Math.floor((width * 100) / widest))),
  );
  const lineLimit = clamp(Math.floor(height / (size * 1.23)), 1, 2);
  const cues = [];
  for (const seg of usable) {
    const words = seg.text
      .split(/\s+/)
      .flatMap((w) =>
        measure(w, size, style) <= width ? [w] : splitWideWord(w, width, size, measure, style),
      );
    const chunks = [];
    let lines = [],
      line = '';
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word;
      if (line && measure(candidate, size, style) > width) {
        lines.push(line);
        line = '';
        if (lines.length === lineLimit) {
          chunks.push(lines.join('\n'));
          lines = [];
        }
      }
      line = line ? line + ' ' + word : word;
    }
    if (line) lines.push(line);
    if (lines.length) chunks.push(lines.join('\n'));
    const units = chunks.map((c) => [...c.replace(/\s/g, '')].length);
    const total = units.reduce((a, b) => a + b, 0);
    let used = 0,
      start = seg.start;
    chunks.forEach((text, i) => {
      used += units[i];
      const end = i === chunks.length - 1 ? seg.end : seg.start + ((seg.end - seg.start) * used) / total;
      cues.push({ start, end, text });
      start = end;
    });
  }
  return { style: { ...style, size }, cues };
}
export function fitTitle(text, box, project, style, measure = measureText) {
  let lo = 1,
    hi = Math.max(1, Math.round(style.size)),
    best = { style: { ...style, size: 1 }, text };
  while (lo <= hi) {
    const size = Math.floor((lo + hi) / 2),
      lines = [],
      width = box.w * project.width * 0.97,
      height = box.h * project.height * 0.97;
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        if (line && measure(line + ' ' + word, size, style) > width) {
          lines.push(line);
          line = word;
        } else line = line ? line + ' ' + word : word;
      }
      lines.push(line);
    }
    if (lines.length * size * 1.23 <= height && lines.every((l) => measure(l, size, style) <= width)) {
      best = { style: { ...style, size }, text: lines.join('\n') };
      lo = size + 1;
    } else hi = size - 1;
  }
  return best;
}
export function measureText(text, size, style) {
  measureText.canvas ??= document.createElement('canvas');
  const ctx = measureText.canvas.getContext('2d');
  ctx.font =
    (style.italic ? 'italic ' : '') +
    (style.bold ? 'bold ' : '') +
    size +
    'px "' +
    style.font.replace(/["\\]/g, '') +
    '"';
  return ctx.measureText(text).width;
}
function timecode(seconds, vtt) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const parts = [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60];
  return (
    parts.map((n) => String(n).padStart(2, '0')).join(':') +
    (vtt ? '.' : ',') +
    String(ms % 1000).padStart(3, '0')
  );
}
export function subtitleText(cues, format = 'srt') {
  const vtt = format === 'vtt';
  return (
    (vtt ? 'WEBVTT\n\n' : '') +
    cues
      .map(
        (c, i) =>
          (vtt ? '' : i + 1 + '\n') +
          timecode(c.start, vtt) +
          ' --> ' +
          timecode(c.end, vtt) +
          '\n' +
          c.text.trim() +
          '\n',
      )
      .join('\n')
  );
}
export function projectCues(project) {
  const found = [];
  const walk = (clips, offset, lo, hi) => {
    for (const c of clips) {
      const start = Math.max(lo, offset + c.start),
        end = Math.min(hi, offset + c.start + c.duration);
      const origin = offset + c.start - c.in;
      if (start >= end) continue;
      if (c.kind === 'compound') walk(c.children, origin, start, end);
      if (c.kind === 'caption')
        for (const cue of c.cues) {
          const a = Math.max(start, origin + cue.start),
            b = Math.min(end, origin + cue.end);
          if (b > a) found.push({ start: a, end: b, text: cue.text });
        }
    }
  };
  walk(project.clips, 0, 0, Infinity);
  return found.sort((a, b) => a.start - b.start);
}
export function visibleCues(clip) {
  return clip.cues
    .map((c) => ({
      start: Math.max(0, c.start - clip.in),
      end: Math.min(clip.duration, c.end - clip.in),
      text: c.text,
    }))
    .filter((c) => c.end > c.start);
}
export function replaceVisibleCues(clip, edited) {
  const duration = Math.max(clip.duration, ...edited.map((c) => c.end));
  const start = clip.in,
    end = start + duration;
  const all = [];
  for (const c of clip.cues) {
    if (c.start < start) all.push({ ...c, end: Math.min(start, c.end) });
    if (c.end > end) all.push({ ...c, start: Math.max(end, c.start) });
  }
  for (const c of edited) all.push({ ...c, start: c.start + start, end: c.end + start });
  return { cues: all.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start), duration };
}
export function templateFrom(project, name, selection = []) {
  const chosen = selection.length ? project.clips.filter((c) => selection.includes(c.id)) : project.clips;
  const slots = [],
    seen = new Set(),
    lanes = new Map(),
    full = { x: 0, y: 0, w: 1, h: 1 };
  function visit(clips, parent, visible, lineage, from, until) {
    for (const c of [...clips].sort((a, b) => a.track - b.track || (a.start || 0) - (b.start || 0))) {
      const start = c.start || 0,
        lo = Math.max(start, from),
        hi = Math.min(start + (c.duration ?? Infinity), until);
      if (hi <= lo || (c.kind === 'media' && project.assets?.[c.assetId]?.kind === 'audio')) continue;
      const b = c.box || full,
        placed = {
          x: parent.x + b.x * parent.w,
          y: parent.y + b.y * parent.h,
          w: b.w * parent.w,
          h: b.h * parent.h,
        };
      const x = Math.max(placed.x, visible.x),
        y = Math.max(placed.y, visible.y);
      const box = {
        x,
        y,
        w: Math.min(placed.x + placed.w, visible.x + visible.w) - x,
        h: Math.min(placed.y + placed.h, visible.y + visible.h) - y,
      };
      if (box.w <= 0 || box.h <= 0) continue;
      const trackPath = lineage.concat(c.track).join('/');
      if (c.kind === 'compound') {
        const crop = c.crop || full;
        const child = { w: placed.w / crop.w, h: placed.h / crop.h };
        child.x = placed.x - crop.x * child.w;
        child.y = placed.y - crop.y * child.h;
        visit(
          c.children,
          child,
          box,
          lineage.concat(c.track),
          (c.in || 0) + lo - start,
          (c.in || 0) + hi - start,
        );
        continue;
      }
      const kind = c.kind === 'text' ? 'text' : c.kind === 'caption' ? 'caption' : 'media';
      const key = [trackPath, kind, ...Object.values(box).map((v) => v.toFixed(6))].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      if (!lanes.has(trackPath)) lanes.set(trackPath, lanes.size);
      const style = c.style
        ? { ...c.style, size: Math.max(1, Math.round(c.style.size * parent.h)) }
        : undefined;
      slots.push({
        kind,
        name: c.name,
        track: lanes.get(trackPath),
        box,
        style,
        text: kind === 'text' ? c.text : undefined,
      });
    }
  }
  visit(chosen, full, full, [], 0, Infinity);
  return { id: crypto.randomUUID(), name, width: project.width, height: project.height, slots };
}
