# CueBoard Desktop Edition

This is the Electron desktop version of CueBoard. It provides the same functionality as the web version but with enhanced file system access that persists between sessions.

## Key Differences from Web Version

### Persistent File Access

The desktop version remembers your audio file directory and automatically relinks files on startup. You don't need to reselect your folder every time you open the app.

### Local File System

Uses Node.js file system APIs instead of the browser's File System Access API, providing more reliable and faster file access.

### Standalone Application

Runs as a native desktop application on macOS, Windows, and Linux.

## Development

### Prerequisites

- Node.js 20.19+ or 22.12+ (required by Vite 7)
- npm
- If using nvm: `nvm install 22 && nvm use 22`

### Running in Development Mode

```bash
npm run electron:dev
```

This will:

1. Start the Vite dev server
2. Wait for it to be ready
3. Launch Electron with hot reload enabled

### Building for Production

#### macOS (for M3 Mac)

```bash
npm run electron:build:mac
```

This creates a DMG and ZIP file in the `release/` directory.

#### Windows (cross-platform build)

```bash
npm run electron:build:win
```

#### Linux (cross-platform build)

```bash
npm run electron:build:linux
```

#### All Platforms

```bash
npm run electron:build
```

**Note**: Building for your Azure AMD64 environment from your M3 Mac will require Docker or a remote build server. Electron-builder can handle cross-platform builds, but native dependencies may need recompilation.

## Merging from Main Branch

This branch is designed to be regularly updated with changes from the `main` branch:

```bash
# Switch to desktop branch
git checkout desktop

# Merge changes from main
git merge main

# Resolve any conflicts if they arise
# The main differences are in package.json and the Electron-specific files

# Push to remote
git push origin desktop
```

### Typical Merge Conflicts

When merging from `main`, you may encounter conflicts in:

- `package.json` - Keep the desktop version's Electron-specific configuration
- `src/App.jsx` - The desktop version imports and uses `electronFileSystem.js`

## File Structure

```
electron/
  ├── main.js          # Electron main process
  └── preload.js       # Preload script (security bridge)
src/
  └── electronFileSystem.js  # File system abstraction layer
```

## How It Works

### File System Abstraction

The `electronFileSystem.js` module provides a unified API that works in both Electron and browser environments:

- **In Electron**: Uses IPC to communicate with the main process, which performs file operations using Node.js APIs
- **In Browser**: Falls back to the File System Access API

### Auto-Relink on Startup

When the desktop app starts:

1. Checks for a previously selected directory
2. If found, automatically scans it for audio files
3. Links all matching files without user interaction

### Persistent Storage

The desktop version uses:

- **electron-store**: For storing app preferences and the last selected directory
- **Local file paths**: Instead of temporary blob URLs

## Security

The desktop app uses Electron's security best practices:

- Context isolation enabled
- Node integration disabled in renderer
- Preload script for controlled IPC
- No eval or arbitrary code execution

## Distribution

Built applications are code-signed ready (requires certificates):

- macOS: `.dmg` installer and `.zip` archive
- Windows: NSIS installer and portable `.exe`
- Linux: `.AppImage` and `.deb` packages

## Troubleshooting

### "Directory not found" on startup

If the last selected directory was moved or deleted, the app will prompt you to select a new one.

### Audio files not playing

Ensure the audio files are in a supported format (MP3, WAV, OGG, M4A, FLAC, AAC, WEBM) and the directory permissions allow read access.

### Build fails on M3 Mac for Windows/Linux

Cross-platform builds from M3 may require additional setup. Consider using:

- Docker for AMD64 builds
- GitHub Actions for automated multi-platform builds
- A CI/CD pipeline that builds on native hardware

## Future Enhancements

Potential desktop-only features:

- Native menu bar integration
- System tray support
- MIDI device management
- Direct audio output routing
- Project file format (.cueboard files)
- Recent projects list
