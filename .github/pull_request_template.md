## What and why

<!-- What this changes and the reason. Link the issue it closes, if any. -->

## How it was tested

<!-- Which suites you ran, and what you checked by hand (simulator, browser, device). Say which
hardware, if any: tablet OS version, glasses firmware. -->

- [ ] Go: `cd bridge/remarkable/native && go test ./router/ ./pen/ ./release/ ./rmlines/ ./pagewatch/`
- [ ] Rust: `cd bridge/remarkable/rust && cargo test`
- [ ] TypeScript: `pnpm -r typecheck && pnpm -r test` (apps/even-g2, packages/hand, apps/hand-lab)
- [ ] Boot scripts: `bash bridge/remarkable/boot/test/run.sh`
- [ ] Desktop router: `uv run pytest -q && uv run ruff check . && uv run mypy .`

## Checklist

- [ ] Targets `dev`; commits read `feat|fix|docs|chore(scope): …`
- [ ] Module prose and docs still true of the code (literate-code convention, CONTRIBUTING.md)
- [ ] No secrets, keys, `.env` files or personal network addresses
- [ ] If it changes what is installed on the tablet: `docs/what-codrawer-changes.md` updated
- [ ] If it changes the wire protocol: `docs/protocol.md` updated, both engines and the clients agree
