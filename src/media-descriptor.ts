// What a Zalo attachment or link card looks like before it reaches Matrix. Shared by the
// Zalo event normalizer and the bridge/importer renderers; kept at the src root so zalo/
// does not import from bridge/.

export type MediaKind = 'image' | 'sticker' | 'video' | 'file' | 'audio';

/** A Zalo attachment: where it may be downloaded from plus what Matrix wants to know. */
export type MediaDescriptor = {
  kind: MediaKind;
  /** candidate download URLs, best first (may all be expired) */
  urls: string[];
  filename?: string;
  caption?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  size?: number;
  /** Zalo sticker id — stickers are cached per id */
  stickerId?: number;
  /** voice-note waveform scaled to 0–1024 (MSC3246), from Zalo's waveformSamples */
  waveform?: number[];
};

/** Most waveform bars sent with a voice note. */
const MAX_WAVEFORM_POINTS = 100;

/**
 * Zalo's voice `waveformSamples` (amplitudes, a JSON array or array-like string) scaled
 * to the 0–1024 range Matrix voice bubbles expect (MSC3246); the loudest sample maps
 * to 1024, and long sample lists are reduced to MAX_WAVEFORM_POINTS peaks. Returns
 * undefined when there are no usable samples.
 */
export function toMatrixWaveform(samples: unknown): number[] | undefined {
  let values: unknown = samples;
  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(values)) return undefined;
  const amplitudes = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  const loudest = Math.max(0, ...amplitudes);
  if (!amplitudes.length || loudest === 0) return undefined;
  // Keep events small: at most MAX_WAVEFORM_POINTS bars (MSC3246 suggests ~30–120),
  // each the peak of its slice of samples
  const points = Math.min(amplitudes.length, MAX_WAVEFORM_POINTS);
  return Array.from({ length: points }, (_, index) => {
    const slice = amplitudes.slice(
      Math.floor((index * amplitudes.length) / points),
      Math.floor(((index + 1) * amplitudes.length) / points),
    );
    return Math.round((Math.max(...slice) / loudest) * 1024);
  });
}

/** Zalo link card → Beeper link preview. */
export type LinkPreview = {
  /** the URL as it appears in the message body */
  url: string;
  title?: string;
  description?: string;
  /** preview thumbnail on the Zalo CDN (may be expired) */
  imageUrl?: string;
};
