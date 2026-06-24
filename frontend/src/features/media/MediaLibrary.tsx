import { useRef, useState, useCallback } from "react";
import { Upload, Search, Film, Music, Image as ImageIcon } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { formatDuration, formatFileSize } from "../../utils/time";
import type { MediaAsset } from "../../types/project";
import { registerObjectUrlFileName } from "../../services/objectUrlRegistry";

export function MediaLibrary() {
  const project = useEditorStore((s) => s.project);
  const importFiles = useEditorStore((s) => s.importFiles);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);

  // Browser file input -> object URLs, used by the mock backend's
  // dev-mode import path (see services/mockMediaImport.ts). The real
  // Wails app instead uses OpenFileDialog(), which returns real
  // filesystem paths directly - no object URL conversion needed there.
  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      const objectUrls = files.map((f) => {
        const url = URL.createObjectURL(f);
        registerObjectUrlFileName(url, f.name);
        return url;
      });
      await importFiles(objectUrls);
      e.target.value = "";
    },
    [importFiles]
  );

  const handleImportClick = useCallback(async () => {
    if (typeof window !== "undefined" && (window as any).go?.main?.App) {
      // Real Wails app: native file dialog returns real paths.
      const { createBackend } = await import("../../services");
      const backend = await createBackend();
      const paths = await backend.openFileDialog();
      if (paths.length > 0) await importFiles(paths);
    } else {
      fileInputRef.current?.click();
    }
  }, [importFiles]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const objectUrls = files.map((f) => {
        const url = URL.createObjectURL(f);
        registerObjectUrlFileName(url, f.name);
        return url;
      });
      await importFiles(objectUrls);
    },
    [importFiles]
  );

  const assets = project?.assets ?? [];
  const filteredAssets = assets.filter((a) => a.fileName.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <div
      className="flex flex-col h-full bg-surface-1 border-r border-border-subtle"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="p-2.5 border-b border-border-subtle space-y-2 shrink-0">
        <button
          onClick={handleImportClick}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-surface-3 hover:bg-border-strong text-sm text-text-primary transition-colors"
        >
          <Upload size={14} />
          Import Media
        </button>
        <input ref={fileInputRef} type="file" multiple accept="video/*,audio/*,image/*" className="hidden" onChange={handleFileInputChange} />

        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search media..."
            className="w-full pl-7 pr-2 py-1.5 rounded-md bg-surface-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto p-2 grid grid-cols-2 gap-2 content-start ${isDragOver ? "bg-accent/5" : ""}`}>
        {filteredAssets.length === 0 && (
          <div className="col-span-2 flex flex-col items-center justify-center text-center gap-2 text-text-tertiary text-xs py-10 px-3">
            <Upload size={20} />
            <p>Drag media here or click Import Media</p>
          </div>
        )}
        {filteredAssets.map((asset) => (
          <MediaCard key={asset.id} asset={asset} />
        ))}
      </div>
    </div>
  );
}

function MediaCard({ asset }: { asset: MediaAsset }) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-media-asset-id", asset.id);
    e.dataTransfer.effectAllowed = "copy";
  };

  const Icon = asset.mediaType === "video" ? Film : asset.mediaType === "audio" ? Music : ImageIcon;

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      className="group rounded-md overflow-hidden bg-surface-2 hover:bg-surface-3 cursor-grab active:cursor-grabbing transition-colors"
      title={asset.fileName}
    >
      <div className="relative aspect-video bg-surface-0 flex items-center justify-center overflow-hidden">
        {asset.thumbnailPath ? (
          asset.mediaType === "video" ? (
            // Dev mode: thumbnailPath is the same object URL as the
            // source video, so we use the <video> element itself as a
            // poster-frame substitute. Real Wails mode uses an actual
            // generated JPEG thumbnail file path here instead.
            <video src={asset.thumbnailPath} className="w-full h-full object-cover" muted preload="metadata" />
          ) : (
            <img src={asset.thumbnailPath} className="w-full h-full object-cover" />
          )
        ) : (
          <Icon size={20} className="text-text-tertiary" />
        )}
        {asset.mediaType !== "image" && (
          <span className="absolute bottom-1 right-1 text-[10px] font-mono-tabular bg-black/70 text-white px-1 rounded">
            {formatDuration(asset.durationSec)}
          </span>
        )}
      </div>
      <div className="p-1.5">
        <p className="text-[11px] text-text-primary truncate">{asset.fileName}</p>
        <p className="text-[10px] text-text-tertiary font-mono-tabular">
          {asset.width > 0 ? `${asset.width}×${asset.height} · ` : ""}
          {formatFileSize(asset.fileSizeBytes)}
        </p>
      </div>
    </div>
  );
}
