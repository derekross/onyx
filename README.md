# Onyx

A private, encrypted note-taking app with Nostr sync.

Onyx lets you write markdown notes locally and sync them securely across devices using the Nostr protocol. Your notes are encrypted with your Nostr keys before being published to relays, ensuring only you can read them.

## Features

- **Markdown Editor** - Write notes with syntax highlighting and live preview
- **Local-First** - Your notes are stored locally and work offline
- **Nostr Sync** - Encrypted sync across devices via Nostr relays
- **Secure Storage** - Private keys stored in your OS keyring (Keychain, libsecret, Credential Manager)
- **Multiple Login Options** - Import nsec, generate new keys, or use Nostr Connect (Amber, Primal)
- **Cross-Platform** - Linux, macOS, and Windows

## Installation

### Pre-built Binaries

Download the latest release for your platform from the [Releases](https://github.com/derekross/onyx/releases) page.

#### macOS Installation

The app is not currently signed with an Apple Developer certificate, so macOS will show a warning that the app is "damaged" or from an "unidentified developer". To install:

**Option 1: Remove quarantine attribute (recommended)**

Open Terminal and run:
```bash
xattr -cr /Applications/Onyx.app
```

If you installed it elsewhere, replace `/Applications/Onyx.app` with the actual path.

**Option 2: Right-click to open**

1. Right-click (or Control+click) on Onyx.app
2. Select "Open" from the context menu
3. Click "Open" in the security dialog

After doing this once, the app will open normally.

### Build from Source

#### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) 1.77+
- Platform-specific dependencies (see below)

#### Linux (Debian/Ubuntu)

```bash
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libsecret-1-dev libssl-dev libdbus-1-dev
```

#### macOS

```bash
xcode-select --install
```

#### Windows

Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++".

#### Build

```bash
# Clone the repository
git clone https://github.com/derekross/onyx.git
cd onyx

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

## Usage

### Getting Started

1. Open Onyx and create or open a vault (folder for your notes)
2. Create notes using the sidebar or `Ctrl+N`
3. Write in markdown - your notes auto-save

### Nostr Sync

1. Go to **Settings > Nostr**
2. Login with your nsec or scan a QR code with Amber/Primal
3. Go to **Settings > Sync** and enable sync
4. Click **Sync Now** or use the sync icon in the status bar

Your notes are encrypted with NIP-44 before being published to relays. Only you can decrypt them with your private key.

### Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Save | `Ctrl+S` |
| Quick Switcher | `Ctrl+O` |
| Search in Files | `Ctrl+Shift+F` |
| Toggle Terminal | `Ctrl+\`` |
| Command Palette | `Ctrl+Shift+P` |

## How Sync Works

Onyx uses a custom Nostr event structure for encrypted file sync:

- **Vault Index** (kind 30801) - Encrypted list of files in your vault
- **File Events** (kind 30800) - Individual encrypted file contents

All content is encrypted using NIP-44 with a conversation key derived from your own public/private key pair. This means only you can decrypt your notes, and relays only see encrypted blobs.

## Tech Stack

- [Tauri 2.0](https://tauri.app/) - Rust-based desktop framework
- [SolidJS](https://www.solidjs.com/) - Reactive UI framework
- [CodeMirror 6](https://codemirror.net/) - Text editor
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) - Nostr protocol library

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.
