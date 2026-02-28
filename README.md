# PixelArgon

A minimal, fast desktop image crop & edit app built with Tauri v2 + Rust.

## Features

### Core Workflow
- **Open** PNG, JPEG, and WebP images (file picker or drag-and-drop)
- **Canvas viewer** with zoom (fit, 100%, +/-), pan (mouse drag), and mouse wheel zoom
- **Crop tool** with resizable rectangle, drag handles, and aspect ratio presets (1:1, 4:5, 16:9, 9:16, 3:2, custom)
- **Lock aspect ratio** toggle
- **Export** to PNG or JPEG (with quality slider), output at exact target dimensions
- Scale modes: "Scale to fit then crop" or "Crop then scale"

### Basic Edits
- Grayscale toggle
- Brightness slider (-100 to +100)
- Contrast slider (-100 to +100)
- Rotate 90° left/right
- Flip horizontal/vertical

### Redaction
- **Pixelate brush** with configurable brush size and block size
- Non-destructive strokes with undo/redo
- Applied in final export via Rust image processing

### Background Removal (Beta)
- **Chroma key mode**: pick a color from the image, set tolerance, and make matching pixels transparent
- Exported as PNG with alpha channel

### App Features
- Recent files list (last 10), persisted locally
- Keyboard shortcuts
- Dark UI theme

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + O` | Open image |
| `Cmd/Ctrl + S` | Export |
| `Cmd/Ctrl + Z` | Undo (pixelate stroke) |
| `Cmd/Ctrl + Shift + Z` | Redo |
| `1` | Zoom to fit |
| `2` | Zoom to 100% |

## Development Setup

### Prerequisites
- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) (v18+)
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)

### Install & Run
```bash
npm install
npm run tauri dev
```

### Build & Package
```bash
npm run tauri build
```

This produces platform-specific installers in `src-tauri/target/release/bundle/`.

## Architecture

- **Frontend**: Vanilla TypeScript + Vite — handles canvas rendering, crop interaction, pixelate brush, and UI state
- **Backend**: Rust (Tauri commands) — handles image loading/decoding, all transform/filter/export processing, and recent files persistence
- **Preview**: Canvas filters for real-time preview (grayscale, brightness, contrast)
- **Export**: Rust pipeline applies all transforms pixel-accurately to the source image

## Stack
- Tauri v2
- Rust (`image` crate for processing)
- Vanilla TypeScript + Vite
- No cloud, no accounts, no telemetry

## Auto-Updates
PixelArgon supports in-app auto-updates via GitHub Releases. The app checks for updates on launch and provides a manual "Check for Updates" button.

Currently supported:
- macOS Apple Silicon (aarch64-apple-darwin)

## Releasing

Tagged releases trigger CI builds:
```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow builds macOS Apple Silicon bundles and publishes them as a GitHub Release with updater metadata.

### Updater Signing
The Tauri updater requires a signing keypair. Generate one:
```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/pixelargon.key
```

Set these as GitHub Secrets:
- `TAURI_SIGNING_PRIVATE_KEY` — contents of the private key file
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password used during generation

## License
MIT
