# Translations

The documentation for `zalo-beeper-bridge` is bilingual:

- **English** (`en-US`): Served at the root path (`/`).
- **Vietnamese** (`vi-VN`): Served under `/vi/`.

## Keeping translations in sync

Whenever you update an English documentation file under `docs/`, you must update its Vietnamese counterpart under `docs/vi/` in the same pull request or commit.

- **Changelog exception:** `docs/changelog.md` is maintained in English only. Navigation in the Vietnamese locale links directly to `/changelog`.
- **Terminology:** Use `README.vi.md` as the authoritative reference for Vietnamese technical terms (e.g., _application service tự host_, _ghost user_, _portal room_, _double-puppeting_, _read receipt_, _typing_, _catch-up sync_).
- **Code & identifiers:** Keep code snippets, CLI commands, configuration keys, file paths, and proper names (`Zalo`, `Beeper`, `Matrix`, `bbctl`, `Podman`, `Docker`) verbatim.
- **Internal links:** Ensure relative links in Vietnamese pages point to their `/vi/...` destinations, and preserve custom anchor tags (e.g. `{#custom-anchor}`) so anchor links continue to resolve.

## Parity verification

A lightweight test (`src/__tests__/docs-i18n-parity.test.ts`) runs during CI to verify that every published English page under `docs/` has a matching counterpart under `docs/vi/`.

You can run the check locally with:

```bash
npx vitest run src/__tests__/docs-i18n-parity.test.ts
```
