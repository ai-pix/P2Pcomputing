const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // File I/O
  createTempWriteStream: (jobId, extension) => ipcRenderer.invoke('fs:createTempWrite', jobId, extension),
  writeTempChunk: (jobId, buffer) => ipcRenderer.invoke('fs:writeTempChunk', jobId, buffer),
  finishTempWrite: (jobId) => ipcRenderer.invoke('fs:finishTempWrite', jobId),
  
  readOutputFileChunk: (path, start, end) => ipcRenderer.invoke('fs:readChunk', path, start, end),
  getFileSize: (path) => ipcRenderer.invoke('fs:getSize', path),
  deleteFile: (path) => ipcRenderer.invoke('fs:delete', path),
  saveOutputFile: (tempPath, defaultName) => ipcRenderer.invoke('fs:saveOutputFile', tempPath, defaultName),

  // FFmpeg
  transcode: (jobId, inputPath, format, quality, mediaType, useGpu = false) => ipcRenderer.invoke('ffmpeg:transcode', jobId, inputPath, format, quality, mediaType, useGpu),
  getHwInfo: () => ipcRenderer.invoke('ffmpeg:getHwInfo'),
  getSystemStats: () => ipcRenderer.invoke('system:getStats'),
  onTranscodeProgress: (callback) => {
    const handler = (e, data) => callback(data);
    ipcRenderer.on('ffmpeg:progress', handler);
    return () => ipcRenderer.off('ffmpeg:progress', handler);
  },
  onTranscodeLog: (callback) => {
    const handler = (e, data) => callback(data);
    ipcRenderer.on('ffmpeg:log', handler);
    return () => ipcRenderer.off('ffmpeg:log', handler);
  },

  // Window Controls
  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('win:maximize'),
  closeWindow: () => ipcRenderer.invoke('win:close'),

  // Desktop OS Notifications
  sendNotification: (title, message) => ipcRenderer.invoke('notification:send', title, message),

  // Auto-Updater
  onUpdateAvailable: (callback) => {
    const handler = (e, data) => callback(data);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.off('update:available', handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (e, data) => callback(data);
    ipcRenderer.on('update:downloaded', handler);
    return () => ipcRenderer.off('update:downloaded', handler);
  },
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install')
});
