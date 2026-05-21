const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
// In packaged Electron builds, the binary lives in app.asar.unpacked/
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

let mainWindow;
let tray = null;
let isQuitting = false;

// Secure base directory for all file operations
const BASE_TEMP_DIR = path.join(os.tmpdir(), 'transcodenet-work');
if (!fs.existsSync(BASE_TEMP_DIR)) fs.mkdirSync(BASE_TEMP_DIR, { recursive: true });

// Store open write streams for incoming files
const writeStreams = new Map();
const tempFiles = new Set();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'TranscodeNet',
    frame: false, // frameless window for custom premium titlebar
    titleBarStyle: 'hidden', // hides native titlebar text, allows custom bar
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true // Enable sandbox for better security
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  
  // Intercept window close to hide to tray
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      showTrayNotification(
        'TranscodeNet is running in the background',
        'Your node remains active to host transcoding tasks. Double-click the tray icon to restore.'
      );
    }
    return false;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    cleanupTempFiles();
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'public', 'assets', 'icon.png');
  if (!fs.existsSync(iconPath)) {
    console.error('Tray icon not found:', iconPath);
    return;
  }
  
  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show TranscodeNet',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Application',
      click: () => {
        isQuitting = true;
        cleanupTempFiles();
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('TranscodeNet Node');
  tray.setContextMenu(contextMenu);
  
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function showTrayNotification(title, message) {
  if (Notification.isSupported()) {
    new Notification({
      title: title,
      body: message,
      icon: path.join(__dirname, 'public', 'assets', 'icon.png')
    }).show();
  }
}

function cleanupTempFiles() {
  // 1. Clean up files tracked in current session
  for (const file of tempFiles) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) {
      console.error('Failed to cleanup temp file:', file);
    }
  }
  tempFiles.clear();

  // 2. Also clean up any abandoned files in our BASE_TEMP_DIR on startup/shutdown
  try {
    const files = fs.readdirSync(BASE_TEMP_DIR);
    for (const file of files) {
      const fullPath = path.join(BASE_TEMP_DIR, file);
      // Only delete files older than 1 hour to avoid deleting active session files if multiple instances run
      const stats = fs.statSync(fullPath);
      if (Date.now() - stats.mtimeMs > 3600000) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch (e) {
    console.error('Deep cleanup failed:', e);
  }
}

// Helper to ensure path is within BASE_TEMP_DIR
function getSafePath(jobId, fileName, isOutput = false) {
  const safeJobId = jobId.toString().replace(/[^a-zA-Z0-9_-]/g, '');
  const suffix = isOutput ? '_out' : '_in';
  
  let ext = path.extname(fileName).toLowerCase();
  const allowedExts = ['.mp4', '.webm', '.avi', '.mkv', '.mov', '.webp', '.jpg', '.jpeg', '.png', '.bin'];
  if (!allowedExts.includes(ext)) ext = '.bin';

  const safeName = `job_${safeJobId}${suffix}${ext}`;
  const finalPath = path.join(BASE_TEMP_DIR, safeName);
  
  if (!finalPath.startsWith(BASE_TEMP_DIR)) {
    throw new Error('Invalid path attempt');
  }
  return finalPath;
}

let bestHwEncoder = null;

async function detectHardwareAcceleration() {
  return new Promise((resolve) => {
    const encodersToTry = [
      { name: 'h264_nvenc', label: 'NVIDIA NVENC' },
      { name: 'h264_amf', label: 'AMD AMF' },
      { name: 'h264_qsv', label: 'Intel QuickSync' },
      { name: 'h264_vulkan', label: 'Vulkan/TPU Accelerator' },
      { name: 'h264_mf', label: 'Windows Media Foundation' },
      { name: 'h264_vaapi', label: 'Generic VAAPI' }
    ];

    const args = ['-encoders'];
    const ffmpegProc = spawn(ffmpegPath, args);
    let output = '';

    ffmpegProc.stdout.on('data', (data) => output += data.toString());
    ffmpegProc.on('close', () => {
      for (const enc of encodersToTry) {
        if (output.includes(enc.name)) {
          bestHwEncoder = enc.name;
          console.log(`🚀 Hardware Acceleration Detected: ${enc.label} (${enc.name})`);
          break;
        }
      }
      resolve(bestHwEncoder);
    });
  });
}

app.whenReady().then(async () => {
  cleanupTempFiles(); // Clean up old files on startup
  await detectHardwareAcceleration();
  createWindow();
  createTray();

  // ─── Auto-Updater Setup ───
  autoUpdater.autoDownload = false; // Don't auto-download, let the user choose
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    if (mainWindow) {
      mainWindow.webContents.send('update:available', {
        version: info.version,
        releaseDate: info.releaseDate
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) {
      mainWindow.webContents.send('update:downloaded', {
        version: info.version
      });
    }
  });

  // Check for updates 3 seconds after launch
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.log('Auto-updater check skipped:', err.message);
    });
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ─── IPC Handlers for Custom Titlebar Window Control ─── */
ipcMain.handle('win:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('win:maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('win:close', () => {
  if (mainWindow) mainWindow.close(); // Triggers the 'close' event above (hides to tray)
});

/* ─── IPC Handler for Native OS Notifications ─── */
ipcMain.handle('notification:send', (event, title, message) => {
  showTrayNotification(title, message);
});

/* ─── IPC Handlers for Auto-Updater ─── */
ipcMain.handle('update:download', () => {
  autoUpdater.downloadUpdate().catch(err => {
    console.error('Update download failed:', err.message);
  });
});

ipcMain.handle('update:install', () => {
  isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
});

/* ─── IPC Handlers for File I/O (Chunked) ─── */
ipcMain.handle('fs:createTempWrite', (event, jobId, extension) => {
  const tempPath = getSafePath(jobId, `file${extension}`);
  tempFiles.add(tempPath);
  
  const stream = fs.createWriteStream(tempPath);
  stream.on('error', (err) => {
    console.error(`Stream error for job ${jobId}:`, err);
    writeStreams.delete(jobId);
  });

  writeStreams.set(jobId, stream);
  return tempPath;
});

ipcMain.handle('fs:writeTempChunk', (event, jobId, buffer) => {
  return new Promise((resolve, reject) => {
    const stream = writeStreams.get(jobId);
    if (!stream) return reject(new Error('Stream not found or closed due to error'));
    
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const canWrite = stream.write(buf, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

ipcMain.handle('fs:finishTempWrite', (event, jobId) => {
  return new Promise((resolve, reject) => {
    const stream = writeStreams.get(jobId);
    if (!stream) return reject(new Error('Stream not found'));
    
    stream.end(() => {
      writeStreams.delete(jobId);
      resolve(stream.path);
    });
  });
});

ipcMain.handle('fs:getSize', (event, filePath) => {
  try {
    if (!filePath.startsWith(BASE_TEMP_DIR)) return 0;
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch (e) {
    return 0;
  }
});

ipcMain.handle('fs:readChunk', (event, filePath, start, end) => {
  return new Promise((resolve, reject) => {
    if (!filePath.startsWith(BASE_TEMP_DIR)) {
      return reject(new Error('Access denied: File outside sandbox'));
    }

    const stream = fs.createReadStream(filePath, { start, end });
    const chunks = [];
    
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
});

ipcMain.handle('fs:delete', (event, filePath) => {
  try {
    if (filePath.startsWith(BASE_TEMP_DIR) && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      tempFiles.delete(filePath);
    }
  } catch (e) {
    console.error(e);
  }
});

ipcMain.handle('fs:saveOutputFile', async (event, filePath, defaultName = 'output.bin') => {
  if (!filePath.startsWith(BASE_TEMP_DIR) || !fs.existsSync(filePath)) {
    throw new Error('Access denied: File outside sandbox');
  }

  const { canceled, filePath: destinationPath } = await dialog.showSaveDialog({
    defaultPath: defaultName
  });

  if (canceled || !destinationPath) {
    return { canceled: true };
  }

  fs.copyFileSync(filePath, destinationPath);
  return { canceled: false, filePath: destinationPath };
});

/* ─── IPC Handler for Native FFmpeg ─── */
ipcMain.handle('ffmpeg:transcode', (event, jobId, inputPath, format, quality, mediaType = 'video', useGpu = false) => {
  return new Promise((resolve, reject) => {
    if (!inputPath.startsWith(BASE_TEMP_DIR)) {
      return reject(new Error('Access denied: Input file outside sandbox'));
    }

    const outputPath = getSafePath(jobId, `out.${format}`, true);
    tempFiles.add(outputPath);

    let formatArgs = [];
    let vfArgs = [];
    let outputArgs = [];
    
    if (mediaType === 'image') {
      const qVal = parseInt(quality) || 80;
      outputArgs = ['-frames:v', '1'];
      
      switch (format) {
        case 'webp': 
          formatArgs = ['-c:v', 'libwebp', '-q:v', qVal.toString()]; 
          break;
        case 'jpg': 
          const qscale = qVal === 100 ? 2 : (qVal >= 80 ? 5 : 15);
          formatArgs = ['-q:v', qscale.toString()];
          outputArgs.push('-update', '1');
          break;
        case 'png': 
          const compressionLevel = qVal === 100 ? 9 : (qVal >= 80 ? 6 : 3);
          formatArgs = ['-compression_level', compressionLevel.toString()];
          outputArgs.push('-update', '1');
          break;
        default: 
          formatArgs = ['-q:v', '5'];
      }
    } else {
      vfArgs = ['-vf', `scale=-2:${quality}`];
      
      switch (format) {
        case 'mp4': 
          if (useGpu && bestHwEncoder) {
            // Use the best detected hardware encoder
            formatArgs = ['-c:v', bestHwEncoder];
            
            // Add encoder-specific tuning
            if (bestHwEncoder === 'h264_nvenc') {
              formatArgs.push('-preset', 'p4', '-rc', 'vbr', '-cq', '23');
            } else if (bestHwEncoder === 'h264_amf') {
              formatArgs.push('-quality', 'speed', '-rc', 'vbr_latency');
            } else if (bestHwEncoder === 'h264_qsv') {
              formatArgs.push('-preset', 'fast', '-global_quality', '23');
            } else if (bestHwEncoder === 'h264_vulkan') {
              formatArgs.push('-preset', 'fast');
            } else if (bestHwEncoder === 'h264_mf') {
              formatArgs.push('-rate_control_mode', '1', '-bitrate', '2000000');
            }
            
            formatArgs.push('-c:a', 'aac', '-b:a', '128k');
          } else {
            formatArgs = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k'];
          }
          break;
        case 'webm': 
          formatArgs = ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-c:a', 'libopus']; 
          break;
        case 'avi': 
          formatArgs = ['-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'mp3']; 
          break;
        case 'mkv': 
          if (useGpu && bestHwEncoder) {
            formatArgs = ['-c:v', bestHwEncoder];
            if (bestHwEncoder === 'h264_nvenc') {
              formatArgs.push('-preset', 'p4', '-rc', 'vbr', '-cq', '23');
            }
            formatArgs.push('-c:a', 'aac');
          } else {
            formatArgs = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac'];
          }
          break;
        default: 
          formatArgs = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23'];
      }
    }

    const args = [
      '-i', inputPath,
      ...vfArgs,
      ...formatArgs,
      ...outputArgs,
      '-y', // Overwrite output
      outputPath
    ];

    event.sender.send('ffmpeg:log', { jobId, msg: `ffmpeg ${args.join(' ')}` });

    const ffmpegProc = spawn(ffmpegPath, args);
    let durationSecs = 0;

    ffmpegProc.stderr.on('data', (data) => {
      const msg = data.toString();
      event.sender.send('ffmpeg:log', { jobId, msg: msg.trim() });
      
      if (durationSecs === 0) {
        const durMatch = msg.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
        if (durMatch) {
          durationSecs = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
        }
      }

      const timeMatch = msg.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (timeMatch && durationSecs > 0) {
        const currentSecs = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
        const pct = Math.min(100, Math.round((currentSecs / durationSecs) * 100));
        event.sender.send('ffmpeg:progress', { jobId, pct });
      }
    });

    ffmpegProc.on('close', (code) => {
      if (code === 0) {
        event.sender.send('ffmpeg:progress', { jobId, pct: 100 });
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    
    ffmpegProc.on('error', (err) => {
      reject(err);
    });
  });
});
