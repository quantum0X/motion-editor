import { useEffect, useState } from "react";
import { createBackend } from "../services";

/** True for URLs an element can already load directly - the mock backend's blob: URLs, or any http(s)/data URL - no resolution needed. */
export function isDirectlyLoadableUrl(path: string): boolean {
  return /^(blob:|https?:|data:)/i.test(path);
}

const cache = new Map<string, Promise<string>>();

/**
 * Resolves a MediaAsset's `filePath`/`thumbnailPath` (a plain absolute
 * filesystem path, as stored by the real Go backend) into a URL a
 * <video>/<audio>/<img> element or canvas can actually load.
 *
 * Why this is needed at all: a bare OS path like
 * "/home/alice/Videos/clip.mp4" is not a valid URL, and Wails' asset
 * server only serves the embedded frontend bundle - it has no built-in
 * route for arbitrary local files. Without this, every video and every
 * thumbnail in the real (non-mock) app renders as nothing at all - a
 * permanently black canvas / broken image - no matter what else is
 * correct. This calls the `ReadMediaFileAsDataURL` Go binding (see
 * app.go for why that's an IPC-bound method rather than an HTTP route)
 * and caches the result per path, since the same source file is reused
 * across every clip that references it (see useCompositor.ts) and
 * across the media library thumbnail + every timeline clip's thumbnail
 * for that same asset.
 */
export async function resolveMediaUrl(path: string): Promise<string> {
  if (!path) return path;
  if (isDirectlyLoadableUrl(path)) return path;

  const cached = cache.get(path);
  if (cached) return cached;

  const promise = (async () => {
    const backend = await createBackend();
    return backend.readMediaFileAsDataUrl(path);
  })();

  cache.set(path, promise);
  // Don't keep a failed resolution cached - lets a later retry succeed
  // (e.g. a transient read error, or the file becoming available again).
  promise.catch(() => cache.delete(path));
  return promise;
}

/** React hook wrapper around resolveMediaUrl for JSX `src`/`background-image` usage. Returns undefined while resolving or if path is empty. */
export function useResolvedMediaUrl(path: string | undefined): string | undefined {
  const [resolved, setResolved] = useState<string | undefined>(() => (path && isDirectlyLoadableUrl(path) ? path : undefined));

  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setResolved(undefined);
      return;
    }
    if (isDirectlyLoadableUrl(path)) {
      setResolved(path);
      return;
    }
    setResolved(undefined);
    resolveMediaUrl(path)
      .then((url) => {
        if (!cancelled) setResolved(url);
      })
      .catch(() => {
        /* leave resolved as undefined - caller shows its own fallback (icon, placeholder, etc.) */
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return resolved;
}
