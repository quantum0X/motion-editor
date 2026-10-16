import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import { ZoomIn, ZoomOut, Scissors, Copy, Trash2, Type, Sparkles, ArrowRightLeft, Maximize } from "lucide-react";
import { useEditorStore, timelineDurationSec, findClip } from "../../stores/editorStore";
import { TimeRuler } from "./TimeRuler";
import { TimelineTrack } from "./TimelineTrack";
import { TextClipPanel } from "./TextClipPanel";
import { ClipEffectsPanel } from "./ClipEffectsPanel";
import { TransitionPanel } from "./TransitionPanel";
import { TRACK_HEADER_WIDTH } from "./constants";

/** Full-height playhead line. Subscribes to playheadSec on its own so playback doesn't re-render the tracks. */
function PlayheadLine({ pixelsPerSecond }: { pixelsPerSecond: number }) {
  const playheadSec = useEditorStore((s) => s.playheadSec);
  return (
    <div
      className="absolute top-0 bottom-0 w-px bg-accent pointer-events-none z-20"
      style={{ transform: `translateX(${TRACK_HEADER_WIDTH + playheadSec * pixelsPerSecond}px)` }}
    />
  );
}

const toolButton =
  "flex items-center gap-1.5 p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 disabled:opacity-30 disabled:pointer-events-none transition-colors text-xs";

