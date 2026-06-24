import { useState, useEffect, useCallback } from "react";
import { Download, X } from "lucide-react";
import { useEditorStore, timelineDurationSec } from "../../stores/editorStore";
import { createBackend } from "../../services";
import type { ExportSettings, ExportProgress } from "../../types/project";

interface ExportPanelProps {
  onClose: () => void;
}

const RESOLUTIONS: Record<string, { width: number; height: number }> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "4K": { width: 3840, height: 2160 },
};

export function ExportPanel({ onClose }: ExportPanelProps) {
  const project = useEditorStore((s) => s.project);
  const duration = timelineDurationSec(project);

  const [format, setFormat] = useState<ExportSettings["format"]>("mp4");
  const [resolution, setResolution] = useState("1080p");
  const [fps, setFps] = useState(30);
  const [quality, setQuality] = useState<ExportSettings["quality"]>("high");
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    (async () => {
      const backend = await createBackend();
      unsubscribe = backend.onExportProgress((p) => {
        setProgress(p);
        if (p.currentStage === "error") setError(p.errorMessage || "Export failed");
      });
    })();
    return () => unsubscribe?.();
  }, []);

  const handleExport = useCallback(async () => {
    if (!project) return;
    setError(null);
    setProgress({ jobId: "", percentDone: 0, currentStage: "preparing" });

    const { width, height } = RESOLUTIONS[resolution];
    const settings: ExportSettings = {
      outputPath: `exports/${project.name.replace(/[^a-zA-Z0-9-_ ]/g, "")}_${Date.now()}.${format}`,
      format,
      width,
      height,
      fps,
      quality,
    };

    try {
      const backend = await createBackend();
      await backend.startExport(settings);
    } catch (e: any) {
      setError(e.message || String(e));
    }
  }, [project, format, resolution, fps, quality]);

  const isExporting = progress && progress.currentStage !== "done" && progress.currentStage !== "error";

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-96 rounded-lg bg-surface-2 border border-border-strong shadow-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-text-primary">Export Video</h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        {!isExporting && progress?.currentStage !== "done" && (
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

            <div className="text-xs text-text-tertiary font-mono-tabular pt-1">
              Timeline duration: {duration.toFixed(1)}s
            </div>

            {error && <div className="text-xs text-danger bg-danger/10 rounded p-2">{error}</div>}

            <button
              onClick={handleExport}
              disabled={!project || duration === 0}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-accent hover:bg-accent-dim disabled:opacity-40 text-white text-sm font-medium transition-colors"
            >
              <Download size={14} />
              Export
            </button>
          </div>
        )}

        {isExporting && (
          <div className="space-y-3 py-4">
            <div className="text-xs text-text-secondary capitalize">{progress?.currentStage}...</div>
            <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${progress?.percentDone ?? 0}%` }} />
            </div>
            <div className="text-xs font-mono-tabular text-text-tertiary text-right">{Math.round(progress?.percentDone ?? 0)}%</div>
          </div>
        )}

        {progress?.currentStage === "done" && (
          <div className="py-6 text-center space-y-2">
            <div className="text-sm text-text-primary">Export complete</div>
            <button onClick={onClose} className="text-xs text-accent hover:underline">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
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
