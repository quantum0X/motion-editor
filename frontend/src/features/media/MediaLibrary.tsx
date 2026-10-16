import { memo, useRef, useState, useCallback } from "react";
import { Upload, Search, Film, Music, Image as ImageIcon } from "lucide-react";
import { useEditorStore } from "../../stores/editorStore";
import { formatDuration, formatFileSize } from "../../utils/time";
import type { MediaAsset } from "../../types/project";
import { registerObjectUrlFileName } from "../../services/objectUrlRegistry";
import { isDirectlyLoadableUrl, useResolvedMediaUrl } from "../../utils/mediaUrl";
import { createDragGhost, findTrackElementAtPoint } from "../../utils/dragCoordinator";
import { createBackend } from "../../services";

const DRAG_THRESHOLD_PX = 4;
const DROP_HIGHLIGHT = ["bg-accent/15", "ring-1", "ring-accent", "ring-inset"];

function isWailsRuntime(): boolean {
  return !!(window as { go?: { main?: { App?: unknown } } }).go?.main?.App;
}

export function MediaLibrary() {
  const project = useEditorStore((s) => s.project);
  const importFiles = useEditorStore((s) => s.importFiles);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  // dragenter/dragleave also fire for every child element the cursor
  // crosses; counting them keeps the highlight from flickering.
  const dragDepth = useRef(0);

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
    if (!isWailsRuntime()) {
      fileInputRef.current?.click();
      return;
    }
    // Real Wails app: native file dialog returns real paths.
    setIsImporting(true);
    try {
      const backend = await createBackend();
      const paths = await backend.openFileDialog();
      if (paths.length > 0) await importFiles(paths);
    } catch (e) {
      useEditorStore.getState().setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsImporting(false);
    }
  }, [importFiles]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setIsDragOver(false);
      // In the desktop app, Wails' native OnFileDrop (see EditorLayout)
      // imports the real file paths; these File objects have none.
      if (isWailsRuntime()) return;
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
  const query = searchQuery.trim().toLowerCase();
  const filteredAssets = query ? assets.filter((a) => a.fileName.toLowerCase().includes(query)) : assets;

  return (
    <div
      className="flex flex-col h-full bg-surface-1 border-r border-border-subtle"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current++;
        setIsDragOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setIsDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <div className="p-2.5 border-b border-border-subtle space-y-2 shrink-0">
        <button
          onClick={handleImportClick}
          disabled={!project || isImporting}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-surface-3 hover:bg-border-strong text-sm text-text-primary disabled:opacity-50 transition-colors"
        >
          <Upload size={14} />
          {isImporting ? "Importing..." : "Import Media"}
        </button>
        <input ref={fileInputRef} type="file" multiple accept="video/*,audio/*,image/*" className="hidden" onChange={handleFileInputChange} />

        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={assets.length > 0 ? `Search ${assets.length} item${assets.length === 1 ? "" : "s"}...` : "Search media..."}
            aria-label="Search media"
            className="w-full pl-7 pr-2 py-1.5 rounded-md bg-surface-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      <div
        className={`flex-1 overflow-y-auto p-2 grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2 content-start transition-colors ${
          isDragOver ? "bg-accent/10 ring-2 ring-inset ring-accent/60" : ""
        }`}
      >
        {assets.length === 0 && (
          <div className="col-span-full flex flex-col items-center justify-center text-center gap-2 text-text-tertiary text-xs py-10 px-3">
            <Upload size={20} />
            <p>Drop video, audio or image files here, or click Import Media</p>
          </div>
        )}
        {assets.length > 0 && filteredAssets.length === 0 && (
          <div className="col-span-full text-center text-text-tertiary text-xs py-8 px-3">
            No media matches "{searchQuery.trim()}"
            <button onClick={() => setSearchQuery("")} className="block mx-auto mt-2 text-accent hover:underline">
              Clear search
            </button>
          </div>
        )}
        {filteredAssets.map((asset) => (
          <MediaCard key={asset.id} asset={asset} />
        ))}
      </div>
    </div>
  );
}

