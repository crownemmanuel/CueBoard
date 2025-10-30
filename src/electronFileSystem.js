/**
 * File system abstraction layer for Electron
 * This module provides unified file system operations that work in both Electron and browser environments
 */

// Check if we're running in Electron
const isElectron = () => {
  return typeof window !== 'undefined' && window.electronAPI?.isElectron;
};

/**
 * Select a directory and return a handle/path
 */
export async function selectDirectory() {
  if (isElectron()) {
    const result = await window.electronAPI.selectDirectory();
    if (!result.canceled && result.path) {
      return {
        kind: 'directory',
        name: result.path.split('/').pop() || result.path.split('\\').pop(),
        path: result.path,
        isElectron: true,
      };
    }
    return null;
  } else {
    // Web browser - use File System Access API
    if (typeof window === 'undefined' || !window.showDirectoryPicker) {
      throw new Error('Directory picker not supported');
    }
    return await window.showDirectoryPicker({});
  }
}

/**
 * Check if directory picker is supported
 */
export function isDirectoryPickerSupported() {
  if (isElectron()) {
    return true;
  }
  return typeof window !== 'undefined' && !!window.showDirectoryPicker;
}

/**
 * Get the last used directory (Electron only - auto-restores on launch)
 */
export async function getLastDirectory() {
  if (isElectron()) {
    const path = await window.electronAPI.getLastDirectory();
    if (path) {
      return {
        kind: 'directory',
        name: path.split('/').pop() || path.split('\\').pop(),
        path: path,
        isElectron: true,
      };
    }
  }
  return null;
}

/**
 * Read all files from a directory recursively
 */
export async function readDirectoryFiles(dirHandle) {
  if (isElectron() && dirHandle.isElectron) {
    // Use Electron's file system
    const result = await window.electronAPI.readDirectory(dirHandle.path);
    if (result.success) {
      return result.files.map(file => ({
        name: file.name,
        path: file.path,
        fullPath: file.fullPath,
        handle: null, // Not used in Electron
      }));
    }
    throw new Error(result.error || 'Failed to read directory');
  } else {
    // Web browser - use File System Access API
    const files = [];
    
    async function scanDir(handle, relativePath = '') {
      for await (const entry of handle.values()) {
        if (entry.kind === 'directory') {
          await scanDir(entry, relativePath + entry.name + '/');
        } else if (entry.kind === 'file') {
          const ext = entry.name.split('.').pop().toLowerCase();
          if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'webm'].includes(ext)) {
            files.push({
              name: entry.name,
              path: relativePath + entry.name,
              handle: entry,
            });
          }
        }
      }
    }
    
    await scanDir(dirHandle);
    return files;
  }
}

/**
 * Get a URL for playing an audio file
 */
export async function getAudioFileUrl(fileInfo) {
  if (isElectron() && fileInfo.fullPath) {
    // Use Electron's file protocol
    const result = await window.electronAPI.getFileUrl(fileInfo.fullPath);
    if (result.success) {
      return result.url;
    }
    throw new Error(result.error || 'Failed to get file URL');
  } else if (fileInfo.handle) {
    // Web browser - create object URL from file handle
    const file = await fileInfo.handle.getFile();
    return URL.createObjectURL(file);
  }
  throw new Error('No file handle or path available');
}

/**
 * Save show data persistently (Electron only)
 */
export async function saveShowData(showData) {
  if (isElectron()) {
    const result = await window.electronAPI.saveShowData(showData);
    if (!result.success) {
      throw new Error(result.error || 'Failed to save show data');
    }
    return true;
  }
  return false; // Not supported in browser
}

/**
 * Load previously saved show data (Electron only)
 */
export async function loadShowData() {
  if (isElectron()) {
    const result = await window.electronAPI.loadShowData();
    if (result.success) {
      return result.data;
    }
  }
  return null;
}

/**
 * Save file path mappings for persistence (Electron only)
 */
export async function saveFileMappings(mappings) {
  if (isElectron()) {
    const result = await window.electronAPI.saveFileMappings(mappings);
    if (!result.success) {
      throw new Error(result.error || 'Failed to save file mappings');
    }
    return true;
  }
  return false;
}

/**
 * Load file path mappings (Electron only)
 */
export async function loadFileMappings() {
  if (isElectron()) {
    const result = await window.electronAPI.loadFileMappings();
    if (result.success) {
      return result.mappings;
    }
  }
  return {};
}

export { isElectron };

