import { useState, useEffect, useCallback } from "react";
import { Download, X, CheckCircle2, FolderOpen } from "lucide-react";
import { Modal } from "../../components/Modal";
import { formatTimecode } from "../../utils/time";
import { useEditorStore, timelineDurationSec } from "../../stores/editorStore";
import { createBackend } from "../../services";
import type { ExportSettings, ExportProgress } from "../../types/project";

interface ExportPanelProps {
  onClose: () => void;
}

// Presets name the short side; the long side follows the project's
// aspect ratio, so vertical (9:16) and square projects export without
// being letterboxed into a 16:9 frame.
const RESOLUTIONS: Record<string, number> = {
  "720p": 720,
  "1080p": 1080,
  "1440p": 1440,
  "4K": 2160,
};

function outputSize(shortSide: number, canvasWidth: number, canvasHeight: number): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2); // most encoders require even dimensions
  return canvasWidth >= canvasHeight
    ? { width: even((shortSide * canvasWidth) / canvasHeight), height: shortSide }
    : { width: shortSide, height: even((shortSide * canvasHeight) / canvasWidth) };
}

export function ExportPanel({ onClose }: ExportPanelProps) {
  const project = useEditorStore((s) => s.project);
  const duration = timelineDurationSec(project);

  const [format, setFormat] = useState<ExportSettings["format"]>("mp4");
  const canvasWidth = project?.canvasWidth ?? 1920;
  const canvasHeight = project?.canvasHeight ?? 1080;
  const [resolution, setResolution] = useState(
    () => Object.keys(RESOLUTIONS).find((k) => RESOLUTIONS[k] === Math.min(canvasWidth, canvasHeight)) ?? "1080p"
  );
  const [fps, setFps] = useState(() => ([24, 30, 60].includes(Math.round(project?.fps ?? 30)) ? Math.round(project?.fps ?? 30) : 30));
  const [quality, setQuality] = useState<ExportSettings["quality"]>("high");
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const backend = await createBackend();
      if (disposed) return; // unmounted (or StrictMode re-ran) before the backend resolved
      unsubscribe = backend.onExportProgress((p) => {
        if (p.currentStage === "error") {
          // Back to the settings form, with the reason shown above the button.
          setError(p.errorMessage || "Export failed");
          setProgress(null);
          return;
        }
        setProgress(p);
      });
    })();
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const handleExport = useCallback(async () => {
    if (!project) return;
    setError(null);
    setProgress({ jobId: "", percentDone: 0, currentStage: "preparing" });

    const { width, height } = outputSize(RESOLUTIONS[resolution], canvasWidth, canvasHeight);
    const baseName = project.name.replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "export";
    const settings: ExportSettings = {
      // Relative paths are resolved against the project folder by the backend.
      outputPath: `exports/${baseName}_${Date.now()}.${format}`,
      format,
      width,
      height,
      fps,
      quality,
    };

    try {
      const backend = await createBackend();
      await backend.startExport(settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    }
  }, [project, format, resolution, fps, quality, canvasWidth, canvasHeight]);

  const handleCancel = useCallback(async () => {
    try {
      const backend = await createBackend();
      await backend.cancelExport();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleReveal = useCallback(async (path: string) => {
    try {
      const backend = await createBackend();
      await backend.revealInFileManager(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stage = progress?.currentStage;
  const isExporting = !!progress && stage !== "done" && stage !== "error";
  const isDone = stage === "done";

  return (
    <Modal onClose={onClose} dismissable={!isExporting}>
      <div className="w-96 rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-text-primary">Export Video</h2>
          <button onClick={onClose} disabled={isExporting} className="text-text-tertiary hover:text-text-primary disabled:opacity-30" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {!isExporting && !isDone && (
          <div className="space-y-3.5">
            <Field label="Format">
              <SegmentedControl options={["mp4", "mov", "webm", "mkv"]} value={format} onChange={(v) => setFormat(v as ExportSettings["format"])} />
            </Field>
            <Field label="Resolution">
              <SegmentedControl options={Object.keys(RESOLUTIONS)} value={resolution} onChange={setResolution} />
            </Field>
            <Field label="Frame rate">
              <SegmentedControl options={["24", "30", "60"]} value={String(fps)} onChange={(v) => setFps(Number(v))} />
            </Field>
            <Field label="Quality">
              <SegmentedControl options={["low", "medium", "high", "ultra"]} value={quality} onChange={(v) => setQuality(v as ExportSettings["quality"])} />
            </Field>

            <div className="text-xs text-text-tertiary font-mono-tabular pt-1 space-y-0.5">
              <div>
                {(() => {
                  const { width, height } = outputSize(RESOLUTIONS[resolution], canvasWidth, canvasHeight);
                  return `${width}×${height}`;
                })()}{" "}
                · {formatTimecode(duration, fps)}
              </div>
              <div className="font-sans">Saved to the project's exports folder</div>
            </div>

            {error && <div className="text-xs text-danger bg-danger/10 rounded p-2 whitespace-pre-wrap max-h-32 overflow-y-auto">{error}</div>}

            <button
              onClick={handleExport}
              disabled={!project || duration === 0}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-accent hover:bg-accent-dim disabled:opacity-40 text-white text-sm font-medium transition-colors"
              title={duration === 0 ? "Add clips to the timeline first" : undefined}
            >
              <Download size={14} />
              {error ? "Try again" : "Export"}
            </button>
          </div>
        )}

        {isExporting && (
          <div className="space-y-3 py-2">
            <div className="flex items-center justify-between text-xs text-text-secondary">
              <span className="capitalize">{stage}...</span>
              <span className="font-mono-tabular text-text-tertiary">{Math.round(progress?.percentDone ?? 0)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
              <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${progress?.percentDone ?? 0}%` }} />
            </div>
            <button onClick={handleCancel} className="w-full py-1.5 rounded-md bg-surface-3 hover:bg-danger/15 hover:text-danger text-xs text-text-secondary transition-colors">
              Cancel export
            </button>
          </div>
        )}

        {isDone && (
          <div className="py-4 text-center space-y-3">
            <div className="flex items-center justify-center gap-2 text-sm text-text-primary">
              <CheckCircle2 size={16} className="text-green-400" />
              Export complete
            </div>
            {progress?.outputPath && (
              <p className="text-[11px] text-text-tertiary font-mono-tabular break-all px-2" title={progress.outputPath}>
                {progress.outputPath}
              </p>
            )}
            <div className="flex gap-2 justify-center">
              {progress?.outputPath && (
                <button
                  onClick={() => handleReveal(progress.outputPath!)}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-surface-3 hover:bg-border-strong text-text-primary transition-colors"
                >
                  <FolderOpen size={13} />
                  Show in folder
                </button>
              )}
              <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-md bg-accent hover:bg-accent-dim text-white transition-colors">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] text-text-tertiary mb-1">{label}</label>
      {children}
    </div>
  );
}

function SegmentedControl({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex rounded-md bg-surface-1 p-0.5 gap-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`flex-1 text-xs py-1.5 rounded-[5px] transition-colors uppercase tracking-wide ${
            value === opt ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
