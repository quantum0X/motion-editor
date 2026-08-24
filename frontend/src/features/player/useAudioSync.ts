import { useEffect, useRef } from "react";
import type { Project, Clip } from "../../types/project";
import { resolveMediaUrl } from "../../utils/mediaUrl";

/**
 * useAudioSync plays sound during preview. The video elements used by
 * the canvas compositor (useCompositor.ts) are always muted - rendering
 * frames and producing audio are handled as two separate concerns, the
 * same way the export filter graph treats video and audio as separate
 * streams. This hook owns one <audio>/<video> element per audio-bearing
 * asset purely for sound, independent of whatever the compositor is
 * doing visually with its own copies.
 */
export function useAudioSync(project: Project | null, playheadSec: number, isPlaying: boolean) {
  const audioElementsRef = useRef<Map<string, HTMLMediaElement>>(new Map());

  useEffect(() => {
    if (!project) return;

    const neededAssetIds = new Set<string>();
    for (const track of project.tracks) {
      if (track.muted) continue;
      for (const clip of track.clips ?? []) {
        if (clip.muted) continue;
        neededAssetIds.add(clip.assetId);
      }
    }

    const assetsById = new Map(project.assets.map((a) => [a.id, a]));

    for (const assetId of neededAssetIds) {
      const asset = assetsById.get(assetId);
      if (!asset) continue;
      if (asset.mediaType === "image") continue; // never has audio
      if (audioElementsRef.current.has(assetId)) continue;

      const el = asset.mediaType === "audio" ? document.createElement("audio") : document.createElement("video");
      el.preload = "auto";
      audioElementsRef.current.set(assetId, el);
      resolveMediaUrl(asset.filePath)
        .then((url) => {
          el.src = url;
        })
        .catch((err) => {
          console.error(`Failed to load audio for asset ${asset.fileName}:`, err);
        });
    }

    for (const [assetId, el] of audioElementsRef.current) {
      if (!neededAssetIds.has(assetId)) {
        el.pause();
        audioElementsRef.current.delete(assetId);
      }
    }
  }, [project]);

  useEffect(() => {
    if (!project) return;

    const activeClipsByAsset = new Map<string, Clip>();
    for (const track of project.tracks) {
      if (track.muted) continue;
      for (const clip of track.clips ?? []) {
        if (clip.muted) continue;
        if (playheadSec >= clip.timelineStartSec && playheadSec < clip.timelineEndSec) {
          activeClipsByAsset.set(clip.assetId, clip);
        }
      }
    }

    for (const [assetId, el] of audioElementsRef.current) {
      const activeClip = activeClipsByAsset.get(assetId);

      if (!activeClip) {
        el.pause();
        continue;
      }

      el.volume = Math.min(1, Math.max(0, activeClip.volume ?? 1));
      const sourceTime = activeClip.sourceInSec + (playheadSec - activeClip.timelineStartSec) * (activeClip.speed || 1);

      if (!isPlaying) {
        el.pause();
        if (Math.abs(el.currentTime - sourceTime) > 0.08) el.currentTime = sourceTime;
      } else {
        if (Math.abs(el.currentTime - sourceTime) > 0.25) el.currentTime = sourceTime;
        el.play().catch(() => {});
      }
    }
  }, [project, playheadSec, isPlaying]);
}
