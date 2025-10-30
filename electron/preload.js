const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Check if running in Electron
  isElectron: true,
  
  // Directory selection
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getLastDirectory: () => ipcRenderer.invoke('get-last-directory'),
  
  // File operations
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  getFileUrl: (filePath) => ipcRenderer.invoke('get-file-url', filePath),
  
  // Show data persistence
  saveShowData: (data) => ipcRenderer.invoke('save-show-data', data),
  loadShowData: () => ipcRenderer.invoke('load-show-data'),
  
  // File path mappings
  saveFileMappings: (mappings) => ipcRenderer.invoke('save-file-mappings', mappings),
  loadFileMappings: () => ipcRenderer.invoke('load-file-mappings'),
});

