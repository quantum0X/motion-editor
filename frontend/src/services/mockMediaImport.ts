import { v4 as uuidv4 } from "uuid";
import type { MediaAsset, MediaType } from "../types/project";
import { objectUrlToFileNameLookup } from "./objectUrlRegistry";

/**
 * Dev-only helper: given an object URL (created from a File the user
 * dropped/selected in the browser), determine its MediaAsset metadata
 * using real <video>/<img>/<audio> elements, since ffprobe isn't
 * available in a browser context. The real Wails app uses
 * backend/media/service.go instead, which calls actual ffprobe — this
 * file exists purely so the frontend can be developed and demoed
 * standalone (see mockBackend.ts).
 */

function detectMediaType(fileName: string): MediaType {
  const ext = fileName.toLowerCase().split(".").pop() || "";
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(ext)) return "image";
  if (["mp3", "wav", "aac", "flac", "ogg", "m4a"].includes(ext)) return "audio";
  return "video";
}

export async function probeAssetFromObjectUrl(objectUrl: string, fileName?: string, fileSizeBytes = 0): Promise<MediaAsset> {
  const name = fileName || objectUrlToFileNameLookup(objectUrl) || objectUrl.split("/").pop() || "untitled";
  const mediaType = detectMediaType(name);
  const now = new Date().toISOString();

  if (mediaType === "video") {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = objectUrl;
      video.onloadedmetadata = () => {
        resolve({
          id: uuidv4(),
          fileName: name,
          filePath: objectUrl,
          thumbnailPath: objectUrl, // dev mode: the video element itself can render a poster frame; see MediaThumbnail.tsx
          mediaType,
          durationSec: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          fps: 30, // browsers don't expose real fps via the video element; assumed default in dev mode only
          sampleRate: 0,
          channels: 0,
          fileSizeBytes,
          importedAt: now,
        });
      };
      video.onerror = () => {
        const mediaError = video.error;
        reject(new Error(`Could not read video metadata for ${name} (code=${mediaError?.code}, message=${mediaError?.message})`));
      };
    });
  }

  if (mediaType === "image") {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = objectUrl;
      img.onload = () => {
        resolve({
          id: uuidv4(),
          fileName: name,
          filePath: objectUrl,
          thumbnailPath: objectUrl,
          mediaType,
          durationSec: 0,
          width: img.naturalWidth,
          height: img.naturalHeight,
          fps: 0,
          sampleRate: 0,
          channels: 0,
          fileSizeBytes,
          importedAt: now,
        });
      };
      img.onerror = () => reject(new Error(`Could not read image metadata for ${name}`));
    });
  }

  // audio
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = objectUrl;
    audio.onloadedmetadata = () => {
      resolve({
        id: uuidv4(),
        fileName: name,
        filePath: objectUrl,
        thumbnailPath: "",
        mediaType,
        durationSec: audio.duration,
        width: 0,
        height: 0,
        fps: 0,
        sampleRate: 44100,
        channels: 2,
        fileSizeBytes,
        importedAt: now,
      });
    };
    audio.onerror = () => reject(new Error(`Could not read audio metadata for ${name}`));
  });
}
