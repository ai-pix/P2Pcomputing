import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  // File I/O
  createTempWriteStream: (jobId: string, extension: string) => ipcRenderer.invoke('fs:createTempWrite', jobId, extension),
  writeTempChunk: (jobId: string, buffer: any) => ipcRenderer.invoke('fs:writeTempChunk', jobId, buffer),
  finishTempWrite: (jobId: string) => ipcRenderer.invoke('fs:finishTempWrite', jobId),
  
  readOutputFileChunk: (path: string, start: number, end: number) => ipcRenderer.invoke('fs:readChunk', path, start, end),
  getFileSize: (path: string) => ipcRenderer.invoke('fs:getSize', path),
  deleteFile: (path: string) => ipcRenderer.invoke('fs:delete', path),
  saveOutputFile: (tempPath: string, defaultName: string) => ipcRenderer.invoke('fs:saveOutputFile', tempPath, defaultName),

  // FFmpeg
  transcode: (jobId: string, inputPath: string, format: string, quality: string, mediaType: string, useGpu = false) => ipcRenderer.invoke('ffmpeg:transcode', jobId, inputPath, format, quality, mediaType, useGpu),
  getHwInfo: () => ipcRenderer.invoke('ffmpeg:getHwInfo'),
  getSystemStats: () => ipcRenderer.invoke('system:getStats'),
  getNodeIdentity: () => ipcRenderer.invoke('identity:get'),
  runBenchmark: (useGpu: boolean) => ipcRenderer.invoke('system:runBenchmark', useGpu),
  onTranscodeProgress: (callback: (data: { jobId: string; pct: number }) => void) => {
    const handler = (e: any, data: any) => callback(data);
    ipcRenderer.on('ffmpeg:progress', handler);
    return () => { ipcRenderer.off('ffmpeg:progress', handler); };
  },
  onTranscodeLog: (callback: (data: { jobId: string; msg: string }) => void) => {
    const handler = (e: any, data: any) => callback(data);
    ipcRenderer.on('ffmpeg:log', handler);
    return () => { ipcRenderer.off('ffmpeg:log', handler); };
  },

  // Window Controls
  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('win:maximize'),
  closeWindow: () => ipcRenderer.invoke('win:close'),

  // Desktop OS Notifications
  sendNotification: (title: string, message: string) => ipcRenderer.invoke('notification:send', title, message),

  // Auto-Updater
  onUpdateAvailable: (callback: (data: { version: string; releaseDate?: string }) => void) => {
    const handler = (e: any, data: any) => callback(data);
    ipcRenderer.on('update:available', handler);
    return () => { ipcRenderer.off('update:available', handler); };
  },
  onUpdateDownloaded: (callback: (data: { version: string }) => void) => {
    const handler = (e: any, data: any) => callback(data);
    ipcRenderer.on('update:downloaded', handler);
    return () => { ipcRenderer.off('update:downloaded', handler); };
  },
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install')
});
