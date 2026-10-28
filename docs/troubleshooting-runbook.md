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

## Rolling back a deploy (container)

Before each risky deploy, keep three things (the multi-account deploy of 2026-10-28 kept `localhost/zalo-beeper-bridge:rollback-pre-v7`, git tag `rollback/pre-multi-account`, and `/data/bridge.db.bak-pre-v7`):

```bash
podman tag "$(podman inspect zalo-beeper-bridge --format '{{.Image}}')" localhost/zalo-beeper-bridge:rollback-<name>
git tag -a rollback/<name> -m "last deployed state"
podman exec zalo-beeper-bridge node -e "new (require('/app/node_modules/better-sqlite3'))('/data/bridge.db',{readonly:true}).backup('/data/bridge.db.bak-<name>')"
podman exec zalo-beeper-bridge chmod 600 /data/bridge.db.bak-<name>
```

**Roll back the code** (normal case — the database stays as it is):

```bash
podman tag localhost/zalo-beeper-bridge:rollback-<name> localhost/zalo-beeper-bridge:latest
podman compose up -d --no-build --force-recreate
git switch --detach rollback/<name>   # so the next build does not bring the change back
```

Schema migrations are additive, so older code runs on a newer database. Verified for v7 → v6 on a copy of the live database: the v6 code reads and writes normally, and its new rows simply have no `account_id` until the newer code runs again. On the next start the older code also re-sends each portal's `m.bridge` state without `fi.mau.receiver`.

**Restore the database** (only if it is damaged — messages bridged since the backup lose their mapping, so replies/reactions to them stop working):

```bash
podman compose stop
podman run --rm -v zalo-beeper-bridge_zalo-data:/data --entrypoint sh localhost/zalo-beeper-bridge:latest   -c 'cd /data && rm -f bridge.db-wal bridge.db-shm && cp bridge.db bridge.db.broken && cp bridge.db.bak-<name> bridge.db'
podman compose up -d
```

## Upgrading zca-js

Zalo Web changes can break zca-js. When bumping the pinned version: `npm test` (normalizer fixtures), then a manual smoke test (send/receive text + image). All zca-js usage is isolated in `src/zalo/zalo-client.ts`.

## Network name still shows "sh-zalo"

The bot profile is "Zalo" and portals carry the network branding, but the top-level network label is fixed to the bbctl registration name. Renaming it is not supported from a custom appservice (see the investigation report under `plans/.../reports/`).
