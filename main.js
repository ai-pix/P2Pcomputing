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
let bestHwLabel = 'None (Software Only)';
let gpuModelName = 'Standard CPU';

async function detectHardwareAcceleration() {
  return new Promise((resolve) => {
    // 1. Get GPU Model Name
    const gpuNameProc = spawn('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name']);
    let gpuOutput = '';
    gpuNameProc.stdout.on('data', (data) => gpuOutput += data.toString());
    gpuNameProc.on('close', () => {
      const names = gpuOutput.trim().split(/\r?\n/).filter(n => n.trim());
      if (names.length > 0) {
        // Prefer NVIDIA/AMD over Intel if multiple GPUs exist (typical laptop setup)
        gpuModelName = names.find(n => n.includes('NVIDIA') || n.includes('AMD')) || names[0];
      }

      // 2. Get Available Encoders
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
            bestHwLabel = enc.label;
            console.log(`🚀 Hardware Acceleration Detected: ${enc.label} (${enc.name}) on ${gpuModelName}`);
            break;
          }
        }
        resolve(bestHwEncoder);
      });
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

/* ─── IPC Handler for Hardware Info ─── */
ipcMain.handle('ffmpeg:getHwInfo', () => ({
  encoder: bestHwEncoder,
  label: bestHwLabel,
  model: gpuModelName
}));

