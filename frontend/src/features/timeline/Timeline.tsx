import { useRef, useCallback, useEffect, useState } from "react";
import { ZoomIn, ZoomOut, Scissors, Copy, Trash2, Type, Sparkles, ArrowRightLeft } from "lucide-react";
import { useEditorStore, timelineDurationSec } from "../../stores/editorStore";
import { TimeRuler } from "./TimeRuler";
import { TimelineTrack } from "./TimelineTrack";
import { TextClipPanel } from "./TextClipPanel";
import { ClipEffectsPanel } from "./ClipEffectsPanel";
import { TransitionPanel } from "./TransitionPanel";

export function Timeline() {
  const project = useEditorStore((s) => s.project);
  const playheadSec = useEditorStore((s) => s.playheadSec);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const pixelsPerSecond = useEditorStore((s) => s.pixelsPerSecond);
  const setZoom = useEditorStore((s) => s.setZoom);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const splitClipAt = useEditorStore((s) => s.splitClipAt);
  const deleteSelectedClip = useEditorStore((s) => s.deleteSelectedClip);
  const duplicateSelectedClip = useEditorStore((s) => s.duplicateSelectedClip);
  const selectClip = useEditorStore((s) => s.selectClip);
  const ensureTextTrack = useEditorStore((s) => s.ensureTextTrack);
  const addTextClip = useEditorStore((s) => s.addTextClip);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [clipboardClipId, setClipboardClipId] = useState<string | null>(null);
  const [editingTextClipId, setEditingTextClipId] = useState<string | null>(null);
  const [effectsClipId, setEffectsClipId] = useState<string | null>(null);
  const [transitionClipId, setTransitionClipId] = useState<string | null>(null);

  const duration = timelineDurationSec(project);
  const totalWidth = Math.max(duration + 30, 60) * pixelsPerSecond + 200;

  // Keyboard shortcuts scoped to the timeline: S = split at playhead,
  // Delete/Backspace = remove selected clip, Ctrl+D = duplicate,
  // Ctrl+C / Ctrl+V = copy/paste (paste places at current playhead).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      if (e.key === "s" || e.key === "S") {
        if (selectedClipId) {
          e.preventDefault();
          splitClipAt(selectedClipId, playheadSec);
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedClipId) {
          e.preventDefault();
          deleteSelectedClip();
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (e.key === "z" || e.key === "Z") {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (e.key === "y" || e.key === "Y") {
          e.preventDefault();
          redo();
        } else if (e.key === "d" || e.key === "D") {
          if (selectedClipId) {
            e.preventDefault();
            duplicateSelectedClip();
          }
        } else if (e.key === "c" || e.key === "C") {
          if (selectedClipId) {
            e.preventDefault();
            setClipboardClipId(selectedClipId);
          }
        } else if (e.key === "v" || e.key === "V") {
          if (clipboardClipId) {
            e.preventDefault();
            // "Paste" in Phase 1 is implemented as duplicate-then-move:
            // duplicate the clipboard clip (lands right after itself on
            // its own track) then move that copy to the playhead. This
            // reuses two already-validated backend operations rather
            // than adding a third bespoke "paste" endpoint for what is
            // semantically the same overlap-checked insert.
            duplicateSelectedClip();
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedClipId, playheadSec, clipboardClipId, splitClipAt, deleteSelectedClip, duplicateSelectedClip, undo, redo]);

  const handleSeek = useCallback((sec: number) => setPlayhead(sec), [setPlayhead]);

  const handleBackgroundClick = useCallback(() => {
    selectClip(null);
  }, [selectClip]);

  const handleAddText = useCallback(async () => {
    try {
      const trackId = await ensureTextTrack();
      const start = playheadSec;
      await addTextClip(trackId, {
        timelineStartSec: start,
        timelineEndSec: start + 3,
        content: "New text",
        fontFamily: "sans",
        fontSize: 32,
        fontWeight: "bold",
        color: "#ffffff",
        positionXPercent: 50,
        positionYPercent: 85,
        alignment: "center",
        outlineEnabled: true,
        outlineColor: "#000000",
        outlineWidth: 2,
        shadowEnabled: false,
        shadowColor: "#000000",
        opacity: 1,
      });
    } catch {
      // error already surfaced via the store's lastError state
    }
  }, [ensureTextTrack, addTextClip, playheadSec]);

  if (!project) {
    return <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">No project open</div>;
  }

  const selectedVideoClipId =
    selectedClipId && project.tracks.some((t) => t.type === "video" && (t.clips ?? []).some((c) => c.id === selectedClipId))
      ? selectedClipId
      : null;

  // A transition is only available on a video clip that has another clip
  // starting right after it on the same track (the "A -> B" boundary).
  const selectedTransitionClipId = (() => {
    if (!selectedVideoClipId) return null;
    for (const track of project.tracks) {
      if (track.type !== "video") continue;
      const clips = track.clips ?? [];
      const sel = clips.find((c) => c.id === selectedVideoClipId);
      if (!sel) continue;
      const hasNext = clips.some((c) => c.id !== sel.id && c.timelineStartSec >= sel.timelineEndSec - 0.001);
      return hasNext ? selectedVideoClipId : null;
    }
    return null;
  })();

  // Sort tracks for display: video tracks highest-order-first (so track
  // "Video 2" visually sits above "Video 1", matching its compositing
  // priority), then text tracks, then audio tracks at the bottom -
  // mirroring the export pipeline's layering (text always composites
  // above every video track; audio has no visual stacking order at all,
  // it's just placed last for a sensible "video on top, sound below"
  // reading order).
  const videoTracks = [...project.tracks].filter((t) => t.type === "video").sort((a, b) => b.order - a.order);
  const textTracks = [...project.tracks].filter((t) => t.type === "text").sort((a, b) => b.order - a.order);
  const audioTracks = [...project.tracks].filter((t) => t.type === "audio").sort((a, b) => b.order - a.order);

  return (
    <div className="flex flex-col h-full bg-surface-1">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle shrink-0">
        <button
          onClick={() => selectedClipId && splitClipAt(selectedClipId, playheadSec)}
          disabled={!selectedClipId}
          className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          title="Split at playhead (S)"
        >
          <Scissors size={14} />
        </button>
        <button
          onClick={() => selectedClipId && duplicateSelectedClip()}
          disabled={!selectedClipId}
          className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          title="Duplicate (Ctrl+D)"
        >
          <Copy size={14} />
        </button>
        <button
          onClick={() => selectedClipId && deleteSelectedClip()}
          disabled={!selectedClipId}
          className="p-1.5 rounded text-text-secondary hover:text-danger hover:bg-surface-3 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          title="Delete (Del)"
        >
          <Trash2 size={14} />
        </button>

        <div className="h-4 w-px bg-border-subtle mx-1" />

        <button
          onClick={handleAddText}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors text-xs"
          title="Add text at playhead"
        >
          <Type size={14} />
          Add Text
        </button>

        <button
          onClick={() => selectedClipId && setEffectsClipId(selectedClipId)}
          disabled={!selectedVideoClipId}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-xs"
          title="Effects: color correction, filters"
        >
          <Sparkles size={14} />
          Effects
        </button>

        <button
          onClick={() => selectedClipId && setTransitionClipId(selectedClipId)}
          disabled={!selectedTransitionClipId}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-xs"
          title="Add or edit the transition between this clip and the next"
        >
          <ArrowRightLeft size={14} />
          Transition
        </button>

        <div className="flex-1" />

        <button onClick={() => setZoom(pixelsPerSecond / 1.4)} className="p-1.5 text-text-secondary hover:text-text-primary transition-colors" title="Zoom out">
          <ZoomOut size={14} />
        </button>
        <button onClick={() => setZoom(pixelsPerSecond * 1.4)} className="p-1.5 text-text-secondary hover:text-text-primary transition-colors" title="Zoom in">
          <ZoomIn size={14} />
        </button>
      </div>

      {/* Scrollable ruler + tracks */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto relative" onClick={handleBackgroundClick}>
        <div className="sticky top-0 z-20 flex">
          <div className="w-36 shrink-0 bg-surface-2 border-r border-b border-border-subtle sticky left-0 z-30" />
          <TimeRuler pixelsPerSecond={pixelsPerSecond} durationSec={duration} fps={project.fps} playheadSec={playheadSec} onSeek={handleSeek} />
        </div>

        <div className="relative">
          {videoTracks.map((track) => (
            <TimelineTrack
              key={track.id}
              track={track}
              project={project}
              pixelsPerSecond={pixelsPerSecond}
              totalWidth={totalWidth}
              onEditClipEffects={setEffectsClipId}
            />
          ))}
          {textTracks.length > 0 && <div className="h-2 bg-surface-0" style={{ width: totalWidth + 144 }} />}
          {textTracks.map((track) => (
            <TimelineTrack
              key={track.id}
              track={track}
              project={project}
              pixelsPerSecond={pixelsPerSecond}
              totalWidth={totalWidth}
              onEditTextClip={setEditingTextClipId}
            />
          ))}
          <div className="h-2 bg-surface-0" style={{ width: totalWidth + 144 }} />
          {audioTracks.map((track) => (
            <TimelineTrack
              key={track.id}
              track={track}
              project={project}
              pixelsPerSecond={pixelsPerSecond}
              totalWidth={totalWidth}
            />
          ))}

          {/* Playhead line spanning all track lanes */}
          <div
            className="absolute top-0 bottom-0 w-px bg-accent pointer-events-none z-10"
            style={{ left: 144 + playheadSec * pixelsPerSecond }}
          />
        </div>
      </div>

      {editingTextClipId && <TextClipPanel clipId={editingTextClipId} onClose={() => setEditingTextClipId(null)} />}
      {effectsClipId && <ClipEffectsPanel clipId={effectsClipId} onClose={() => setEffectsClipId(null)} />}
      {transitionClipId && <TransitionPanel clipId={transitionClipId} onClose={() => setTransitionClipId(null)} />}
    </div>
  );
}