const MediaCard = memo(function MediaCard({ asset }: { asset: MediaAsset }) {
  const addAssetAtPlayhead = useEditorStore((s) => s.addAssetAtPlayhead);
  const addClip = useEditorStore((s) => s.addClip);
  const thumbnailUrl = useResolvedMediaUrl(asset.thumbnailPath);

  // Custom pointer-based drag onto the timeline, instead of HTML5 native
  // Drag-and-Drop - see utils/dragCoordinator.ts for why: DnD support is
  // inconsistent across the different webviews Wails uses per OS, and
  // this app's own timeline clip dragging already avoids it for the
  // same reason. mousedown starts tracking; a floating label follows
  // the cursor; the track lane under the cursor is highlighted if it
  // can accept this asset's media type; mouseup over a valid track adds
  // the clip there.
  const handlePointerDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      // The ghost only appears once the mouse actually moves, so a plain
      // click or double-click doesn't flash a drag label.
      let ghost: ReturnType<typeof createDragGhost> | null = null;
      let hoveredEl: HTMLElement | null = null;

      const isCompatible = (el: HTMLElement | null) =>
        !!el && el.dataset.trackLocked !== "true" && (asset.mediaType === "audio" ? el.dataset.trackType === "audio" : el.dataset.trackType === "video");

      const clearHighlight = () => {
        hoveredEl?.classList.remove(...DROP_HIGHLIGHT);
      };

      const handleMove = (moveEvent: MouseEvent) => {
        if (!ghost) {
          if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return;
          ghost = createDragGhost(asset.fileName);
          document.body.style.cursor = "grabbing";
        }
        ghost.moveTo(moveEvent.clientX, moveEvent.clientY);
        const trackEl = findTrackElementAtPoint(moveEvent.clientX, moveEvent.clientY);
        if (trackEl !== hoveredEl) {
          clearHighlight();
          hoveredEl = trackEl;
        }
        if (isCompatible(hoveredEl)) hoveredEl!.classList.add(...DROP_HIGHLIGHT);
      };

      const handleUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        clearHighlight();
        if (!ghost) return; // it was a click, not a drag
        ghost.remove();
        document.body.style.cursor = "";

        const trackEl = findTrackElementAtPoint(upEvent.clientX, upEvent.clientY);
        const trackId = trackEl?.dataset.trackId;
        if (!trackId || !isCompatible(trackEl)) return;

        const rect = trackEl!.getBoundingClientRect();
        const dropStartSec = Math.max(0, (upEvent.clientX - rect.left) / useEditorStore.getState().pixelsPerSecond);
        const duration = asset.mediaType === "image" ? 5 : asset.durationSec;

        addClip(trackId, {
          assetId: asset.id,
          timelineStartSec: dropStartSec,
          timelineEndSec: dropStartSec + duration,
          sourceInSec: 0,
          sourceOutSec: duration,
          speed: 1,
          opacity: 1,
          volume: 1,
          muted: false,
          effects: [],
          keyframes: [],
          transition: null,
        });
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [asset, addClip]
  );

  const Icon = asset.mediaType === "video" ? Film : asset.mediaType === "audio" ? Music : ImageIcon;

  return (
    <div
      onMouseDown={handlePointerDown}
      onDoubleClick={() => addAssetAtPlayhead(asset.id)}
      onKeyDown={(e) => e.key === "Enter" && addAssetAtPlayhead(asset.id)}
      tabIndex={0}
      role="button"
      aria-label={`${asset.fileName} - press Enter to add at the playhead`}
      className="group rounded-md overflow-hidden bg-surface-2 hover:bg-surface-3 cursor-grab active:cursor-grabbing transition-colors"
      title={`${asset.fileName} — double-click to add at the playhead, or drag onto a track`}
    >
      <div className="relative aspect-video bg-surface-0 flex items-center justify-center overflow-hidden">
        {thumbnailUrl ? (
          asset.mediaType === "video" && isDirectlyLoadableUrl(asset.thumbnailPath) ? (
            // Mock/dev mode only: thumbnailPath there is the same blob
            // URL as the source video itself (no real still-frame JPEG
            // exists), so the <video> element doubles as a poster-frame
            // substitute. The real backend always generates an actual
            // JPEG thumbnail file, rendered via <img> below instead.
            <video src={thumbnailUrl} className="w-full h-full object-cover" muted preload="metadata" />
          ) : (
            <img src={thumbnailUrl} alt="" draggable={false} className="w-full h-full object-cover" />
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
});
