import { useEffect, useState } from "react";
import { createBackend } from "../services";

/** True for URLs an element can already load directly - the mock backend's blob: URLs, or any http(s)/data URL - no resolution needed. */
export function isDirectlyLoadableUrl(path: string): boolean {
  return /^(blob:|https?:|data:)/i.test(path);
}

const cache = new Map<string, Promise<string>>();

function isWailsRuntime(): boolean {
  return typeof window !== "undefined" && !!(window as { go?: { main?: { App?: unknown } } }).go?.main?.App;
}

/** Streamed, range-capable URL for a project file - served by mediaserver.go. */
function streamUrlFor(path: string): string {
  return `/localmedia?path=${encodeURIComponent(path)}`;
}

let streamingSupported: Promise<boolean> | null = null;

/**
 * Checks once per session whether the Go /localmedia route is reachable
 * (it should be in both `wails dev` and a built app). If something in the
 * webview/asset-server chain gets in the way - e.g. the dev server's SPA
 * fallback answering with index.html - we fall back to the slower
 * data: URL path rather than showing a black preview.
 */
function checkStreamingSupported(samplePath: string): Promise<boolean> {
  if (!streamingSupported) {
    streamingSupported = fetch(streamUrlFor(samplePath), { method: "HEAD" })
      // Any non-HTML answer (even a 404 for a since-deleted file, which
      // mediaserver.go sends as text/plain) proves the route itself works.
      .then((res) => !(res.headers.get("content-type") ?? "").includes("text/html"))
      .catch(() => false);
  }
  return streamingSupported;
}

/**
 * Resolves a MediaAsset's `filePath`/`thumbnailPath` (a plain absolute
 * filesystem path, as stored by the real Go backend) into a URL a
 * <video>/<audio>/<img> element or canvas can actually load.
 *
 * A bare OS path like "C:\Videos\clip.mp4" is not a valid URL, so in the
 * Wails app this points elements at the Go asset-server route
 * `/localmedia` (see mediaserver.go), which streams the file with HTTP
 * Range support - videos start playing and seeking immediately instead
 * of waiting for the whole file to be base64-encoded across IPC. Results
 * are cached per path, since the same source file is reused by every clip
 * and thumbnail that references it.
 */
export async function resolveMediaUrl(path: string): Promise<string> {
  if (!path) return path;
  if (isDirectlyLoadableUrl(path)) return path;

  const cached = cache.get(path);
  if (cached) return cached;

  const promise = (async () => {
    if (isWailsRuntime() && (await checkStreamingSupported(path))) {
      return streamUrlFor(path);
    }
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
