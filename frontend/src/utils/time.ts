/**
 * Formats seconds as a timecode string. Below one hour shows MM:SS.FF
 * (frames), matching how Premiere/Resolve/CapCut display the playhead
 * position — full HH:MM:SS:FF once the timeline is long enough to need
 * the hour digit, so short-form social clips don't show a redundant
 * "00:" prefix.
 */
export function formatTimecode(totalSeconds: number, fps: number): string {
  if (!isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;

  const totalFrames = Math.round(totalSeconds * fps);
  const framesPerSecond = Math.max(1, Math.round(fps));

  const frames = totalFrames % framesPerSecond;
  const totalWholeSeconds = Math.floor(totalFrames / framesPerSecond);
  const seconds = totalWholeSeconds % 60;
  const totalMinutes = Math.floor(totalWholeSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad = (n: number, width = 2) => n.toString().padStart(width, "0");

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}.${pad(frames)}`;
}

/** Formats a byte count as a human-readable size (e.g. "4.2 MB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Formats a plain duration (no frames) as M:SS, used in media library cards. */
export function formatDuration(totalSeconds: number): string {
  if (!isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
