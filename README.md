# BoardLab

Vendor-independent board development for Visual Studio Code, powered by the Arduino CLI.

BoardLab for Visual Studio Code aims to be feature-complete with Arduino IDE 2.x, while staying fully open, power-user friendly, and strictly native to VS Code's UX.

All builds, uploads, board management, library management, and metadata are handled by the official Arduino CLI.

Arduino libraries, board packages, and toolchain binaries are downloaded exclusively from official Arduino servers.

BoardLab is **not affiliated with Arduino**. It uses the official Arduino CLI.

---

## Features

BoardLab focuses on removing friction from Arduino development workflows inside VS Code.

Current features include:

- Board, port, and sketch management from VS Code
- Compile, upload, and archive sketches using the Arduino CLI
- Built-in serial monitor and plotter views
- Build profiles for repeatable board and toolchain configurations
- Native VS Code commands, views, tasks, and diagnostics

Screenshots and short animations will be added as the UI stabilizes.

> Tip: Short, focused animations are planned to demonstrate workflows once features are considered stable.

---

## Requirements

No Arduino IDE installation is required.

All required toolchains, board packages, and libraries are downloaded via the Arduino CLI from official Arduino servers.

---

## Extension Settings

BoardLab contributes VS Code settings under the `boardlab.*` namespace.

Examples:

- `boardlab.cli.path`: Path to the Arduino CLI binary (optional)
- `boardlab.cli.additionalUrls`: Additional board package index URLs
- `boardlab.monitor.baudRate`: Default baud rate for the serial monitor
- `boardlab.monitor.lineEnding`: Line ending configuration for the monitor

Settings may evolve while the extension is in early preview.

---

## Known Issues

- APIs, command IDs, and configuration keys may change
- Some advanced Arduino IDE 2.x features are not yet integrated
- UX and diagnostics are still being refined

Please check existing issues before reporting new ones.

---

## Roadmap

This roadmap is intentionally pragmatic and incremental.

- Fix existing bugs and inconsistencies
- Improve first-time setup and onboarding
- Expand diagnostics and error reporting
- **Truly self-hosted** workflows starting with the AVR core
- UI **translations and accessibility** improvements
- Improve monitor and plotter UX and performance
- Incremental integration of Arduino language and editor features
- Debugger integration where supported by platforms and the Arduino CLI
- Improved and more predictable build profile handling
- Compatibility updates for related extensions (e.g. LittleFS and the ESP Exception Decoder)

---

## Release Notes

Release notes are maintained in [`CHANGELOG.md`](./CHANGELOG.md).

---

## License

MIT
