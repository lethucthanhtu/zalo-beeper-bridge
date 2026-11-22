import { describe, expect, it, vi } from 'vitest';
import { recordFileDone, waitForFileDone } from '../frame-tap.ts';
import { ZaloClient, chunkForm, pickVoiceUrls } from '../zalo-client.ts';

type Request = { url: string; init: { headers?: Record<string, string>; body?: unknown } };

/**
 * A logged-in client whose zca-js api implements `custom` the way zca-js does (a property
 * called with {ctx, utils, props}). `uploadResponse` answers voice/upload; forward returns msgId 9.
 */
function clientWith(uploadResponse: Record<string, unknown> | Error, extra: Record<string, unknown> = {}) {
  const requests: Request[] = [];
  const encoded: unknown[] = [];
  const ctx = { imei: 'imei-1', settings: { features: { sharefile: { chunk_size_file: 4 } } } };
  const utils = {
    makeURL: (base: string, params: Record<string, unknown> = {}) =>
      `${base}?${new URLSearchParams(params as Record<string, string>)}`,
    encodeAES: (text: string) => {
      encoded.push(JSON.parse(text));
      return 'enc';
    },
    request: async (url: string, init: Request['init']) => {
      requests.push({ url, init });
      return url;
    },
    resolve: async (url: string) => {
      if (url.includes('/voice/upload')) {
        if (uploadResponse instanceof Error) throw uploadResponse;
        return uploadResponse;
      }
      return { msgId: 9 };
    },
  };
  const api: Record<string, unknown> = {
    zpwServiceMap: { file: ['https://file.zalo'] },
    custom(name: string, cb: (a: unknown) => unknown) {
      api[name] = (props: unknown) => cb({ ctx, utils, props });
    },
    ...extra,
  };
  const client = new ZaloClient({ credsPath: 'unused.json', messagesPerMinute: 600, burst: 10 });
  (client as unknown as { api: unknown }).api = api;
  return { client, requests, encoded };
}

describe('ZaloClient.sendVoice', () => {
  it('uploads to voice/upload in chunks and posts the aac URL from file_done', async () => {
    const { client, requests, encoded } = clientWith({ fileId: 'f-1', finished: 1 });
    // file_done may arrive before the upload response is read
    recordFileDone({
      data: { controls: [{ content: { act_type: 'file_done', fileId: 'f-1', data: { aac: 'https://v/a.aac' } } }] },
    });
    const ids = await client.sendVoice('u1', 'user', Buffer.from('123456789'), 'voice.aac');
    expect(ids).toEqual(['9']);
    const uploads = requests.filter((r) => r.url.includes('/api/message/voice/upload'));
    expect(uploads).toHaveLength(3); // 9 bytes / chunk size 4
    expect(uploads[0]!.url).toContain('type=2');
    expect(uploads[0]!.init.headers?.['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(encoded[0]).toMatchObject({ toid: 'u1', totalChunk: 3, chunkId: 1, fileType: 'aac', totalSize: 9 });
    expect(encoded[2]).toMatchObject({ chunkId: 3 });
    const forward = encoded.at(-1) as { msgType: number; toId: string; msgInfo: string };
    expect(forward).toMatchObject({ msgType: 3, toId: 'u1' });
    expect(JSON.parse(forward.msgInfo)).toEqual({
      voiceUrl: 'https://v/a.aac',
      m4aUrl: 'https://v/a.aac',
      fileSize: 9,
    });
  });

  it('uses the group endpoint and URLs found in the upload response itself', async () => {
    const { client, requests, encoded } = clientWith({ fileId: 'f-2', amr: 'https://v/a.amr', aac: 'https://v/a.aac' });
    await client.sendVoice('g1', 'group', Buffer.from('abc'), 'voice.aac');
    expect(requests[0]!.url).toContain('/api/group/voice/upload');
    expect(requests[0]!.url).toContain('type=11');
    expect(encoded[0]).toMatchObject({ grid: 'g1' });
    const forward = encoded.at(-1) as { grid: string; msgInfo: string };
    expect(forward.grid).toBe('g1');
    expect(JSON.parse(forward.msgInfo)).toMatchObject({ voiceUrl: 'https://v/a.amr', m4aUrl: 'https://v/a.aac' });
  });

  it('falls back to the file CDN upload when voice/upload fails', async () => {
    const uploadAttachment = vi.fn().mockResolvedValue([{ fileType: 'others', fileUrl: 'https://f/x.aac' }]);
    const { client, encoded } = clientWith(new Error('code 114'), { uploadAttachment });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await client.sendVoice('u1', 'user', Buffer.from('abc'), 'voice.aac');
    expect(uploadAttachment).toHaveBeenCalled();
    const forward = encoded.at(-1) as { msgInfo: string };
    expect(JSON.parse(forward.msgInfo)).toMatchObject({ voiceUrl: 'https://f/x.aac', m4aUrl: 'https://f/x.aac' });
  });
});

describe('voice upload helpers', () => {
  it('pickVoiceUrls prefers amr as voiceUrl and aac (or url) as m4aUrl', () => {
    expect(pickVoiceUrls({ aac: 'a', amr: 'm' })).toEqual({ voiceUrl: 'm', m4aUrl: 'a' });
    expect(pickVoiceUrls({ url: 'u' })).toEqual({ voiceUrl: 'u', m4aUrl: 'u' });
    expect(pickVoiceUrls({ fileId: 1 })).toBeNull();
    expect(pickVoiceUrls(null)).toBeNull();
  });

  it('chunkForm wraps the bytes as a chunkContent file part', () => {
    const { body, headers } = chunkForm(Buffer.from('DATA'), 'voice.aac');
    const boundary = headers['content-type']!.split('boundary=')[1]!;
    const text = body.toString('latin1');
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text).toContain('name="chunkContent"; filename="voice.aac"');
    expect(text).toContain('Content-Type: application/octet-stream');
    expect(text.endsWith(`\r\n\r\nDATA\r\n--${boundary}--\r\n`)).toBe(true);
  });

  it('waitForFileDone resolves on a later file_done and times out without one', async () => {
    const later = waitForFileDone('f-9', 1000);
    recordFileDone({ data: { controls: [{ content: { act_type: 'file_done', fileId: 'f-9', data: { aac: 'x' } } }] } });
    await expect(later).resolves.toEqual({ aac: 'x' });
    await expect(waitForFileDone('never', 10)).rejects.toThrow('no file_done');
  });
});
