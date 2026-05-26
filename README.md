# PolyLab

Verified AI-native research and experimentation workspace.

## Development

```bash
bun install
bun run dev
```

The desktop app starts Vite and Electron. The local API runs on `http://127.0.0.1:3917`.

## Verification

```bash
bun run verify
```

## Desktop Builds

```bash
bun run dist:mac
bun run dist:linux
```

Linux builds emit AppImage and deb artifacts. macOS builds emit dmg and zip artifacts when run on macOS.
