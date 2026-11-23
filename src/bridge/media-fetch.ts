// Guarded media transfer primitives: capped Zalo CDN downloads (https, host allowlist on every
// redirect hop) and the authenticated Matrix media download used for outbound sends.
// Leaf module (no bridge imports) so media-handler, media-content and animated-sticker can all
// use it without an import cycle.
const FETCH_TIMEOUT_MS = 30_000;
// Media URLs come from message payloads (contact-influenced input) — restrict
// to Zalo CDN hosts over https to close SSRF toward localhost/LAN.
// dlmd.me / dlfl.vn are Zalo's signed video / file download CDNs; they 301 to
// mdchat.me / flchat.vn (then 302 to an edge node there), so both must be allowed.
/** Zalo's public emoticon API (sticker images and sprite strips; no session needed). */
export const ZALO_EMOTICON_API = 'https://zalo-api.zadn.vn/api/emoticon';

const ALLOWED_HOST_SUFFIXES = ['.zdn.vn', '.zadn.vn', '.dlmd.me', '.dlfl.vn', '.mdchat.me', '.flchat.vn'];

/** A CDN answer with a non-2xx status; `status` tells an expired link (4xx) from a server hiccup (5xx). */
export class MediaHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`media download failed: HTTP ${status}`);
    this.name = 'MediaHttpError';
    this.status = status;
  }
}

/** Downloaded bytes plus the server-declared mimetype (parameters stripped). */
type FetchedMedia = {
  buffer: Buffer;
  mimetype: string;
};

/**
 * Real media type from magic bytes — Zalo CDNs mislabel (GIFs as image/jpeg, stickers unlabelled).
 *
 * @param buffer - File contents (only the first few bytes are inspected).
 * @param fallback - Declared mimetype; returned when no signature matches. For ISO-BMFF
 *   (`ftyp`) containers an `audio/*` fallback is kept, since the same box marks m4a audio.
 * @returns The sniffed mimetype, or `fallback`.
 */
export function sniffMimetype(buffer: Buffer, fallback: string): string {
  /** Bytes [start, end) as a latin1 string, for comparing ASCII signatures. */
  const asciiAt = (start: number, end: number) => buffer.subarray(start, end).toString('latin1');
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (asciiAt(1, 4) === 'PNG') return 'image/png';
  if (asciiAt(0, 4) === 'GIF8') return 'image/gif';
  if (asciiAt(0, 4) === 'RIFF' && asciiAt(8, 12) === 'WEBP') return 'image/webp';
  if (asciiAt(4, 8) === 'ftyp')
    return asciiAt(8, 10) === 'qt' ? 'video/quicktime' : fallback.startsWith('audio/') ? fallback : 'video/mp4';
  if (asciiAt(0, 4) === '%PDF') return 'application/pdf';
  // Zalo voice notes are raw ADTS AAC served as image/jpeg
  if (buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xf6) === 0xf0) return 'audio/aac';
  if (asciiAt(0, 3) === 'ID3' || (buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (asciiAt(0, 5) === '#!AMR') return 'audio/amr';
  if (asciiAt(0, 4) === 'OggS') return 'audio/ogg';
  return fallback;
}

/**
 * Download Matrix media (mxc://) via the authenticated media endpoint.
 * Beeper serves media behind auth + a redirect to R2; matrix-bot-sdk's
 * downloadContent forwards the Authorization header to R2 and gets a 400.
 * Native fetch strips auth on the cross-origin redirect, so it works.
 *
 * @param homeserverUrl - Homeserver base URL.
 * @param accessToken - Token sent as Bearer auth (the appservice token).
 * @param mxcUrl - `mxc://<server>/<mediaId>` URL to download.
 * @param maxBytes - Streamed size cap; the download aborts once exceeded.
 * @param timeoutMs - Hard timeout for the whole request (default FETCH_TIMEOUT_MS); large
 *   files need longer.
 * @returns The bytes and the response mimetype (`application/octet-stream` when absent).
 * @throws On a malformed mxc URL, non-2xx answer, empty body, timeout or size cap.
 */
export async function downloadMatrixMedia(
  homeserverUrl: string,
  accessToken: string,
  mxcUrl: string,
  maxBytes: number,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<FetchedMedia> {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcUrl);
  if (!match) throw new Error(`bad mxc url: ${mxcUrl}`);
  const [, server, mediaId] = match;
  const url = `${homeserverUrl}/_matrix/client/v1/media/download/${server}/${mediaId}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`matrix media download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error('matrix media download returned no body');
  return readCapped(response, maxBytes);
}

/**
 * Streams a response body into memory with a hard size cap (content-length can be spoofed,
 * so it is never trusted for allocation).
 *
 * @returns the bytes and the declared mimetype (parameters stripped; `application/octet-stream` when absent)
 * @throws once more than `maxBytes` arrive
 */
export async function readCapped(response: Response, maxBytes: number): Promise<FetchedMedia> {
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > maxBytes) throw new Error(`media exceeds size cap (>${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  return {
    buffer: Buffer.concat(chunks),
    mimetype: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
  };
}

/** Redirect hops a media download may follow (each one re-checked against the allowlist). */
const MAX_REDIRECTS = 5;

/**
 * Throws unless `url` is an https URL on an allowlisted Zalo CDN host.
 * @throws Error naming the rejected protocol or host
 */
export function assertZaloMediaUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`refusing non-https media URL (${parsed.protocol})`);
  if (!ALLOWED_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))) {
    throw new Error(`refusing media host outside Zalo CDN (${parsed.hostname})`);
  }
}

/**
 * Guarded download: https-only, Zalo CDN hosts (on every redirect hop), hard timeout,
 * streamed byte cap.
 *
 * @param url - Zalo CDN media URL (untrusted, from a message payload).
 * @param maxBytes - Streamed size cap; the download aborts once exceeded.
 * @param timeoutMs - Hard timeout for the whole request, redirects included.
 * @returns The bytes and the declared mimetype (`application/octet-stream` when absent);
 *   callers should still run {@link sniffMimetype} since Zalo mislabels media.
 * @throws On a non-https URL or a host outside ALLOWED_HOST_SUFFIXES (also for a redirect
 *   target), more than MAX_REDIRECTS hops, non-2xx answer, empty body, an HTML/JSON error
 *   page, timeout or the size cap.
 */
export async function fetchMediaCapped(
  url: string,
  maxBytes: number,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<FetchedMedia> {
  // Redirects are followed by hand so every hop passes the https + Zalo-host check —
  // fetch's automatic following would let a CDN redirect reach any host (SSRF)
  const signal = AbortSignal.timeout(timeoutMs);
  let currentUrl = url;
  let response: Response;
  for (let hop = 0; ; hop++) {
    assertZaloMediaUrl(currentUrl);
    response = await fetch(currentUrl, { signal, redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    await response.body?.cancel(); // release the redirect response's connection
    if (hop >= MAX_REDIRECTS) throw new Error(`media download: too many redirects (>${MAX_REDIRECTS})`);
    currentUrl = new URL(location, currentUrl).toString();
  }
  if (!response.ok) throw new MediaHttpError(response.status);
  if (!response.body) throw new Error('media download returned no body');
  // Expired links can answer 200 with an HTML/JSON error page instead of the media
  if (/^(text\/html|application\/json)/.test(response.headers.get('content-type') ?? '')) {
    throw new Error('media download returned an error page');
  }
  return readCapped(response, maxBytes);
}
