# PixelArgon Updater Setup

## Overview
PixelArgon uses the Tauri v2 updater plugin to check for and install updates from GitHub Releases.

## Signing Key Setup

### 1. Generate a signing keypair
```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/pixelargon.key
```

This outputs:
- A private key file at `~/.tauri/pixelargon.key`
- A public key printed to stdout

### 2. Set the public key in config
Copy the public key and paste it into `src-tauri/tauri.conf.json`:
```json
{
  "plugins": {
    "updater": {
      "pubkey": "YOUR_PUBLIC_KEY_HERE",
      "endpoints": [
        "https://github.com/salfade-tools/pixel-argon-desktop-app/releases/latest/download/latest.json"
      ]
    }
  }
}
```

### 3. Add secrets to GitHub
Go to Settings > Secrets and variables > Actions in your GitHub repo, and add:

| Secret Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/pixelargon.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you used during generation |

### 4. Create a release
```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow will:
1. Build the macOS Apple Silicon app
2. Sign the update artifact
3. Create a GitHub Release with the DMG and `latest.json` updater manifest

### 5. Verify the update flow
1. Install the released version (e.g., v0.1.0)
2. Bump the version in `src-tauri/tauri.conf.json` and `package.json`
3. Tag and push a new release (e.g., v0.1.1)
4. Open the installed app — it should detect the update

## How It Works

1. On app launch (or manual check), the app fetches `latest.json` from the GitHub Release
2. `latest.json` contains the latest version, download URL, and signature
3. If a newer version is available, the user is prompted to download and install
4. The app downloads the update, verifies the signature, and installs it

## Troubleshooting

- **"Auto-updater not available in dev mode"**: The updater only works in production builds, not `tauri dev`
- **Signature verification failed**: Make sure the pubkey in config matches the private key used to sign
- **No update detected**: Check that the version in `tauri.conf.json` of the released build is lower than the latest release
