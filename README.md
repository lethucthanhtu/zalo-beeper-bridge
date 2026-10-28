# zalo-beeper-bridge

A self-hosted [Matrix](https://matrix.org/) application service that bridges a personal **Zalo** account into **[Beeper](https://www.beeper.com/)** (or any Matrix homeserver). Built on Node.js + TypeScript, [`zca-js`](https://github.com/RFS-ADRENO/zca-js) (unofficial Zalo Web API) and [`matrix-appservice-bridge`](https://github.com/matrix-org/matrix-appservice-bridge), connected to Beeper through [`bbctl`](https://github.com/beeper/bridge-manager).

It also ships a **history importer** that moves your full Zalo history (from Zalo PC and its encrypted `.zl.zip` backup) into Beeper with original timestamps, real media, replies and mentions — see [Importing Zalo history](#importing-zalo-history).

> **⚠️ Unofficial & at your own risk.** `zca-js` talks to Zalo Web by reverse engineering, which violates Zalo's ToS and **can get your account locked or banned**. There is no official personal-messaging API for Zalo. Use a dedicated/secondary account if you are not willing to risk your main one. This project is an enthusiast tool, not a supported product.

## Features

| Area                             |                      Zalo → Beeper                       |                Beeper → Zalo                |
| -------------------------------- | :------------------------------------------------------: | :-----------------------------------------: |
| Text (DM + group)                |                            ✅                            |                     ✅                      |
| @mentions                        |                        ✅ (pills)                        |                     ✅                      |
| Replies / quotes                 |                            ✅                            |                     ✅                      |
| Photos                           |                            ✅                            |                     ✅                      |
| Stickers                         | ✅ animated (`m.sticker`, WebP built from Zalo's sprite) |                      —                      |
| GIFs                             |                            ✅                            |                      —                      |
| Videos                           |                      ✅ (`m.video`)                      |                     ✅                      |
| Files                            |                      ✅ (`m.file`)                       |                     ✅                      |
| Voice messages                   |                ✅ (`m.audio` voice note)                 |             ✅ (sent as a file)             |
| Link cards                       |              ✅ text + Beeper link preview               |                      —                      |
| Reactions                        |                            ✅                            |                     ✅                      |
| Message recall                   |                            —                             |                     ✅                      |
| Read receipts                    |                            ✅                            |                     ✅                      |
| Typing indicators                |                            ✅                            | disabled (handler kept, see `src/index.ts`) |
| Own messages sent from the phone |                   ✅ (double-puppeted)                   |                     n/a                     |
| End-to-end encrypted Zalo chats  |            notice only (cannot be decrypted)             |                      —                      |

Live videos / files / voice / GIFs and link previews share their rendering with the history importer, where it was verified on real chats; for live messages they are covered by unit tests of the payload parsing.

Plus: ghost users with real names + avatars, portal rooms auto-created on first message, a `sync` command for pinned conversations and groups, Zalo network branding (name + logo), listener auto-reconnect with ban-suspicion pause, conservative outbound rate limiting, encrypted credential storage at rest, and the [history importer](#importing-zalo-history).

**Not implemented:** Zalo→Beeper recall & edit sync, E2EE bridging, live backfill of history from Zalo's servers (Zalo Web exposes none from before login — use the importer).

## Requirements

- macOS or Linux, or Windows with Docker/Podman (see [container deployment](docs/container-deployment.md))
- Node.js 22+ (uses native TypeScript execution — no build step)
- A Beeper account and [`bbctl`](https://github.com/beeper/bridge-manager)
- `ffmpeg` and Python 3 (bbctl prerequisites)
- A Zalo account you can log in to by scanning a QR code
- For the history importer: Zalo PC (Windows/macOS desktop app), optionally a Zalo PC backup file

## Setup

### 1. Install and register with Beeper

```bash
# Install bbctl (macOS arm64 shown; see releases for your platform)
curl -sL -o ~/.local/bin/bbctl \
  https://github.com/beeper/bridge-manager/releases/latest/download/bbctl-macos-arm64
chmod +x ~/.local/bin/bbctl

bbctl login                              # log in to your Beeper account
bbctl register -o registration.yaml sh-zalo
```

Edit the generated `registration.yaml` and set the `url` field to the local port the bridge listens on:

```yaml
url: http://localhost:29350
```

### 2. Configure the bridge

```bash
npm install
cp config.yaml.example config.yaml
```

Fill in `config.yaml` with the values printed by `bbctl register` (homeserver URL, domain, your Beeper Matrix ID):

```yaml
matrix:
  homeserverUrl: https://matrix.beeper.com/_hungryserv/<your-beeper-username>
  domain: beeper.local
  registrationPath: registration.yaml
  port: 29350
  owner: '@<your-beeper-username>:beeper.com'
zalo:
  credsPath: zalo-creds.session.json # encrypted at rest; never commit
  messagesPerMinute: 8 # conservative pacing to protect the account
bridge:
  dbPath: bridge.db
  mediaMaxBytes: 10485760 # photos / stickers / previews; videos & files allow up to 100 MB
logging:
  level: info
```

### 3. Run

Run the bridge and the bbctl proxy side by side (two terminals, or a process manager):

```bash
npm run dev                               # the appservice on localhost:29350
bbctl proxy -r registration.yaml          # proxies Beeper <-> the bridge over a websocket
```

### Or: run it in a container (Docker / Podman)

`compose.yaml` runs the bridge **and** `bbctl proxy` in one container — see [docs/container-deployment.md](docs/container-deployment.md):

```bash
mkdir container-config && cp config.yaml registration.yaml container-config/
cp ~/.config/bbctl/config.json container-config/bbctl-config.json
docker compose up -d --build        # or: podman compose up -d --build
```

The bridge's state (`bridge.db`, the encrypted Zalo session) lives on the `zalo-data` named volume (`/data` in the container). Rebuilding/recreating the container keeps it.

### 4. Log in to Zalo

In Beeper, open a chat with the bridge bot `@sh-zalobot:beeper.local` and send:

```
login
```

Scan the QR image it posts with the Zalo app on your phone and confirm. Once you see the listener connect, message the account from another Zalo user and the chat appears in Beeper.

> **Single-listener constraint:** Zalo Web allows only one active session. If you open Zalo Web in a browser while the bridge runs, the bridge listener is kicked. Use the phone app (and Zalo PC) alongside the bridge, not Zalo Web.

## Bot commands

Send these to the bridge bot in its management chat (owner only):

| Command  | Action                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ping`   | health check (`pong` + uptime)                                                                                                   |
| `login`  | start QR login to Zalo                                                                                                           |
| `logout` | log out and clear saved credentials                                                                                              |
| `status` | login state, listener state, uptime                                                                                              |
| `sync`   | create rooms for pinned chats + every group, fill empty rooms with the history Zalo allows this session (none from before login) |

## Importing Zalo history

Zalo Web (and therefore the live bridge) cannot fetch messages from before the session started. The history importer fills Beeper from **Zalo PC's local message store** instead, optionally enriched with media from a **Zalo PC backup** (`.zl.zip`). Each chat is rebuilt as a new Beeper room with the complete history in order; the bridge is then pointed at the new room and the old one is deleted — only after the new room has been verified.

### Quick start (Windows, one command)

```powershell
pwsh scripts/zalo-pc/import.ps1
```

It checks the bridge and Beeper, (re)starts Zalo PC with the local debug port (asks before closing it), lists your chats **by name** and lets you pick them (`1,3,5-8`, `groups`, `dms` or `all`), then runs Step 3 below and prints an OK / FAIL summary. Re-running skips chats already done. Options: `-Chats g123,4567` (no picker), `-MediaDir /data/import-media` (backup media from Step 2), `-OwnUid <uid>`. Exports land in `work/` (gitignored — it holds your messages). The sections below describe what it automates.

### What gets imported, and how it looks

Imported messages are rendered exactly like live ones (`src/bridge/media-content.ts` is shared):

| Zalo message                                          | In Beeper                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| Text, rich text                                       | `m.text`, @mentions as pills, Zalo quotes as real Matrix replies     |
| Photo                                                 | `m.image` (JPEG XL photos are converted to JPEG)                     |
| Sticker                                               | animated WebP `m.sticker` (still PNG for single-frame stickers)      |
| GIF                                                   | `m.image` `image/gif`                                                |
| Video / file / voice                                  | `m.video` / `m.file` / `m.audio` voice note                          |
| Link card                                             | text + `com.beeper.linkpreviews` (title, description, thumbnail)     |
| Location, call log, system rows (pins, joins, polls…) | readable text / notice                                               |
| Media whose bytes no longer exist anywhere            | a text line, e.g. `📷 [Ảnh 1920×1080 — không còn trên máy chủ Zalo]` |

Where media comes from, in order: the backup copy (if prepared), then the Zalo CDN. **Zalo CDN links for photos, videos, files and voice expire about 14 days after sending**; Zalo Cloud (`zpcloud`/`zfcloud`), GIF and sticker hosts are permanent. Old media therefore only survives through the backup, which holds the media Zalo PC had downloaded.

Other behaviour worth knowing:

- **Duplicates removed:** Zalo PC keeps a second local row (`msgId_NNN`, same `cliMsgId` + type) for some of your own messages; those shadow copies are dropped. `_NNN` rows without a real twin are kept — they are the only copy.
- **Nothing live is lost:** messages the live bridge delivered that Zalo PC never stored, or that arrive while a chat is being rebuilt, are replayed from the old room's Matrix events at their original position before the switch.
- **Silent:** `send_notification:false`, marked read for you, and marked so the live bridge never sends imported messages back to Zalo.
- **Message mappings kept:** replies, reactions, recall and read receipts keep working on imported messages.

### Step 1 — Run Zalo PC with a local debug port

The tools read Zalo PC's own (already decrypted) data over the Chrome DevTools Protocol on `127.0.0.1` only. Quit Zalo PC completely, then start it with:

```powershell
& "$env:LOCALAPPDATA\Programs\Zalo\Zalo-<version>\Zalo.exe" --remote-debugging-port=9229
```

Only what Zalo PC holds locally can be imported: the more history Zalo PC has, the more ends up in Beeper.

### Step 2 — (optional) Prepare media from a Zalo PC backup

Create the backup in Zalo PC: **Cài đặt → Sao lưu & đồng bộ → Xuất dữ liệu** (Settings → Backup & sync → Export data). It produces `backup_zalo_<date>.zl.zip`, a tar stream encrypted with AES-256-CBC: key = SHA-256 of the session UIN (the login `dkey`), IV = `"zie"` + the first 13 characters of the UIN. The UIN is only available from the running, logged-in Zalo PC that made the backup.

```bash
npm install                                    # dev dependencies (@jsquash JXL/JPEG codecs)

# 1. read the backup key (SECRET — anyone holding it can decrypt your backups)
node scripts/zalo-pc/get-uin.mjs > ~/zalo-uin.txt

# 2. check the key, then extract database + media (the backup file is only read)
node scripts/zalo-pc/backup-extract.mjs backup_zalo_22_10_2026.zl.zip ~/zalo-uin.txt work/backup --peek
node scripts/zalo-pc/backup-extract.mjs backup_zalo_22_10_2026.zl.zip ~/zalo-uin.txt work/backup --all
rm ~/zalo-uin.txt

# 3. map media files to messages, decode obfuscated files, convert JPEG XL → JPEG
node scripts/zalo-pc/backup-media.mjs work/backup/<yourZaloUid>/ZaloDownloads <yourZaloUid> work/media
```

`<yourZaloUid>` is the top-level folder inside the extracted backup. `backup-media.mjs` writes `work/media/<msgId>.<ext>` and `work/media/media-index.json`; files that are not readable (e.g. Intune-encrypted attachments) are skipped and fall back to text. Copy the folder into the container:

```bash
tar -C work/media -cf - . | podman exec -i zalo-beeper-bridge sh -c 'mkdir -p /data/import-media && tar -C /data/import-media -xf - && chown -R node:node /data/import-media'
```

The backup's message database (`*_zmessage.zdb`) is plain NDJSON of the same rows Zalo PC holds, so it adds no extra history if Zalo PC is the machine that made it.

### Step 3 — Export and import

`scripts/zalo-pc/migrate-all.sh` does everything chat by chat: a fresh export of the chat from Zalo PC, then `--rebuild --remove-old` inside the container. It waits while Beeper or Zalo PC is unreachable, records `OK <key>` / `FAIL <key>` in `<workDir>/done.txt` and skips chats already OK on a re-run — failed chats keep their old room and can simply be re-run.

```bash
# order: one thread key per line — "g<groupId>" for groups, the peer uid for DMs.
# Get every key with an export first:
node scripts/zalo-pc/export-cdp.mjs work/export
ls work/export/*.ndjson | xargs -n1 basename | sed 's/\.ndjson$//' > work/order.txt   # reorder as you like

scripts/zalo-pc/migrate-all.sh work work/order.txt <yourZaloUid> /data/import-media
tail -f work/run.log
```

The script runs the importer baked into the image (`/app/src/tools/import-zalo-export.ts`) — rebuild the image after updating the code.

### The importer CLI

`src/tools/import-zalo-export.ts` runs next to the live bridge (same config, registration and `bridge.db`); it only initialises appservice intents, never listens, and makes no Zalo API calls. Run it inside the container from `/data`:

```bash
podman exec -u node -w /data zalo-beeper-bridge node /app/src/tools/import-zalo-export.ts <exportDir> [options]
```

| Option                       | Meaning                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--only k1,k2`               | limit to these thread keys (required for `--rebuild`)                                                                        |
| `--dry-run [--probe]`        | print per-chat counts by kind; `--probe` actually tries every download (no upload)                                           |
| `--rebuild`                  | new room per chat with the full ordered history, live-only messages carried over, then repoint the thread                    |
| `--remove-old`               | with `--rebuild`: verify the new room, then delete the superseded room                                                       |
| `--carry-from !r1,!r2`       | with `--rebuild`: also keep live-only messages from these earlier rooms of the thread                                        |
| `--verify`                   | read-only: every export message is mapped to the chat's room and every mapped message is a real event in its Beeper timeline |
| `--retire !old1,!old2`       | verify one `--only` chat, then delete these superseded rooms                                                                 |
| `--media-dir DIR`            | backup media prepared by `backup-media.mjs`                                                                                  |
| `--own-uid UID`              | your Zalo uid (mentions of you become pills for your account)                                                                |
| `--batch N` / `--delay-ms N` | batch size (100) and pause between batches (1500 ms)                                                                         |
| `--media-days N`             | try expiring CDN links only for messages younger than N days (16)                                                            |

Without `--rebuild` the importer runs in **prepend** mode: it only adds history older than the room's first bridged message (Beeper's batch-send API can only insert before the oldest or after the newest event — never in the middle), so use `--rebuild` whenever messages are missing between ones already in Beeper.

### History import troubleshooting

- **`Zalo main window not found`** — Zalo PC is not running with `--remote-debugging-port=9229`, or it is still starting.
- **`bad tar header — wrong UIN`** — the key does not belong to this backup: read it from the Zalo PC session/account that created the backup.
- **A chat ends `FAIL`** — its old room is untouched and any half-built room is deleted automatically; look at `run.log` and re-run the script (it skips chats already OK).
- **`WARNING … live message(s) could not be carried over`** — a live-only message's Matrix event could not be read; the old room is then not removed.
- **Photos / videos as text lines** — the CDN copy expired and the backup has no copy; nothing else holds the bytes.

## Architecture

```
Zalo servers                              Zalo PC (+ .zl.zip backup)
   │  zca-js: QR login, listener             │  CDP export / backup tools (scripts/zalo-pc)
   ▼                                         ▼
src/zalo/*        normalized events      src/tools/import-zalo-export.ts   history importer
   ▼                                         │  src/bridge/history-import.ts  export row → event
src/bridge/*      portals, ghosts, SQLite mapping store, echo suppression,
                  inbound/outbound, presence, media-content (shared rendering),
                  animated-sticker, mentions, sync
   ▼
src/matrix/*      matrix-appservice-bridge (Bridge + Intents), network branding, bot commands
   ▼
bbctl proxy  ──►  Beeper Matrix server  ──►  Beeper clients
```

- **Mapping store** (`better-sqlite3`): portals, puppets, and messages keyed by Zalo `msgId` → Matrix event, with `cliMsgId` / quote / direction / sender for reactions, recall and receipts.
- **Shared media rendering** (`src/bridge/media-content.ts`): one code path builds `m.image` / `m.video` / `m.file` / `m.audio` / `m.sticker` events and link previews for both live messages and the importer.
- **Animated stickers** (`src/bridge/animated-sticker.ts`): Zalo returns no animated sticker URL for classic stickers; like Zalo PC, the bridge steps through the public sprite strip and encodes a looping WebP (libwebp via `wasm-webp`), with frame timing from `assets/zalo-sticker-timing.json`.
- **Echo suppression:** outbound sends are matched against their own `selfListen` echo (by `msgId`, with a content/URL fallback) so the bridge never re-posts what you just sent.
- **Double-puppeting:** on Beeper's single-tenant hungryserv the appservice token can act as the owner, so messages you send from the Zalo phone app appear in Beeper on the right-hand side.

## Development

```bash
npm run typecheck     # tsc, strict, no emit
npm run lint          # eslint (flat config)
npm test              # vitest
```

Source lives under `src/` (ESM TypeScript run directly by Node 22+). All `zca-js` runtime usage is confined to `src/zalo/zalo-client.ts` so upstream breakage is contained to one module. History-import tooling that runs on the desktop (not in the container) lives in `scripts/zalo-pc/`.

On Windows, regenerate `package-lock.json` on Linux after changing dependencies (`npm install` on Windows drops the Linux-only optional entries and the image's `npm ci` then fails):

```bash
podman run --rm -v "$PWD:/w" -w /w docker.io/library/node:24-bookworm-slim npm install --package-lock-only --ignore-scripts
```

## Security & privacy

- Zalo session credentials are stored **AES-256-GCM encrypted** at rest (`src/zalo/credential-store.ts`), with the key in a sibling `0600` file. Never commit `zalo-creds.*`, `config.yaml`, `registration.yaml`, or `bridge.db` — they are gitignored.
- The bridge runs entirely on your machine; message content is only ever sent to Beeper (your homeserver) and Zalo.
- Outbound traffic is rate-limited and the listener pauses on ban-suspicion signals to reduce risk to the account.
- **History import:** the Zalo PC debug port listens on `127.0.0.1` only, but any local program can read your messages through it while it is open — restart Zalo PC normally when done. The backup key (`get-uin.mjs`) decrypts every backup of the account: keep it in a private file and delete it after use. Extracted backups and prepared media contain your full history and media in clear text — delete `work/` (and `/data/import-*` in the container) after importing.

## Acknowledgements

- [zca-js](https://github.com/RFS-ADRENO/zca-js) — the unofficial Zalo Web API this bridge is built on
- [matrix-appservice-bridge](https://github.com/matrix-org/matrix-appservice-bridge)
- [Beeper Bridge Manager](https://github.com/beeper/bridge-manager)
- [jSquash](https://github.com/jamsinclair/jSquash) (JPEG XL / JPEG codecs) and [wasm-webp](https://github.com/nieyuyao/webp-wasm) (animated WebP)
- Patterns studied from the [mautrix](https://github.com/mautrix) bridge family

## License

MIT — see [LICENSE](./LICENSE). Not affiliated with Zalo/VNG or Beeper.
