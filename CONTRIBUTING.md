# Contributing to codrawer-bridge

Thank you for looking. codrawer is small and hardware-bound, so the most useful contributions are
often reports from a device we do not have: a different reMarkable OS version, glasses firmware,
phone or network. Bug reports and feature requests use the templates under
[New issue](https://github.com/Caerii/codrawer-bridge/issues/new/choose); security problems go
through [SECURITY.md](SECURITY.md), not public issues.

Pull requests go to the `dev` branch. Small and focused beats large and sweeping; open an issue
first for anything that changes the wire protocol, the tablet install, or a decision recorded in
[`docs/adr/`](docs/adr).

## Setting up, per component

You do not need hardware for most work: every component has tests that run on a desktop, and the
glasses app runs in a browser and in the Even Hub simulator.

| Component | Needs | Set up and test |
| --- | --- | --- |
| Tablet bridge, Go ([`bridge/remarkable/native/`](bridge/remarkable/native/README.md)) | Go 1.22+ | `cd bridge/remarkable/native && go test ./router/ ./pen/ ./release/ ./rmlines/ ./pagewatch/` (the main package builds for Linux only) |
| Tablet bridge, Rust ([`bridge/remarkable/rust/`](bridge/remarkable/rust/README.md)) | stable Rust; `aarch64-unknown-linux-musl` to build for the tablet | `cd bridge/remarkable/rust && cargo test` |
| Boot scripts ([`bridge/remarkable/boot/`](bridge/remarkable/boot)) | Go, Docker | `bash bridge/remarkable/boot/test/run.sh` |
| Glasses and phone app ([`apps/even-g2/`](apps/even-g2/README.md)) | Node 22, pnpm | `cd apps/even-g2 && pnpm install && pnpm typecheck && pnpm test`; `pnpm dev` serves it on :5188 |
| Desktop router ([`src/codrawer_bridge/`](src/codrawer_bridge)) | Python 3.11+, uv | `uv sync && uv run pytest -q && uv run ruff check . && uv run mypy .` |
| Model server ([`model-server/`](model-server)) | Node 22, pnpm | `cd model-server && pnpm install && pnpm typecheck` |

Use **pnpm** for Node (never npm) and **uv** for Python (`uv run …`). CI runs the Go, Rust, app
and boot-script suites on every push; run the ones for what you touched before opening a PR.

On the tablet: [`docs/remarkable_setup.md`](docs/remarkable_setup.md) for developer mode and SSH,
then `scripts/dev/deploy-tablet.sh` with `CODRAWER_TABLET` set to your tablet's address
([`scripts/dev/README.md`](scripts/dev/README.md#addresses)). Read
[what codrawer changes on your tablet](docs/what-codrawer-changes.md) first. On the glasses:
[`docs/even-g2-testing.md`](docs/even-g2-testing.md).

## How the code is written

**Literate code**, in the spirit of Knuth and at the standard of
[rmscene](https://github.com/ricklupton/rmscene) and [rmc](https://github.com/ricklupton/rmc):

- Every module opens with a prose overview: the problem it solves, the facts it rests on (cite the
  ADR, the `docs/investigations/` note or the measurement), and how data flows through it.
- Sections in reading order, the why before the how.
- Every exported item documents its intent, its invariants and its units (normalized page
  coordinates, ms, px).
- No comments that restate the code, and every prose claim must be true of the code. When you
  change behaviour, change the prose with it.

Measured facts beat assumptions: if a change rests on a timing or a device behaviour, say where
the number came from.

Ground rules that hold across the codebase (README, "Development"): nobody else's ink is ever
overwritten; never touch xochitl's data except through documented, reversible paths; keep
reMarkable OS updates on.

## Commits

```
feat|fix|docs|chore(scope): what changed, in the imperative

Why, when it is not obvious from the diff.
```

`scope` is the component (`even-g2`, `bridge`, `router`, `boot`, `rust`, …). One logical change
per commit. Commits made with an AI agent carry its `Co-Authored-By:` trailer.

## Never commit

- `~/.codrawer/release.key` (the release signing key) or anything else from `~/.codrawer/`;
- `.env` files, `bridge.env` with a real `ROUTER_TOKEN`, API keys, SSH keys;
- your own network addresses: use `<tablet-ip>` / `<lan-ip>` in docs and the `CODRAWER_TABLET` /
  `CODRAWER_LAN_IP` variables in scripts;
- router runtime state (`.codrawer/`, `.codrawer-term-sessions.json`) and build output
  (`*.ehpk`, binaries); these are gitignored, keep them that way.

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), like the rest of the project.
