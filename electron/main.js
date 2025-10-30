const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const Store = require('electron-store');

// Initialize persistent store for file paths and app state
const store = new Store();

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#1e1e1e',
  });

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC Handlers for file operations

// Select a directory
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const dirPath = result.filePaths[0];
    // Save to persistent storage
    store.set('lastSelectedDirectory', dirPath);
    return { path: dirPath, canceled: false };
  }
  
  return { path: null, canceled: true };
});

// Get the last selected directory
ipcMain.handle('get-last-directory', async () => {
  const lastDir = store.get('lastSelectedDirectory');
  if (lastDir) {
    try {
      await fs.access(lastDir);
      return lastDir;
    } catch {
      // Directory no longer exists
      store.delete('lastSelectedDirectory');
      return null;
    }
  }
  return null;
});

// Read directory contents recursively
ipcMain.handle('read-directory', async (event, dirPath) => {
  try {
    const files = [];
    
    async function scanDir(currentPath, relativePath = '') {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;
        
        if (entry.isDirectory()) {
          await scanDir(fullPath, relPath);
        } else if (entry.isFile()) {
          // Only include audio files
          const ext = path.extname(entry.name).toLowerCase();
          if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.webm'].includes(ext)) {
            files.push({
              name: entry.name,
              path: relPath,
              fullPath: fullPath,
            });
          }
        }
      }
    }
    
    await scanDir(dirPath);
    return { success: true, files };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Read a file and return as buffer
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const data = await fs.readFile(filePath);
    return { success: true, data: data.buffer };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Save show data
ipcMain.handle('save-show-data', async (event, data) => {
  try {
    const showData = JSON.stringify(data, null, 2);
    store.set('showData', showData);
    
    // Also optionally save to a file
    const lastDir = store.get('lastSelectedDirectory');
    if (lastDir) {
      const savePath = path.join(lastDir, 'cueboard-show.json');
      await fs.writeFile(savePath, showData, 'utf-8');
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Load show data
ipcMain.handle('load-show-data', async () => {
  try {
    const showData = store.get('showData');
    if (showData) {
      return { success: true, data: JSON.parse(showData) };
    }
    return { success: false, error: 'No saved show data found' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get file URL for audio playback
ipcMain.handle('get-file-url', async (event, filePath) => {
  try {
    // Verify file exists
    await fs.access(filePath);
    // Return as file:// URL
    return { success: true, url: `file://${filePath}` };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Save file path mappings
ipcMain.handle('save-file-mappings', async (event, mappings) => {
  store.set('fileMappings', mappings);
  return { success: true };
});

// Load file path mappings
ipcMain.handle('load-file-mappings', async () => {
  const mappings = store.get('fileMappings', {});
  return { success: true, mappings };
});

