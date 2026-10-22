# NDJSON history import

The importer replays exported Zalo NDJSON messages into this bridge's existing Matrix portals.

## Safety first

1. Back up `bridge.db` and your Beeper/bridge configuration.
2. Stop the bridge process before importing, so the importer and live listener do not race on the SQLite mapping store or interleave live messages with history.
3. Keep your export private. NDJSON may contain personal messages, user IDs and media URLs.
4. Start with `--dry-run`, then use `--limit 10` as a smoke test.

## Usage

Requires the same Node.js, dependencies, `config.yaml`, and `registration.yaml` as the bridge.

```bash
npm install
npm run import:ndjson -- --input ./zalo-export --dry-run
npm run import:ndjson -- --input ./zalo-export --limit 10
npm run import:ndjson -- --input ./zalo-export
```

The importer scans a directory recursively for `.ndjson` and `.jsonl` files. Each file should represent one conversation. It recognizes common export fields such as `msgId`, `fromUid`, `toUid`, `msgType`, `sendDttm`, `serverTime`, `message`, and `content`.

When a filename or existing portal does not unambiguously identify the conversation, supply a mapping JSON. Keys can be the file basename or full path:

```json
{
  "g9004117716180455748.ndjson": {
    "threadId": "9004117716180455748",
    "threadType": "group",
    "name": "Example group"
  },
  "6164638357157478460.ndjson": {
    "threadId": "6164638357157478460",
    "threadType": "user",
    "name": "Example DM"
  }
}
```

Then run:

```bash
npm run import:ndjson -- --input ./zalo-export --mapping ./threads.json
```

Use `--own-uid YOUR_ZALO_UID` if the export includes messages sent by the account owner. Without it, the importer cannot reliably distinguish own messages from other senders.

## Timestamp behavior — important

The importer parses source timestamps (preferring `sendDttm`, then `serverTime`) as epoch milliseconds/seconds or date strings and replays messages oldest-first. It stores the source timestamp in custom content metadata under `com.lethucthanhtu.zalo_import`, and makes the original time visible in message text/captions where possible.

**This does not set Matrix `origin_server_ts`.** The normal Matrix client/appservice send APIs assign event time at send/import time; a field in message content cannot override it. This repository does not have a verified Beeper Cloud/hungryserv historical-event import API, so the importer does not claim to preserve Beeper's timeline timestamps. Do not use this as an original-time backfill unless a supported Beeper API is confirmed and integrated.

## Message types and limitations

- Text is imported as `m.text`.
- Photo/media URLs are downloaded through the bridge's existing guarded Zalo-CDN media handler and uploaded to Matrix where supported.
- Sticker records with usable sticker IDs and media URLs are imported as Matrix stickers.
- Unsupported or incomplete payloads are retained as readable `m.notice` records rather than silently dropped.
- Replies, reactions, read receipts, recalls, edits, and original Zalo sender identity beyond available sender IDs are not reconstructed from this importer.
- A Zalo export's exact field schema varies. Always inspect the dry-run output and test a small sample first. Ambiguous conversation mappings fail closed instead of guessing a DM/group.
