# Branch Merge Workflow: Main → Desktop

This document explains the workflow for maintaining both the web (`main`) and desktop (`desktop`) branches.

## Branch Strategy

- **`main` branch**: Web version of CueBoard
  - Standard web app using File System Access API
  - Requires file relinking on each browser session
  - All core functionality development happens here

- **`desktop` branch**: Electron desktop version
  - Based on the web version with Electron wrapper
  - Persistent file access without relinking
  - Additional desktop-specific features

## Workflow

### 1. Development on Main Branch

All feature development and bug fixes should be done on the `main` branch:

```bash
git checkout main
# Make your changes
git add .
git commit -m "Your commit message"
git push origin main
```

### 2. Merging Main into Desktop

Regularly merge changes from `main` into `desktop`:

```bash
# Switch to desktop branch
git checkout desktop

# Ensure you have latest changes
git pull origin desktop

# Merge main branch
git merge main

# If there are conflicts, resolve them (see below)

# Push to remote
git push origin desktop
```

### 3. Handling Merge Conflicts

When merging, you may encounter conflicts in these files:

#### package.json
**Strategy**: Keep desktop-specific additions

The desktop version has additional fields and scripts. During merge:
- Keep `"main": "electron/main.js"`
- Keep all `electron:*` scripts
- Keep Electron dependencies
- Keep the `"build"` section for electron-builder

#### src/App.jsx
**Strategy**: Keep desktop imports and logic

The desktop version has:
- Import of `electronFileSystem.js`
- Modified file handling logic
- Both browser and Electron support

Accept desktop version changes that include `electronFileSystem` imports and usage.

#### Files to Keep from Desktop
- `electron/main.js`
- `electron/preload.js`
- `src/electronFileSystem.js`
- `DESKTOP-README.md`
- `MERGE-WORKFLOW.md`
- Desktop-specific `.gitignore` entries

### 4. Testing After Merge

After merging, always test both environments:

```bash
# Test web version
npm run dev

# Test desktop version  
npm run electron:dev
```

## Quick Reference Commands

```bash
# See what files changed in main
git checkout desktop
git log desktop..main --oneline

# See diff before merging
git diff desktop...main

# Abort a merge if needed
git merge --abort

# After resolving conflicts
git add .
git commit -m "Merge main into desktop"
git push origin desktop
```

## Automated Workflow (Optional)

You can set up a GitHub Action to automatically create PRs when main is updated:

```yaml
# .github/workflows/sync-desktop.yml
name: Sync Desktop Branch
on:
  push:
    branches: [main]
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v5
        with:
          branch: desktop
          base: desktop
          title: 'Merge main into desktop'
```

## When to Make Desktop-Only Changes

Some changes should ONLY be made on the desktop branch:

- Electron main process updates (`electron/main.js`)
- Preload script changes (`electron/preload.js`)
- Desktop-specific file system enhancements (`src/electronFileSystem.js`)
- Desktop build configuration
- Desktop-specific UI/UX improvements
- Native integrations (menu bar, system tray, etc.)

## Release Process

### Web Release (from main)
```bash
git checkout main
npm run build
# Deploy dist/ folder to your web host
```

### Desktop Release (from desktop)
```bash
git checkout desktop

# Ensure main is merged
git merge main

# Build for your platform
npm run electron:build:mac
npm run electron:build:win
npm run electron:build:linux

# Distributables are in release/ folder
```

## Troubleshooting

### "Conflicts in package-lock.json"
```bash
# Regenerate after resolving package.json
rm package-lock.json
npm install
git add package-lock.json
```

### "Desktop app not working after merge"
1. Check that `electronFileSystem.js` wasn't overwritten
2. Verify Electron imports in App.jsx are present
3. Reinstall dependencies: `rm -rf node_modules && npm install`
4. Rebuild: `npm run electron:dev`

### "Can't test web version on desktop branch"
The desktop branch should still work as a web app:
```bash
npm run dev
# Open browser to localhost:5173
```

The `electronFileSystem.js` module gracefully falls back to browser APIs.

## Best Practices

1. **Merge frequently**: Don't let desktop branch fall too far behind
2. **Test both**: Always test web and desktop after merging
3. **Document desktop features**: Keep DESKTOP-README.md updated
4. **Preserve abstractions**: The file system abstraction makes merging easier
5. **Communicate**: If making major changes to main, consider impact on desktop

## Questions?

If you're unsure about a merge conflict:
1. Check the git history: `git log --oneline -- <file>`
2. Look at the specific change: `git show <commit-hash>`
3. When in doubt, keep desktop-specific code

