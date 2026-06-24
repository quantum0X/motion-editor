/**
 * Dev-mode-only helper: browsers convert dropped/selected Files into
 * blob: object URLs, losing the original filename in the process. This
 * map preserves that association so the mock backend can still display
 * real filenames in the UI. Not used by the real Wails backend, which
 * gets real filesystem paths (and therefore real filenames) directly
 * from the OS file dialog.
 */
const objectUrlToFileName = new Map<string, string>();

export function registerObjectUrlFileName(url: string, fileName: string) {
  objectUrlToFileName.set(url, fileName);
}

export function objectUrlToFileNameLookup(url: string): string | undefined {
  return objectUrlToFileName.get(url);
}
