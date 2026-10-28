# Troubleshooting Runbook

Quick checks: `launchctl list | grep beeper-zalo` (both should show exit 0), `tail -f logs/bridge.log`.

## Messages stop flowing / listener not connected

`logs/bridge.log` shows reconnecting or a `dead` message.

- **You opened Zalo Web in a browser.** Zalo allows one web session; it kicked the bridge. Close Zalo Web; the listener auto-reconnects (backoff up to 5 min). Use the phone app alongside the bridge, not Zalo Web.
- **Cookie/session expired.** Send `login` to the bot in Beeper and scan the QR again.
- **`[zalo] listener DEAD`.** Session unusable — send `login` to re-authenticate.

## "Suspected ban" / account locked

If Zalo throttles or locks the account, sends fail and the log shows repeated auth errors. Stop the bridge (`launchctl unload …`), log into Zalo normally on your phone to clear any security prompt, then reload. Lower `messagesPerMinute`/`burst` in `config.yaml` if it recurs.

## Images / media won't send

- Check `logs/bridge.log` for `Failed to send … to Zalo`.
- Media over the size cap (`bridge.mediaMaxBytes`, default 10 MB) is rejected — raise the cap or send smaller.
- Voice notes are delivered as file attachments (Zalo's native voice bubble needs a URL the bridge can't provide).

## Images stuck "loading" in Beeper (mostly older ones)

Not a bridge problem: the bridge uploaded them fine. Beeper serves media by redirecting to object storage — recent uploads to Cloudflare R2, older ones to Wasabi S3 (`s3.eu-central-1.wasabisys.com`). From some networks (seen on VNPT, Vietnam) the route to Wasabi loses packets, so TLS takes 1–15 s or times out and the client keeps spinning.

- Confirm: open Beeper on another network (4G, Cloudflare WARP / VPN) — old images then load.
- Measure: `curl -s -o /dev/null -w '%{time_appconnect}s
' https://s3.eu-central-1.wasabisys.com/` (healthy: well under 1 s).
- Fix: only Beeper can change where media is stored — report "media redirect to Wasabi eu-central-1 times out from <ISP/country>" to Beeper support. Images that loaded once stay cached in the client.

## `[Zalo video / file could not be bridged: …]` notice

The notice keeps the Zalo link; the log line `[media] download from <host> failed: <reason>` says why.

- `refusing media host outside Zalo CDN (<host>)` — Zalo moved media to a new CDN domain. Check the redirect chain (`curl -sI <link>`) and, if it is Zalo's, add the domain to `ALLOWED_HOST_SUFFIXES` in `src/bridge/media-handler.ts` (the 2026-10 move was `dlmd.me` → `mdchat.me`, `dlfl.vn` → `flchat.vn`).
- `HTTP 403/404` or `error page` — the link expired (Zalo CDN links last ~14 days).
- `media exceeds size cap` — videos/files are capped at 100 MB, photos at `bridge.mediaMaxBytes`.
- timeout — videos/files get 180 s, photos 30 s.

## `[Zalo message type not supported by bridge: <type>]`

The log has `[bridge] unsupported Zalo msgType <type> (content keys: …)` with the payload's field **names** only. With the user's permission, read one such payload from `bridge.db` (`message.quote_json` of that chat, filtered by `msg_type`) and add a case to `normalizeContent` in `src/zalo/event-normalizer.ts`, with an anonymized fixture in its test.

## Recall didn't reach Zalo

Only messages **you sent from Beeper** can be recalled (Zalo only lets you recall your own), and only within Zalo's recall time window. Recalling someone else's message does nothing on Zalo.

## Bridge won't start (launchd exit code non-zero)

- `launchctl list | grep beeper-zalo` shows a non-zero exit code.
- Check `logs/bridge.log` for the stack. Common causes: `config.yaml` missing/invalid (copy from `config.yaml.example`), wrong Node path in the plist (update after an nvm upgrade), or `registration.yaml` missing (`bbctl register sh-zalo`).

## Upgrading zca-js

Zalo Web changes can break zca-js. When bumping the pinned version: `npm test` (normalizer fixtures), then a manual smoke test (send/receive text + image). All zca-js usage is isolated in `src/zalo/zalo-client.ts`.

## Network name still shows "sh-zalo"

The bot profile is "Zalo" and portals carry the network branding, but the top-level network label is fixed to the bbctl registration name. Renaming it is not supported from a custom appservice (see the investigation report under `plans/.../reports/`).
