# Provenance

This repository is a GitHub fork of [`JoniBR/pi-fusion`](https://github.com/JoniBR/pi-fusion). It is installed as the Pi
package [`michalo1334/pi-fusion`](https://github.com/michalo1334/pi-fusion), not copied into a consumer's extension
folder.

- Upstream commit: `29623dc904a4f5ea93b7af37544a05905fc001e3`
- Upstream package version: `0.1.1`
- Fork history retains the upstream extension and companion plugin.
- The package carries the agent library's modified `extensions/fusion.ts`, sidekick policy, tests, and lead skill.
- The Pi manifest exposes only the Pi extension and `skills/fusion/SKILL.md`.

## Local changes

- Replace the removed `modelRegistry` SDK option with supported model lookup and session creation.
- Add JSON configuration for the sidekick model, timeout, exact tool allowlist, and selected extension packages.
- Load only `pi-mcp-adapter` and `context-mode` when the JSON policy selects them.
- Keep `follow_up` task IDs valid only in the current Pi process.
- Expose the extension entry point explicitly so Pi does not load the policy helper as a separate extension.
- Declare Pi host packages as peer dependencies. Test package loading and session tools against Pi 1.0.2.

See the local README for the configuration and tool policy.

## License

The upstream package metadata declares `MIT`. The upstream commit has no `LICENSE` file. This repository records that
declaration here and does not add a license text on the upstream author's behalf.
