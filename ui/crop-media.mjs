import { el, mediaUrl } from './dom.mjs';
import { gifPlayer } from './editor-gif.mjs';
import { t } from './session.mjs';

export function createCropMedia(asset, sourceTime = 0, { assetUrl = mediaUrl, translate = t, onDimensions } = {}) {
  const element = el('div', { class: 'crop-media' });
  const status = el('span', { class: 'crop-media-status', role: 'status', hidden: true });
  element.append(status);
  const time = asset.kind === 'image' || !Number.isFinite(sourceTime) ? 0 : Math.max(0, sourceTime);
  const candidates = [];
  function nativeType(file, codec) {
    if (asset.kind === 'image') return 'image';
    return codec === 'gif' || /\.gif(?:$|[?#])/i.test(file) ? 'gif' : 'video';
  }
  if (asset.path) {
    const type = nativeType(asset.path, asset.videoCodec);
    // The library creates streaming proxies for large GIFs. Decode just the
    // requested original frame instead of loading that entire animation in RAM.
    if (type !== 'gif' || !asset.previewPath) candidates.push({ type, file: asset.path });
    candidates.push({ type: 'frame', file: asset.path });
  }
  if (asset.previewPath && asset.previewPath !== asset.path) {
    candidates.push({
      type: nativeType(asset.previewPath), file: asset.previewPath,
      message: translate('Podgląd z kopii pliku', 'Showing a preview copy'),
    });
  }
  if (asset.thumbnail && asset.thumbnail !== asset.previewPath && asset.thumbnail !== asset.path) {
    candidates.push({
      type: 'image', file: asset.thumbnail,
      message: translate('Dostępna jest tylko miniatura źródła', 'Only the source thumbnail is available'),
    });
  }
  let closed = false, release = () => {};

  function message(text = '') {
    status.textContent = text;
    status.hidden = !text;
  }
  function next() {
    if (closed) return;
    release();
    const candidate = candidates.shift();
    if (!candidate) {
      message(translate('Nie udało się wczytać źródła', 'Source preview unavailable'));
      return;
    }
    const events = new AbortController();
    const { signal } = events;
    let media, gif, blobUrl;
    release = () => {
      if (signal.aborted) return;
      events.abort();
      gif?.destroy();
      if (media instanceof HTMLVideoElement) {
        media.pause();
        media.removeAttribute('src');
        media.load();
      } else if (media instanceof HTMLImageElement) media.removeAttribute('src');
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      media?.remove();
    };
    const failed = () => {
      if (!signal.aborted) next();
    };
    function reportSize(width, height) {
      if (candidate.file === asset.path) onDimensions?.(width, height);
    }
    function showImage(url) {
      media = el('img', { alt: asset.name || '' });
      media.draggable = false;
      media.addEventListener('error', failed, { once: true, signal });
      media.addEventListener('load', () => {
        message(candidate.message);
        reportSize(media.naturalWidth, media.naturalHeight);
      }, { once: true, signal });
      element.prepend(media);
      media.src = url;
    }
    const url = assetUrl(candidate.file);
    message(candidate.message);
    if (candidate.type === 'image') {
      showImage(url);
    } else if (candidate.type === 'gif') {
      media = el('canvas', { role: 'img', 'aria-label': asset.name || '' });
      element.prepend(media);
      gif = gifPlayer(media, url, failed, reportSize);
      gif.seek(time);
    } else if (candidate.type === 'video') {
      media = el('video', { preload: 'auto', muted: true, playsInline: true, disablePictureInPicture: true });
      media.addEventListener('error', failed, { once: true, signal });
      media.addEventListener('loadedmetadata', () => {
        // Chromium can open just the audio stream of an unsupported movie.
        if (!media.videoWidth || !media.videoHeight) return failed();
        reportSize(media.videoWidth, media.videoHeight);
        const last = Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.000001) : time;
        try {
          media.currentTime = Math.min(time, last);
        } catch {
          failed();
        }
      }, { once: true, signal });
      element.prepend(media);
      media.src = url;
    } else {
      const frameUrl = new URL(url, document.baseURI);
      frameUrl.searchParams.set('frame', String(time));
      message(translate('Wczytywanie klatki…', 'Loading frame…'));
      fetch(frameUrl, { signal })
        .then((response) => {
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png'))
            throw Error('Frame unavailable');
          return response.blob();
        })
        .then((blob) => {
          if (signal.aborted) return;
          blobUrl = URL.createObjectURL(blob);
          showImage(blobUrl);
        })
        .catch(failed);
    }
  }
  next();
  return {
    element,
    destroy() {
      if (closed) return;
      closed = true;
      release();
      status.remove();
    },
  };
}
