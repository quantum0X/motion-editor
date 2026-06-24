import type { EditorBackend } from "./EditorBackend";
import { createMockBackend } from "./mockBackend";

let cachedBackend: EditorBackend | null = null;

/**
 * Returns the active EditorBackend implementation: the real Wails-backed
 * one when running inside the packaged desktop app (detected by the
 * presence of `window.go`, which Wails injects), otherwise the in-browser
 * mock used for standalone frontend development.
 *
 * The Wails backend module is imported dynamically so that its
 * `declare global { interface Window { go: ... } }` augmentation doesn't
 * cause issues bundling for a pure-browser dev preview, and so dev builds
 * never pay for code they don't use.
 */
export async function createBackend(): Promise<EditorBackend> {
  if (cachedBackend) return cachedBackend;

  if (typeof window !== "undefined" && (window as any).go?.main?.App) {
    const { createWailsBackend } = await import("./wailsBackend");
    cachedBackend = createWailsBackend();
  } else {
    cachedBackend = createMockBackend();
  }
  return cachedBackend;
}
