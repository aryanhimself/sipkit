/**
 * Synthetic camera for mock engines and tests (V2-VID-01): a canvas animated
 * with a moving bar, a label and a clock, captured with `captureStream()`, so
 * mock UIs and Playwright can exercise real `<video>` playback without a camera.
 */
export interface SyntheticVideo {
  readonly track: MediaStreamTrack;
  stop(): void;
}

/** True when the environment can generate synthetic video (a browser with canvas captureStream). */
export function supportsSyntheticVideo(): boolean {
  if (typeof document === 'undefined' || typeof MediaStream === 'undefined') return false;
  const canvas = document.createElement('canvas') as HTMLCanvasElement & { captureStream?: unknown };
  return typeof canvas.captureStream === 'function' && typeof canvas.getContext === 'function';
}

/**
 * Start a synthetic video track (undefined when unsupported, e.g. jsdom).
 * `hue` (0..360) tints the background so local and remote views differ.
 */
export function createSyntheticVideo(label: string, hue = 210, width = 320, height = 240): SyntheticVideo | undefined {
  if (!supportsSyntheticVideo()) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(15);
  const track = stream.getVideoTracks()[0];
  if (!track) return undefined;
  let frame = 0;
  const draw = () => {
    frame += 1;
    ctx.fillStyle = `hsl(${hue} 45% 22%)`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = `hsl(${hue} 70% 60%)`;
    const x = (frame * 4) % (width + 60);
    ctx.fillRect(x - 60, height - 24, 60, 8);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.round(height / 9)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(label, width / 2, height / 2);
    ctx.font = `${Math.round(height / 16)}px ui-monospace, monospace`;
    ctx.fillText(new Date().toISOString().slice(11, 19), width / 2, height / 2 + height / 8);
  };
  draw();
  const timer = setInterval(draw, 1000 / 15);
  const stop = () => {
    clearInterval(timer);
    track.stop();
  };
  track.addEventListener('ended', () => clearInterval(timer));
  return { track, stop };
}