/* ─── IPC Handler for Real-time System Stats ─── */
let lastCpuUsage = null;
ipcMain.handle('system:getStats', () => {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  
  let cpuLoad = 0;
  if (lastCpuUsage) {
    const idleDifference = totalIdle - lastCpuUsage.idle;
    const totalDifference = totalTick - lastCpuUsage.total;
    if (totalDifference > 0) {
      cpuLoad = Math.round((1 - (idleDifference / totalDifference)) * 100);
    }
  }
  lastCpuUsage = { idle: totalIdle, total: totalTick };

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);
  
  // Model CPU temp: base is 38C, max load adds 40C, with 0-2C of jitter
  const temp = Math.round(38 + (cpuLoad * 0.4) + Math.random() * 2);

  return {
    cpuLoad,
    totalMem,
    freeMem,
    memUsage,
    temp
  };
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

/* ─── FFmpeg Helper ─── */
function runFFmpeg(args, event, jobId, progressOffset = 0, progressScale = 1) {
  return new Promise((resolve, reject) => {
    const ffmpegProc = spawn(ffmpegPath, args);
    let durationSecs = 0;

    ffmpegProc.stderr.on('data', (data) => {
      const msg = data.toString();
      // Send raw logs for the new "Terminal Output"
      event.sender.send('ffmpeg:log', { jobId, msg: msg.trim() });
      
      // Extract duration if not already known
      if (durationSecs === 0) {
        const durMatch = msg.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
        if (durMatch) {
          durationSecs = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
        }
      }

      // Extract time to report progress
      const timeMatch = msg.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (timeMatch && durationSecs > 0) {
        const currentSecs = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
        const subPct = (currentSecs / durationSecs);
        const totalPct = Math.min(100, Math.round((progressOffset + (subPct * progressScale)) * 100));
        event.sender.send('ffmpeg:progress', { jobId, pct: totalPct });
      }
    });

    ffmpegProc.on('close', (code) => {
      if (code === 0) resolve(durationSecs);
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
    
    ffmpegProc.on('error', (err) => reject(err));
  });
}

/* ─── IPC Handler for Native FFmpeg ─── */
ipcMain.handle('ffmpeg:transcode', async (event, jobId, inputPath, format, quality, mediaType = 'video', useGpu = false) => {
  if (!inputPath.startsWith(BASE_TEMP_DIR)) {
    throw new Error('Access denied: Input file outside sandbox');
  }

  const outputPath = getSafePath(jobId, `out.${format}`, true);
  tempFiles.add(outputPath);

  if (mediaType === 'image') {
    event.sender.send('ffmpeg:log', { jobId, msg: `🖼️ Processing Image: ${format} (${quality}%)` });
    const qVal = parseInt(quality) || 80;
    let formatArgs = [];
    let outputArgs = ['-frames:v', '1'];
    
    switch (format) {
      case 'webp': formatArgs = ['-c:v', 'libwebp', '-q:v', qVal.toString()]; break;
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
      default: formatArgs = ['-q:v', '5'];
    }

    const args = ['-hwaccel', 'auto', '-i', inputPath, ...formatArgs, ...outputArgs, '-y', outputPath];
    await runFFmpeg(args, event, jobId);
    return outputPath;
  }

  // Check file size for bypass threshold (100MB)
  const stats = fs.statSync(inputPath);
  const fileSizeMB = stats.size / (1024 * 1024);
  const BYPASS_THRESHOLD_MB = 100;

  if (fileSizeMB < BYPASS_THRESHOLD_MB) {
    event.sender.send('ffmpeg:log', { jobId, msg: `⚡ Small file detected (${fileSizeMB.toFixed(1)}MB < ${BYPASS_THRESHOLD_MB}MB). Bypassing parallel chunk engine...` });
    let args;
    let success = false;

    // Try GPU Path first if enabled
    if (useGpu && bestHwEncoder) {
      event.sender.send('ffmpeg:log', { jobId, msg: `⚡ Processing video using GPU...` });
      try {
        if (bestHwEncoder === 'h264_nvenc') {
          args = ['-i', inputPath, '-vf', `scale=-2:${quality},format=yuv420p`, '-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '28', '-tune', 'ull', '-zerolatency', '1', '-c:a', 'aac', '-y', outputPath];
        } else if (bestHwEncoder === 'h264_qsv') {
          args = ['-i', inputPath, '-vf', `scale=-2:${quality},format=yuv420p`, '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '28', '-c:a', 'aac', '-y', outputPath];
        } else {
          args = ['-i', inputPath, '-vf', `scale=-2:${quality},format=yuv420p`, '-c:v', bestHwEncoder, '-c:a', 'aac', '-y', outputPath];
        }
        await runFFmpeg(args, event, jobId, 0, 1);
        success = true;
      } catch (e) {
        event.sender.send('ffmpeg:log', { jobId, msg: `⚠️ GPU Failed: ${e.message}. Falling back to CPU...` });
      }
    }

    // CPU Fallback
    if (!success) {
      event.sender.send('ffmpeg:log', { jobId, msg: `🐌 Processing video using CPU (Robust Mode)...` });
      args = ['-i', inputPath, '-vf', `scale=-2:${quality},format=yuv420p`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-y', outputPath];
      await runFFmpeg(args, event, jobId, 0, 1);
    }

    event.sender.send('ffmpeg:progress', { jobId, pct: 100 });
    return outputPath;
  }

  // 🚀 Resilient Parallel Engine for Video
  event.sender.send('ffmpeg:log', { jobId, msg: `💎 Initializing Resilient Chunk Engine...` });
  
  const chunkDir = path.join(BASE_TEMP_DIR, `chunks_${jobId}`);
  if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });

  try {
    // 1. Split (5% of progress)
    event.sender.send('ffmpeg:log', { jobId, msg: `📦 PHASE 1: Splitting video into high-speed segments...` });
    const splitArgs = ['-i', inputPath, '-c', 'copy', '-map', '0', '-f', 'segment', '-segment_time', '15', '-reset_timestamps', '1', path.join(chunkDir, 'seg_%03d.mp4')];
    await runFFmpeg(splitArgs, event, jobId, 0, 0.05);

    const segments = fs.readdirSync(chunkDir).filter(f => f.startsWith('seg_')).sort();
    event.sender.send('ffmpeg:log', { jobId, msg: `🔧 PHASE 2: Detected ${segments.length} segments. Starting parallel transcode...` });

    // 2. Transcode (90% of progress)
    const CONCURRENCY = useGpu ? 2 : 1; // Safe parallel chunks for GPU, sequential for CPU
    let completed = 0;
    
    for (let i = 0; i < segments.length; i += CONCURRENCY) {
      const batch = segments.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (seg, idx) => {
        const segIndex = i + idx;
        const segInput = path.join(chunkDir, seg);
        const segOutput = path.join(chunkDir, `out_${seg}`);
        
        let args;
        let success = false;

        const progOffset = 0.05 + (segIndex / segments.length) * 0.9;
        const progScale = (1 / segments.length) * 0.9;

        // Try GPU Path first if enabled
        if (useGpu && bestHwEncoder) {
          event.sender.send('ffmpeg:log', { jobId, msg: `⚡ Processing ${seg} using GPU...` });
          try {
            if (bestHwEncoder === 'h264_nvenc') {
              // CPU Decode & Scale + NVENC GPU Encode for absolute stability & format compatibility
              args = ['-i', segInput, '-vf', `scale=-2:${quality},format=yuv420p`, '-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '28', '-tune', 'ull', '-zerolatency', '1', '-c:a', 'aac', '-y', segOutput];
            } else if (bestHwEncoder === 'h264_qsv') {
              // CPU Decode & Scale + QSV GPU Encode to avoid device initialization and scaling crashes
              args = ['-i', segInput, '-vf', `scale=-2:${quality},format=yuv420p`, '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '28', '-c:a', 'aac', '-y', segOutput];
            } else {
              // CPU Decode & Scale + Generic GPU Encode (AMD AMF, etc.) removing -hwaccel auto to avoid surface mismatches
              args = ['-i', segInput, '-vf', `scale=-2:${quality},format=yuv420p`, '-c:v', bestHwEncoder, '-c:a', 'aac', '-y', segOutput];
            }
            await runFFmpeg(args, event, jobId, progOffset, progScale);
            success = true;
          } catch (e) {
            event.sender.send('ffmpeg:log', { jobId, msg: `⚠️ GPU Failed for ${seg}: ${e.message}. Falling back to CPU...` });
          }
        }

        // CPU Fallback
        if (!success) {
          event.sender.send('ffmpeg:log', { jobId, msg: `🐌 Processing ${seg} using CPU (Robust Mode)...` });
          args = ['-i', segInput, '-vf', `scale=-2:${quality},format=yuv420p`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-y', segOutput];
          await runFFmpeg(args, event, jobId, progOffset, progScale);
        }

        completed++;
        const totalPct = 0.05 + (completed / segments.length) * 0.9;
        event.sender.send('ffmpeg:progress', { jobId, pct: Math.round(totalPct * 100) });
      }));
    }

    // 3. Merge (5% of progress)
    event.sender.send('ffmpeg:log', { jobId, msg: `🔗 PHASE 3: Merging segments into final stream...` });
    const concatListPath = path.join(chunkDir, 'list.txt');
    const concatList = segments.map(seg => `file 'out_${seg}'`).join('\n');
    fs.writeFileSync(concatListPath, concatList);

    const mergeArgs = ['-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-y', outputPath];
    await runFFmpeg(mergeArgs, event, jobId, 0.95, 0.05);

    event.sender.send('ffmpeg:log', { jobId, msg: `✅ Job Success! Cleaning up...` });
    try {
      const files = fs.readdirSync(chunkDir);
      for (const f of files) fs.unlinkSync(path.join(chunkDir, f));
      fs.rmdirSync(chunkDir);
    } catch (e) {}

    return outputPath;
  } catch (err) {
    event.sender.send('ffmpeg:log', { jobId, msg: `❌ CRITICAL ENGINE STALL: ${err.message}` });
    throw err;
  }
});
