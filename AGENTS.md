# AGENTS.md

## Setup

- Install deps: `npm install`
- Run the extension: use the `Run Extension` launch config in `.vscode/launch.json` (it runs `npm: compile` before launch)
- Tests: `npm test`

## Project layout

- VS Code extension entrypoint and build output live at the repo root (`package.json`, `out/`)
- Extension source: `packages/extension`
- Shared protocol types: `packages/protocol`
- Monitor bridge server (internal): `packages/servers/portino-bridge`
- Webviews: `packages/webviews/*` (monitor, plotter, platforms, libraries, profiles, examples, resources)
- Sample workspace for dev/testing: `test_workspace`

## Code style

- Follow ESLint/Prettier configs in the repo
- TypeScript strict mode
- Prefer single quotes and no semicolons in existing files
