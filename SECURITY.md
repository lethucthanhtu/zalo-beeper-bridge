# Security policy

## Supported versions

Only the latest `main` is supported. Update with `git pull` and redeploy before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through
GitHub: _Security_ tab → _Report a vulnerability_
(<https://github.com/lethucthanhtu/zalo-beeper-bridge/security/advisories/new>). Include what
is affected, how to reproduce it, and the impact. Leave out real tokens, messages and ids.

You can expect an acknowledgement within a week. Please give a reasonable time to fix the issue
before disclosing it.

In scope, for example: leaking message content, tokens or the Zalo session (logs, files,
error messages); requests to hosts outside the Zalo CDN allowlist (SSRF); someone other than the
owner controlling the bridge bot; Matrix events that make the bridge act on Zalo without the
owner.

Out of scope: Zalo locking or banning an account (an inherent risk of the unofficial
`zca-js` API, see the README), vulnerabilities in Zalo, Beeper or `bbctl` themselves (report
them to those projects), and findings that need an attacker who already controls your machine.

## Keeping your deployment safe

- `container-config/` (or `config.yaml`, `registration.yaml`, `bbctl-config.json`), the
  `zalo-data` volume and `bridge.db` contain tokens, the encrypted Zalo session and message
  mappings. Keep them private; never commit or share them. If one leaks, re-register the bridge
  (`bbctl register`), log out and back in to Zalo, and rotate your Beeper login.
- The appservice listens on `127.0.0.1` inside the container only; do not publish its port.
- The Zalo PC debug port used by the history importer exposes your messages to local programs
  while it is open. Restart Zalo PC normally afterwards and delete the export/backup work
  files.