export function Timeline() {
  const project = useEditorStore((s) => s.project);
  const pixelsPerSecond = useEditorStore((s) => s.pixelsPerSecond);
  const setZoom = useEditorStore((s) => s.setZoom);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const selectedTextClipId = useEditorStore((s) => s.selectedTextClipId);
  const splitClipAt = useEditorStore((s) => s.splitClipAt);
  const deleteSelection = useEditorStore((s) => s.deleteSelection);
  const duplicateSelectedClip = useEditorStore((s) => s.duplicateSelectedClip);
  const clearSelection = useEditorStore((s) => s.clearSelection);
  const ensureTextTrack = useEditorStore((s) => s.ensureTextTrack);
  const addTextClip = useEditorStore((s) => s.addTextClip);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [editingTextClipId, setEditingTextClipId] = useState<string | null>(null);
  const [effectsClipId, setEffectsClipId] = useState<string | null>(null);
  const [transitionClipId, setTransitionClipId] = useState<string | null>(null);

  const duration = timelineDurationSec(project);
  const totalWidth = Math.max(duration + 30, 60) * pixelsPerSecond + 200;

  const assetsById = useMemo(() => new Map((project?.assets ?? []).map((a) => [a.id, a])), [project?.assets]);

  // Ctrl/Cmd + wheel zooms around the cursor (the time under the mouse
  // stays put), like every NLE. Registered natively with passive: false
  // so preventDefault can stop the webview's own page zoom.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const { pixelsPerSecond: pps, setZoom: zoom } = useEditorStore.getState();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left - TRACK_HEADER_WIDTH;
      const timeAtCursor = (el.scrollLeft + cursorX) / pps;
      zoom(pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      const nextPps = useEditorStore.getState().pixelsPerSecond;
      el.scrollLeft = Math.max(0, timeAtCursor * nextPps - cursorX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [project !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the playhead in view during playback by paging the timeline
  // forward when it runs off the right edge.
  useEffect(
    () =>
      useEditorStore.subscribe((state, prev) => {
        if (!state.isPlaying || state.playheadSec === prev.playheadSec) return;
        const el = scrollContainerRef.current;
        if (!el) return;
        const x = state.playheadSec * state.pixelsPerSecond;
        const visibleStart = el.scrollLeft;
        const visibleEnd = el.scrollLeft + el.clientWidth - TRACK_HEADER_WIDTH;
        if (x > visibleEnd - 20 || x < visibleStart) el.scrollLeft = Math.max(0, x - 40);
      }),
    []
  );

  const handleSeek = useCallback((sec: number) => useEditorStore.getState().setPlayhead(sec), []);

  const handleZoomToFit = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || duration <= 0) return;
    setZoom((el.clientWidth - TRACK_HEADER_WIDTH - 40) / duration);
    el.scrollLeft = 0;
  }, [duration, setZoom]);

  const handleAddText = useCallback(async () => {
    try {
      const trackId = await ensureTextTrack();
      const start = useEditorStore.getState().playheadSec;
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
  }, [ensureTextTrack, addTextClip]);

  if (!project) {
    return <div className="h-full flex items-center justify-center text-text-tertiary text-sm bg-surface-1">No project open</div>;
  }

  const selectedVideo = findClip(project, selectedClipId);
  const selectedVideoClipId = selectedVideo?.track.type === "video" ? selectedVideo.clip.id : null;

  // A transition is only available on a video clip that has another clip
  // starting right after it on the same track (the "A -> B" boundary).
  const selectedTransitionClipId =
    selectedVideo && selectedVideoClipId && (selectedVideo.track.clips ?? []).some((c) => c.id !== selectedVideoClipId && c.timelineStartSec >= selectedVideo.clip.timelineEndSec - 0.001)
      ? selectedVideoClipId
      : null;

  // Sort tracks for display: video tracks highest-order-first (so track
  // "Video 2" visually sits above "Video 1", matching its compositing
  // priority), then text tracks, then audio tracks at the bottom -
  // mirroring the export pipeline's layering.
  const byOrderDesc = (type: string) => project.tracks.filter((t) => t.type === type).sort((a, b) => b.order - a.order);
  const videoTracks = byOrderDesc("video");
  const textTracks = byOrderDesc("text");
  const audioTracks = byOrderDesc("audio");

  const trackProps = { assetsById, fps: project.fps, pixelsPerSecond, totalWidth };
  const divider = <div className="h-1.5 bg-surface-0" style={{ width: totalWidth + TRACK_HEADER_WIDTH }} />;

  return (
    <div className="flex flex-col h-full bg-surface-1">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border-subtle shrink-0">
        <button
          onClick={() => selectedClipId && splitClipAt(selectedClipId, useEditorStore.getState().playheadSec)}
          disabled={!selectedClipId}
          className={toolButton}
          title="Split at playhead (S)"
          aria-label="Split at playhead"
        >
          <Scissors size={14} />
        </button>
        <button onClick={() => duplicateSelectedClip()} disabled={!selectedClipId} className={toolButton} title="Duplicate (Ctrl+D)" aria-label="Duplicate">
          <Copy size={14} />
        </button>
        <button
          onClick={() => deleteSelection()}
          disabled={!selectedClipId && !selectedTextClipId}
          className={`${toolButton} hover:text-danger`}
          title="Delete (Del)"
          aria-label="Delete"
        >
          <Trash2 size={14} />
        </button>

        <div className="h-4 w-px bg-border-subtle mx-1.5" />

        <button onClick={handleAddText} className={`${toolButton} px-2`} title="Add text at playhead">
          <Type size={14} />
          Text
        </button>
        <button
          onClick={() => selectedVideoClipId && setEffectsClipId(selectedVideoClipId)}
          disabled={!selectedVideoClipId}
          className={`${toolButton} px-2`}
          title="Effects: color correction, filters (double-click a clip)"
        >
          <Sparkles size={14} />
          Effects
        </button>
        <button
          onClick={() => selectedTransitionClipId && setTransitionClipId(selectedTransitionClipId)}
          disabled={!selectedTransitionClipId}
          className={`${toolButton} px-2`}
          title="Add or edit the transition between this clip and the next"
        >
          <ArrowRightLeft size={14} />
          Transition
        </button>

        <div className="flex-1" />

        <button onClick={handleZoomToFit} disabled={duration <= 0} className={toolButton} title="Zoom to fit" aria-label="Zoom to fit">
          <Maximize size={13} />
        </button>
        <button onClick={() => setZoom(pixelsPerSecond / 1.4)} className={toolButton} title="Zoom out (Ctrl+-)" aria-label="Zoom out">
          <ZoomOut size={14} />
        </button>
        <input
          type="range"
          min={Math.log(5)}
          max={Math.log(800)}
          step={0.01}
          value={Math.log(pixelsPerSecond)}
          onChange={(e) => setZoom(Math.exp(Number(e.target.value)))}
          className="w-24 accent-accent"
          title="Zoom (Ctrl+Scroll)"
          aria-label="Timeline zoom"
        />
        <button onClick={() => setZoom(pixelsPerSecond * 1.4)} className={toolButton} title="Zoom in (Ctrl+=)" aria-label="Zoom in">
          <ZoomIn size={14} />
        </button>
      </div>

      {/* Scrollable ruler + tracks */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto relative" onClick={clearSelection}>
        <div className="sticky top-0 z-30 flex" style={{ width: totalWidth + TRACK_HEADER_WIDTH }}>
          <div className="shrink-0 bg-surface-2 border-r border-b border-border-subtle sticky left-0 z-10" style={{ width: TRACK_HEADER_WIDTH }} />
          <TimeRuler pixelsPerSecond={pixelsPerSecond} totalWidth={totalWidth} fps={project.fps} onSeek={handleSeek} />
        </div>

        <div className="relative" style={{ width: totalWidth + TRACK_HEADER_WIDTH }}>
          {videoTracks.map((track) => (
            <TimelineTrack key={track.id} track={track} {...trackProps} onEditClipEffects={setEffectsClipId} onEditTransition={setTransitionClipId} />
          ))}
          {textTracks.length > 0 && divider}
          {textTracks.map((track) => (
            <TimelineTrack key={track.id} track={track} {...trackProps} onEditTextClip={setEditingTextClipId} />
          ))}
          {divider}
          {audioTracks.map((track) => (
            <TimelineTrack key={track.id} track={track} {...trackProps} />
          ))}

          <PlayheadLine pixelsPerSecond={pixelsPerSecond} />
        </div>
      </div>

      {editingTextClipId && <TextClipPanel clipId={editingTextClipId} onClose={() => setEditingTextClipId(null)} />}
      {effectsClipId && <ClipEffectsPanel clipId={effectsClipId} onClose={() => setEffectsClipId(null)} />}
      {transitionClipId && <TransitionPanel clipId={transitionClipId} onClose={() => setTransitionClipId(null)} />}
    </div>
  );
}
