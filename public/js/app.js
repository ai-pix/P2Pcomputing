/* ─── Main App — State Management & Orchestration ─── */
const app = {
  role: null,        // 'client' | 'provider'
  queue: [],         // batch queue of files to process
  peers: new Map(),  // remoteProviderId -> PeerConnection
  activeQueueItem: null, // active item in the queue
  currentJobId: null,
  pendingJobId: null,
  peer: null,        // current/fallback PeerConnection
  resultBlob: null,
  resultMeta: null,
  resultIsNative: false,
  historyData: [],   // cached history from server
  jobLogs: [],       // logs collected during current job
  ffmpegLogUnsubscribe: null,
  ffmpegProgressUnsubscribe: null,

  /* Provider state */
  providerOnline: false,
  provJobsDone: 0,
  provDataProcessed: 0,
  provStartTime: null,
  uptimeInterval: null,
  statsInterval: null,
  lastSystemStats: null,

  /* ─── Init ─── */
  init() {
    this.role = 'client';
    if (window.api) {
      document.body.classList.add('is-electron');

      // Listen for auto-updater events
      window.api.onUpdateAvailable((data) => {
        this._pendingUpdateVersion = data.version;
        this._showUpdateCard('available', data.version);
      });
      window.api.onUpdateDownloaded((data) => {
        this._showUpdateCard('downloaded', data.version);
      });

      // Fetch and display hardware info
      window.api.getHwInfo().then(info => {
        const display = document.getElementById('hwInfoDisplay');
        const label = document.getElementById('detectedHwLabel');
        if (display && label) {
          display.style.display = 'flex';
          const modelStr = info.model ? ` on ${info.model}` : '';
          label.textContent = (info.label || 'None (Software Only)') + modelStr;
          if (!info.encoder) {
            label.style.color = 'var(--text-muted)';
          } else {
            label.style.color = 'var(--amber)';
            label.style.fontWeight = '800';
            // Auto-enable GPU if detected
            const gpuCheck = document.getElementById('srvGpu');
            if (gpuCheck) {
              gpuCheck.checked = true;
              this.updateProviderServices();
            }
          }
        }
      });
    } else {
      // Hide Share Compute in web version
      const navShareCompute = document.getElementById('navShareCompute');
      if (navShareCompute) navShareCompute.style.display = 'none';
      
      const viewProvider = document.getElementById('viewProvider');
      if (viewProvider) viewProvider.style.display = 'none';

      const gpuToggle = document.getElementById('gpuToggleLabel');
      if (gpuToggle) gpuToggle.style.display = 'none';
    }
    signaling.connect();
    signaling.on('welcome', (msg) => {
      UI.updateStats(msg.stats);
      UI.setText('clientPeerId', signaling.peerId || 'Offline');
    });
    signaling.on('stats', (msg) => UI.updateStats(msg));

    /* ── Client events ── */
    signaling.on('job-created', (msg) => {
      this.currentJobId = msg.jobId;
      if (this.activeQueueItem) {
        this.activeQueueItem.jobId = msg.jobId;
        this.activeQueueItem.status = 'matching';
        this.renderQueue();
      }
    });

    signaling.on('job-matched', (msg) => {
      const item = this.queue.find(q => q.jobId === msg.jobId || (this.activeQueueItem && this.activeQueueItem.jobId === msg.jobId));
      if (!item) return;

      item.status = 'connecting';
      item.providerId = msg.providerId;
      this.renderQueue();

      UI.toast(`Provider found for ${item.file.name}! Establishing P2P connection...`, 'success');
      this.notifyUser('Provider Found', `Establishing P2P connection to process ${item.file.name}...`);

      // Create WebRTC connection as initiator
      const peer = new PeerConnection(msg.jobId);
      this.peers.set(msg.providerId, peer);
      this.peer = peer; // Fallback reference

      peer.onConnected = () => {
        item.status = 'uploading';
        this.renderQueue();
        UI.toast(`P2P connected for ${item.file.name}! Uploading...`, 'success');
        this._sendFileToProvider(item, peer);
      };
      
      peer.onProgress = (stage, pct) => {
        if (stage === 'sending') {
          item.status = 'uploading';
          item.progress = pct;
        } else if (stage === 'transcoding') {
          item.status = 'transcoding';
          item.progress = pct;
        } else if (stage === 'receiving') {
          item.status = 'downloading';
          item.progress = pct;
        }
        this.renderQueue();
      };
      
      peer.onFileReceived = async (resultData, meta, isNative) => {
        item.status = 'complete';
        item.progress = 100;
        item.resultBlob = resultData;
        item.resultMeta = meta;
        item.resultIsNative = !!isNative;
        this.renderQueue();

        UI.toast(`Transcoding complete for ${item.file.name}! 🎉`, 'success');
        this.notifyUser('Transcoding Complete', `Finished transcoding output: ${meta.fileName}`);

        // Cleanup WebRTC connection
        peer.close();
        this.peers.delete(msg.providerId);
        if (this.peer === peer) this.peer = null;

        // Process next item in the queue
        this.activeQueueItem = null;
        this.processQueue();
      };

      peer.createOffer(msg.providerId);
    });

    signaling.on('job-progress', (msg) => {
      const item = this.queue.find(q => q.jobId === msg.jobId);
      if (item && msg.stage === 'transcoding') {
        item.status = 'transcoding';
        item.progress = msg.progress;
        this.renderQueue();
      }
    });

    signaling.on('job-failed', (msg) => {
      const item = this.queue.find(q => q.jobId === msg.jobId);
      if (item) {
        item.status = 'failed';
        item.error = msg.error || 'Unknown error';
        this.renderQueue();
        UI.toast(`Job failed for ${item.file.name}: ${item.error}`, 'error');

        if (item.providerId) {
          const peer = this.peers.get(item.providerId);
          if (peer) {
            peer.close();
            this.peers.delete(item.providerId);
          }
        }
        if (this.activeQueueItem === item) {
          this.activeQueueItem = null;
        }
        this.processQueue();
      }
    });

    /* ── Provider events ── */
    signaling.on('job-available', (msg) => {
      if (this.role !== 'provider' || !this.providerOnline) return;

      const s = msg.settings;
      const maxFileSizeMB = parseFloat(document.getElementById('srvMaxFileSize').value);
      const maxFileSizeBytes = maxFileSizeMB * 1024 * 1024;
      const cpuLimit = parseFloat(document.getElementById('srvCpuLimit').value);

      // Check CPU utilization policy
      let cpuPass = true;
      if (this.lastSystemStats && this.lastSystemStats.cpu > cpuLimit) {
        cpuPass = false;
      }

      // Check size policy
      let sizePass = true;
      if (s.fileSize > maxFileSizeBytes) {
        sizePass = false;
      }

      // Update UI policy badges
      const cpuBadge = document.getElementById('policyCpuBadge');
      if (cpuBadge) {
        if (cpuPass) {
          cpuBadge.textContent = '✓ CPU Policy Pass';
          cpuBadge.classList.remove('fail');
        } else {
          cpuBadge.textContent = '✗ CPU Policy Fail';
          cpuBadge.classList.add('fail');
        }
      }

      const sizeBadge = document.getElementById('policySizeBadge');
      if (sizeBadge) {
        if (sizePass) {
          sizeBadge.textContent = '✓ Size Policy Pass';
          sizeBadge.classList.remove('fail');
        } else {
          sizeBadge.textContent = '✗ Size Policy Fail';
          sizeBadge.classList.add('fail');
        }
      }

      // Automatically reject (ignore) if policies are not compliant
      if (!cpuPass || !sizePass) {
        console.log(`Decline job ${msg.jobId}: CPU pass=${cpuPass}, Size pass=${sizePass}`);
        return;
      }

      this.pendingJobId = msg.jobId;

      // Auto-Accept verification check
      const autoAccept = document.getElementById('srvAutoAccept').checked;
      if (autoAccept) {
        console.log(`Auto-accepting job ${msg.jobId}`);
        UI.toast(`Auto-accepting job ${msg.jobId}...`, 'info');
        this.acceptJob();
      } else {
        UI.setText('jobNotifDetails',
          `File: ${s.fileName}\nSize: ${UI.formatBytes(s.fileSize)}\nFormat: ${this._formatJobOutput(s)}`
        );
        UI.show('jobNotification');
        UI.hideEl('providerIdle');
        this.notifyUser('Incoming Job Request', `File: ${s.fileName} (${UI.formatBytes(s.fileSize)})`);
      }
    });

    signaling.on('job-taken', () => {
      UI.hide('jobNotification');
      this.pendingJobId = null;
    });

    signaling.on('job-accepted', (msg) => {
      UI.hide('jobNotification');
      UI.show('processingView');
      UI.setText('provJobId', msg.jobId);
      UI.setStage('provStageReceive', 'active', 'connecting...');
    });

    signaling.on('job-cancelled', () => {
      UI.toast('Client cancelled the job', 'error');
      this._providerReset();
    });

    /* ── WebRTC signaling relay ── */
    signaling.on('offer', async (msg) => {
      if (this.role === 'provider') {
        this.peer = new PeerConnection(this.currentJobId);
        this._setupProviderPeer();
        await this.peer.handleOffer(msg);
      }
    });

    signaling.on('answer', async (msg) => {
      if (this.role === 'client') {
        const peer = this.peers.get(msg.from);
        if (peer) await peer.handleAnswer(msg);
      } else {
        if (this.peer) await this.peer.handleAnswer(msg);
      }
    });

    signaling.on('ice-candidate', async (msg) => {
      if (this.role === 'client') {
        const peer = this.peers.get(msg.from);
        if (peer) await peer.handleIceCandidate(msg);
      } else {
        if (this.peer) await this.peer.handleIceCandidate(msg);
      }
    });

    /* Drag and drop */
    UI.setupDragDrop('uploadZone', 'fileInput', (files) => this._handleFile(files));
  },

  /* ─── Navigation ─── */
  switchTab(tabId, btnEl) {
    document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');

    document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    const viewTitle = document.getElementById('viewTitle');
    const viewSubtitle = document.getElementById('viewSubtitle');
    if (tabId === 'viewClient') {
      this.role = 'client';
      viewTitle.textContent = 'Transcode Media';
      viewSubtitle.textContent = 'Decentralized P2P transcoding engine';
    } else if (tabId === 'viewProvider') {
      this.role = 'provider';
      viewTitle.textContent = 'Share Compute';
      viewSubtitle.textContent = 'Host worker nodes and receive encoding jobs';
      signaling.send({ type: 'register-provider', services: this.getProviderServices() });
      UI.toast('Registered as compute provider', 'success');
    } else if (tabId === 'viewHistory') {
      viewTitle.textContent = 'Job History';
      viewSubtitle.textContent = 'Decentralized job transaction logs and statistics';
      this.refreshHistory();
    }
  },

  /* ─── Client: Batch queue management ─── */
  _handleFile(files) {
    if (!files || !files.length) return;
    
    let addedCount = 0;
    const MAX_SIZE = 500 * 1024 * 1024;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > MAX_SIZE) {
        UI.toast(`File "${file.name}" too large! Max 500MB.`, 'error');
        continue;
      }
      
      const isVideo = file.type.startsWith('video/');
      const isImage = file.type.startsWith('image/');
      
      if (!isVideo && !isImage) {
        UI.toast(`File "${file.name}" is not a supported media type.`, 'error');
        continue;
      }

      const itemId = 'qitem-' + Math.random().toString(36).substr(2, 9);
      const format = isVideo ? 'mp4' : 'webp';
      const quality = isVideo ? '1080' : '80';

      this.queue.push({
        id: itemId,
        file: file,
        mediaType: isVideo ? 'video' : 'image',
        format: format,
        quality: quality,
        status: 'queued',
        progress: 0,
        jobId: null,
        providerId: null,
        resultBlob: null,
        resultMeta: null,
        resultIsNative: false,
        error: null
      });

      addedCount++;
    }

    if (addedCount > 0) {
      UI.toast(`Added ${addedCount} file(s) to queue`, 'success');
      UI.show('queueCard');
      this.renderQueue();
    }
  },

  updateQueueItemConfig(id, key, value) {
    const item = this.queue.find(q => q.id === id);
    if (item && item.status === 'queued') {
      item[key] = value;
    }
  },

  removeQueueItem(id) {
    const idx = this.queue.findIndex(q => q.id === id);
    if (idx !== -1) {
      const item = this.queue[idx];
      if (['matching', 'connecting', 'uploading', 'transcoding', 'downloading'].includes(item.status)) {
        UI.toast('Cannot remove an active job from the queue.', 'error');
        return;
      }
      this.queue.splice(idx, 1);
      this.renderQueue();
    }
  },

  clearQueue() {
    const hasActive = this.queue.some(q => ['matching', 'connecting', 'uploading', 'transcoding', 'downloading'].includes(q.status));
    if (hasActive) {
      UI.toast('Cannot clear queue while a job is running.', 'error');
      return;
    }
    this.queue = [];
    this.renderQueue();
    UI.hide('queueCard');
  },

  startQueue() {
    this.processQueue();
  },

  processQueue() {
    if (this.role !== 'client') return;
    
    // Check if any job is currently processing/active
    const isBusy = this.queue.some(q => ['matching', 'connecting', 'uploading', 'transcoding', 'downloading'].includes(q.status));
    if (isBusy) {
      console.log('Queue is busy. Waiting for active job...');
      return;
    }

    // Find first queued item
    const nextItem = this.queue.find(q => q.status === 'queued');
    if (!nextItem) {
      UI.toast('All queued jobs finished!', 'success');
      return;
    }

    this.activeQueueItem = nextItem;
    nextItem.status = 'matching';
    this.renderQueue();

    UI.toast(`Posting job for ${nextItem.file.name}...`, 'info');

    signaling.send({
      type: 'post-job',
      settings: {
        fileName: nextItem.file.name,
        fileSize: nextItem.file.size,
        mediaType: nextItem.mediaType,
        format: nextItem.format,
        quality: nextItem.quality
      }
    });
  },

  /* ─── Client: Send file to provider ─── */
  async _sendFileToProvider(item, peer) {
    try {
      await peer.sendFile(item.file, {
        format: item.format,
        quality: item.quality,
        mediaType: item.mediaType
      });
      item.status = 'transcoding';
      item.progress = 0;
      this.renderQueue();
    } catch (e) {
      signaling.send({
        type: 'job-upload-failed',
        jobId: item.jobId || this.currentJobId,
        error: e.message
      });
      peer.close();
      this.peers.delete(item.providerId);
      if (this.peer === peer) this.peer = null;
      
      item.status = 'failed';
      item.error = e.message;
      this.renderQueue();
      UI.toast(`Upload failed for ${item.file.name}: ${e.message}`, 'error');
      
      this.activeQueueItem = null;
      this.processQueue();
    }
  },

  /* ─── Client: Download result ─── */
  async downloadQueueItem(itemId) {
    const item = this.queue.find(q => q.id === itemId);
    if (!item || !item.resultBlob) return;

    const format = item.resultMeta?.format || item.format;
    const baseName = item.file.name.replace(/\.[^.]+$/, '');
    const defaultName = item.resultMeta?.fileName || `${baseName}_transcoded.${format}`;

    if (item.resultIsNative && window.api) {
      const saveResult = await window.api.saveOutputFile(item.resultBlob, defaultName);
      if (!saveResult?.canceled) UI.toast('Output saved successfully', 'success');
      return;
    }

    const url = URL.createObjectURL(item.resultBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(url);
  },

  renderQueue() {
    const queueList = document.getElementById('queueList');
    if (!queueList) return;

    if (this.queue.length === 0) {
      queueList.innerHTML = '<div style="text-align:center; padding:32px; color:var(--text-muted); font-size:0.9rem;">Queue is empty. Drop files to add them.</div>';
      UI.setText('queueTotalVal', 0);
      UI.setText('queueCompleteVal', 0);
      UI.setText('queueFailedVal', 0);
      UI.setText('queueActiveJobId', '—');
      return;
    }

    const total = this.queue.length;
    const completed = this.queue.filter(q => q.status === 'complete').length;
    const failed = this.queue.filter(q => q.status === 'failed').length;
    
    UI.setText('queueTotalVal', total);
    UI.setText('queueCompleteVal', completed);
    UI.setText('queueFailedVal', failed);
    
    if (this.activeQueueItem && this.activeQueueItem.jobId) {
      UI.setText('queueActiveJobId', this.activeQueueItem.jobId);
    } else {
      UI.setText('queueActiveJobId', '—');
    }

    queueList.innerHTML = '';
    const fragment = document.createDocumentFragment();

    this.queue.forEach(item => {
      const el = document.createElement('div');
      el.className = 'queue-item';
      el.dataset.id = item.id;

      const isVideo = item.mediaType === 'video';
      const isQueued = item.status === 'queued';
      const isProcessing = ['matching', 'connecting', 'uploading', 'transcoding', 'downloading'].includes(item.status);
      const isComplete = item.status === 'complete';
      
      let formatOptions = '';
      if (isVideo) {
        formatOptions = `
          <option value="mp4" ${item.format === 'mp4' ? 'selected' : ''}>MP4 (H.264)</option>
          <option value="webm" ${item.format === 'webm' ? 'selected' : ''}>WebM (VP9)</option>
          <option value="avi" ${item.format === 'avi' ? 'selected' : ''}>AVI</option>
          <option value="mkv" ${item.format === 'mkv' ? 'selected' : ''}>MKV</option>
        `;
      } else {
        formatOptions = `
          <option value="webp" ${item.format === 'webp' ? 'selected' : ''}>WebP</option>
          <option value="jpg" ${item.format === 'jpg' ? 'selected' : ''}>JPG</option>
          <option value="png" ${item.format === 'png' ? 'selected' : ''}>PNG</option>
        `;
      }

      let qualityOptions = '';
      if (isVideo) {
        qualityOptions = `
          <option value="720" ${item.quality === '720' ? 'selected' : ''}>720p</option>
          <option value="1080" ${item.quality === '1080' ? 'selected' : ''}>1080p</option>
          <option value="1440" ${item.quality === '1440' ? 'selected' : ''}>1440p</option>
          <option value="2160" ${item.quality === '2160' ? 'selected' : ''}>4K</option>
        `;
      } else {
        qualityOptions = `
          <option value="100" ${item.quality === '100' ? 'selected' : ''}>100%</option>
          <option value="80" ${item.quality === '80' ? 'selected' : ''}>80%</option>
          <option value="50" ${item.quality === '50' ? 'selected' : ''}>50%</option>
        `;
      }

      el.innerHTML = `
        <div class="queue-item-left">
          <span class="queue-item-icon">${isVideo ? '🎞️' : '📸'}</span>
          <div class="queue-item-details">
            <div class="queue-item-name" title="${item.file.name}">${item.file.name}</div>
            <div class="queue-item-size">${UI.formatBytes(item.file.size)}</div>
          </div>
        </div>
        <div class="queue-item-configs">
          <select class="queue-select queue-format" onchange="app.updateQueueItemConfig('${item.id}', 'format', this.value)" ${!isQueued ? 'disabled' : ''}>
            ${formatOptions}
          </select>
          <select class="queue-select queue-quality" onchange="app.updateQueueItemConfig('${item.id}', 'quality', this.value)" ${!isQueued ? 'disabled' : ''}>
            ${qualityOptions}
          </select>
        </div>
        <div class="queue-item-status-wrap">
          <span class="queue-item-status status-${item.status}">${item.status}${isProcessing ? ` (${Math.round(item.progress)}%)` : ''}</span>
          <div class="queue-item-progress-bar" style="display: ${isProcessing ? 'block' : 'none'}">
            <div class="queue-item-progress-fill" style="width: ${item.progress}%"></div>
          </div>
        </div>
        <div class="queue-item-actions">
          <button class="btn btn-success btn-xs download-btn" onclick="app.downloadQueueItem('${item.id}')" style="display: ${isComplete ? 'inline-block' : 'none'}">⬇ Download</button>
          <button class="btn btn-danger btn-xs remove-btn" onclick="app.removeQueueItem('${item.id}')" ${isProcessing ? 'disabled' : ''}>🗑</button>
        </div>
      `;

      fragment.appendChild(el);
    });

    queueList.appendChild(fragment);
  },

  /* ─── Provider: Toggle online/offline ─── */
  async toggleProvider() {
    this.providerOnline = !this.providerOnline;
    const toggle = document.getElementById('providerToggle');
    const label = document.getElementById('providerToggleLabel');
    toggle.classList.toggle('active', this.providerOnline);
    label.textContent = this.providerOnline ? 'Online' : 'Offline';
    UI.setText('provStatus', this.providerOnline ? 'Online' : 'Offline');

    if (this.providerOnline) {
      signaling.send({ type: 'provider-online', services: this.getProviderServices() });
      this.provStartTime = Date.now();
      this.uptimeInterval = setInterval(() => {
        const mins = Math.floor((Date.now() - this.provStartTime) / 60000);
        UI.setText('provUptime', mins + 'm');
      }, 10000);
      
      // Start system stats polling
      this.pollSystemStats();

      UI.toast('You are now online — ready for jobs', 'success');
    } else {
      signaling.send({ type: 'provider-offline' });
      clearInterval(this.uptimeInterval);
      
      if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
      }
      UI.hideEl('diagnosticsCard');

      UI.toast('You are now offline', 'info');
    }
  },

  pollSystemStats() {
    if (!window.api) return;

    UI.showEl('diagnosticsCard');

    const updateStats = async () => {
      if (!this.providerOnline) return;
      try {
        const stats = await window.api.getSystemStats();
        this.lastSystemStats = stats;

        UI.setText('diagCpuVal', `${Math.round(stats.cpu)}%`);
        document.getElementById('diagCpuBar').style.width = `${stats.cpu}%`;
        
        UI.setText('diagMemVal', `${Math.round(stats.memory)}%`);
        document.getElementById('diagMemBar').style.width = `${stats.memory}%`;
        
        UI.setText('diagTempVal', `${Math.round(stats.temp)}°C`);
        document.getElementById('diagTempBar').style.width = `${Math.min(100, stats.temp)}%`;

        const tempBar = document.getElementById('diagTempBar');
        if (stats.temp > 80) {
          tempBar.style.background = 'var(--red)';
        } else if (stats.temp > 65) {
          tempBar.style.background = 'var(--amber)';
        } else {
          tempBar.style.background = 'var(--emerald)';
        }

        // Live CPU compliance status
        const cpuLimit = parseFloat(document.getElementById('srvCpuLimit').value);
        const cpuBadge = document.getElementById('policyCpuBadge');
        if (cpuBadge) {
          if (stats.cpu > cpuLimit) {
            cpuBadge.textContent = '✗ CPU Policy Fail';
            cpuBadge.classList.add('fail');
          } else {
            cpuBadge.textContent = '✓ CPU Policy Pass';
            cpuBadge.classList.remove('fail');
          }
        }
      } catch (err) {
        console.error('Error polling system stats:', err);
      }
    };

    updateStats();
    this.statsInterval = setInterval(updateStats, 2500);
  },

  /* ─── Provider: Accept job ─── */
  acceptJob() {
    if (!this.pendingJobId) return;
    this.currentJobId = this.pendingJobId;
    signaling.send({ type: 'accept-job', jobId: this.pendingJobId });
    this.pendingJobId = null;
  },

  /* ─── Provider: Decline job ─── */
  declineJob() {
    UI.hide('jobNotification');
    this.pendingJobId = null;
    UI.showEl('providerIdle');
  },

  /* ─── Provider: Setup peer for receiving + transcoding ─── */
  _setupProviderPeer() {
    this.peer.onConnected = () => {
      UI.setStage('provStageReceive', 'active', 'receiving...');
      UI.toast('P2P connected — receiving file...', 'success');
    };

    this.peer.onProgress = (stage, pct) => {
      if (stage === 'receiving') {
        UI.setProgress('provReceiveProgress', pct);
        UI.setStage('provStageReceive', 'active', Math.round(pct) + '%');
      } else if (stage === 'sending') {
        UI.setProgress('provStageSendProgress', pct);
        UI.setStage('provStageSend', 'active', Math.round(pct) + '%');
      }
    };

    this.peer.onFileReceived = async (fileData, meta, isNative) => {
      UI.setStage('provStageReceive', 'done', '✓ received');
      UI.setStage('provStageTranscode', 'active', 'starting engine...');
      this._appendLog('File received: ' + UI.formatBytes(meta.fileSize));

      try {
        let resultData;

        if (isNative && window.api) {
          this._appendLog('Starting native FFmpeg transcode...');
          this._cleanupProviderListeners();

          this.ffmpegLogUnsubscribe = window.api.onTranscodeLog((data) => {
            if (data.jobId === this.currentJobId) this._appendLog(data.msg);
          });
          
          this.ffmpegProgressUnsubscribe = window.api.onTranscodeProgress((data) => {
            if (data.jobId === this.currentJobId) {
              UI.setProgress('provStageTranscodeProgress', data.pct);
              UI.setStage('provStageTranscode', 'active', data.pct + '%');
              this.peer.sendProgress(data.pct);
              signaling.send({ type: 'job-progress', jobId: this.currentJobId, stage: 'transcoding', progress: data.pct });
            }
          });

          // fileData is the temp file path
          const useGpu = document.getElementById('srvGpu')?.checked || false;
          resultData = await window.api.transcode(this.currentJobId, fileData, meta.format, meta.quality, meta.mediaType, useGpu);
        } else {
          throw new Error('Native IPC bridge not available. Please run in Electron.');
        }

        UI.setStage('provStageTranscode', 'done', '✓ done');
        UI.setStage('provStageSend', 'active', 'sending...');
        this._appendLog('Transcode complete! Sending result back...');

        // Send result back to client
        const inputBaseName = (meta.fileName || 'output').replace(/\.[^.]+$/, '');
        await this.peer.sendFile(resultData, {
          format: meta.format,
          fileName: `${inputBaseName}_transcoded.${meta.format}`
        });

        UI.setStage('provStageSend', 'done', '✓ sent');
        this._appendLog('✅ Job complete!');
        UI.toast('Job completed successfully!', 'success');

        this.provJobsDone++;
        this.provDataProcessed += meta.fileSize;
        UI.setText('provJobsDone', this.provJobsDone);
        UI.setText('provDataProcessed', UI.formatBytes(this.provDataProcessed));

        signaling.send({ type: 'job-complete', jobId: this.currentJobId, logs: this.jobLogs.slice() });

        // Cleanup native temp files
        if (isNative && window.api) {
          window.api.deleteFile(fileData); // Delete input
          window.api.deleteFile(resultData); // Delete output
        }

        this._cleanupProviderListeners();

        // Reset after delay
        setTimeout(() => this._providerReset(), 3000);

      } catch (e) {
        this._appendLog('❌ ERROR: ' + e.message);
        UI.toast('Transcoding failed: ' + e.message, 'error');
        signaling.send({ type: 'job-failed', jobId: this.currentJobId, error: e.message, stack: e.stack || null, logs: this.jobLogs.slice() });
        this._cleanupProviderListeners();
        
        if (isNative && window.api && typeof fileData === 'string') {
           window.api.deleteFile(fileData);
        }
        
        this._providerReset();
      }
    };
  },

  _providerReset() {
    this._cleanupProviderListeners();
    if (this.peer) { this.peer.close(); this.peer = null; }
    this.currentJobId = null;
    this.jobLogs = [];
    UI.hide('processingView');
    UI.hide('jobNotification');
    UI.showEl('providerIdle');
    
    // Reset policy badges on reset
    const sizeBadge = document.getElementById('policySizeBadge');
    if (sizeBadge) {
      sizeBadge.textContent = '✓ Size Policy Pass';
      sizeBadge.classList.remove('fail');
    }
  },

  _cleanupProviderListeners() {
    if (this.ffmpegLogUnsubscribe) {
      this.ffmpegLogUnsubscribe();
      this.ffmpegLogUnsubscribe = null;
    }
    if (this.ffmpegProgressUnsubscribe) {
      this.ffmpegProgressUnsubscribe();
      this.ffmpegProgressUnsubscribe = null;
    }
  },

  _formatJobOutput(settings = {}) {
    const format = (settings.format || '—').toUpperCase();
    if (settings.mediaType === 'image') {
      const quality = settings.quality || '—';
      return `${format} @ ${quality}%`;
    }
    return `${format} @ ${settings.quality || '—'}p`;
  },

  _appendLog(msg) {
    const log = document.getElementById('ffmpegLog');
    log.textContent += '\n' + msg;
    log.scrollTop = log.scrollHeight;
    this.jobLogs.push({ time: Date.now(), msg });
  },

  /* ─── History & Logs ─── */
  async refreshHistory() {
    try {
      const baseUrl = window.api ? 'http://localhost:3000' : '';
      const res = await fetch(`${baseUrl}/api/history`);
      this.historyData = await res.json();
      this.renderHistory(this.historyData);
    } catch (e) {
      UI.toast('Failed to load history', 'error');
    }
  },

  filterHistory() {
    const filter = document.getElementById('historyFilter').value;
    if (filter === 'all') {
      this.renderHistory(this.historyData);
    } else {
      this.renderHistory(this.historyData.filter(j => j.status === filter));
    }
  },

  async clearHistory() {
    if (!confirm('Clear all job history?')) return;
    const baseUrl = window.api ? 'http://localhost:3000' : '';
    await fetch(`${baseUrl}/api/history`, { method: 'DELETE' });
    this.historyData = [];
    this.renderHistory([]);
    UI.toast('History cleared', 'success');
  },

  renderHistory(data) {
    const body = document.getElementById('historyBody');
    const total = this.historyData.length;
    const success = this.historyData.filter(j => j.status === 'complete').length;
    const failed = this.historyData.filter(j => j.status === 'failed').length;

    UI.setText('histTotal', total);
    UI.setText('histSuccess', success);
    UI.setText('histFailed', failed);
    UI.setText('histErrorRate', total ? Math.round((failed / total) * 100) + '%' : '0%');

    if (!data.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="7" style="text-align:center; padding:48px; color:var(--text-muted);">No jobs match this filter</td></tr>';
      return;
    }

    body.innerHTML = ''; // Clear and use secure fragment
    const fragment = document.createDocumentFragment();

    data.forEach((job, i) => {
      const s = job.settings || {};
      const dur = job.duration ? (job.duration / 1000).toFixed(1) + 's' : '—';
      const time = job.createdAt ? new Date(job.createdAt).toLocaleString() : '—';
      const isErr = job.status === 'failed';
      
      const tr = document.createElement('tr');
      
      // Escape all user-provided strings implicitly by using textContent or safe templates
      tr.innerHTML = `
        <td class="job-id-cell"></td>
        <td class="file-cell"></td>
        <td></td>
        <td><span class="status-badge ${job.status}"></span></td>
        <td style="font-family:var(--mono);">${dur}</td>
        <td style="font-size:0.8rem; color:var(--text-muted);">${time}</td>
        <td><button class="detail-btn ${isErr ? 'error-btn' : ''}">${isErr ? '⚠ Error' : '👁 View'}</button></td>
      `;

      tr.querySelector('.job-id-cell').textContent = job.jobId;
      tr.querySelector('.file-cell').textContent = s.fileName || '—';
      tr.querySelector('.file-cell').title = s.fileName || '';
      tr.querySelectorAll('td')[2].textContent = this._formatJobOutput(s);
      tr.querySelector('.status-badge').textContent = isErr ? 'Failed' : 'Complete';
      tr.querySelector('.detail-btn').onclick = () => this.viewDetail(i, document.getElementById('historyFilter').value);

      fragment.appendChild(tr);
    });
    
    body.appendChild(fragment);
  },

  viewDetail(index, filter) {
    let data = filter === 'all' ? this.historyData : this.historyData.filter(j => j.status === filter);
    const job = data[index];
    if (!job) return;

    const s = job.settings || {};
    UI.setText('detailJobId', job.jobId);
    UI.setText('detailFile', s.fileName || '—');
    UI.setText('detailFormat', (s.format || '—').toUpperCase());
    UI.setText('detailQuality', s.mediaType === 'image' ? (s.quality || '—') + '%' : (s.quality || '—') + 'p');
    UI.setText('detailDuration', job.duration ? (job.duration / 1000).toFixed(1) + 's' : '—');
    UI.setText('detailTime', job.createdAt ? new Date(job.createdAt).toLocaleString() : '—');

    const statusEl = document.getElementById('detailStatus');
    statusEl.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = `status-badge ${job.status}`;
    badge.textContent = job.status === 'failed' ? 'Failed' : 'Complete';
    statusEl.appendChild(badge);

    // Error section
    const errSection = document.getElementById('detailErrorSection');
    if (job.error) {
      errSection.style.display = 'block';
      UI.setText('detailErrorMsg', job.error);
      if (job.stack) {
        document.getElementById('detailStackSection').style.display = 'block';
        UI.setText('detailStack', job.stack);
      } else {
        document.getElementById('detailStackSection').style.display = 'none';
      }
    } else {
      errSection.style.display = 'none';
    }

    // Logs
    const logsEl = document.getElementById('detailLogs');
    if (job.logs && job.logs.length) {
      logsEl.textContent = job.logs.map(l => {
        const t = l.time ? new Date(l.time).toLocaleTimeString() : '';
        return `[${t}] ${l.msg}`;
      }).join('\n');
    } else {
      logsEl.textContent = 'No logs recorded for this job';
    }

    document.getElementById('errorDetailPanel').classList.add('active');
    document.getElementById('errorDetailPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  closeDetail() {
    document.getElementById('errorDetailPanel').classList.remove('active');
  },

  /* ─── Provider Services Configuration ─── */
  getProviderServices() {
    const services = [];
    if (document.getElementById('srvVideo')?.checked) services.push('video');
    if (document.getElementById('srvImage')?.checked) services.push('image');
    if (document.getElementById('srvGpu')?.checked) services.push('gpu');
    return services;
  },

  updateProviderServices() {
    const services = this.getProviderServices();
    if (services.length === 0) {
      UI.toast('Please enable at least one compute module to host jobs.', 'error');
      document.getElementById('srvVideo').checked = true;
      document.getElementById('srvImage').checked = true;
      return;
    }
    
    if (this.role === 'provider' && this.providerOnline) {
      signaling.send({ type: 'provider-update-services', services });
      UI.toast('Compute modules updated successfully', 'success');
    }
  },

  /* ─── Custom Titlebar Window Control ─── */
  minimizeWindow() {
    if (window.api) window.api.minimizeWindow();
  },
  maximizeWindow() {
    if (window.api) window.api.maximizeWindow();
  },
  closeWindow() {
    if (window.api) window.api.closeWindow();
  },

  /* ─── OS & Browser Notifications ─── */
  notifyUser(title, message) {
    if (window.api) {
      window.api.sendNotification(title, message);
    } else if (Notification.permission === 'granted') {
      new Notification(title, { body: message });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          new Notification(title, { body: message });
        }
      });
    }
  },

  /* ─── Auto-Updater UI ─── */
  _showUpdateCard(state, version) {
    const card = document.getElementById('updateCard');
    const title = document.getElementById('updateTitle');
    const desc = document.getElementById('updateDesc');
    const actionBtn = document.getElementById('updateActionBtn');
    const dismissBtn = document.getElementById('updateDismissBtn');

    if (state === 'available') {
      title.textContent = `Update v${version} Available`;
      desc.textContent = 'A new version is ready. Download now?';
      actionBtn.textContent = '⬇ Download';
      actionBtn.onclick = () => this.downloadUpdate();
      dismissBtn.style.display = '';
    } else if (state === 'downloading') {
      title.textContent = `Downloading v${version}...`;
      desc.textContent = 'Please wait while the update downloads.';
      actionBtn.textContent = '⏳ Downloading...';
      actionBtn.disabled = true;
      dismissBtn.style.display = 'none';
    } else if (state === 'downloaded') {
      title.textContent = `v${version} Ready to Install`;
      desc.textContent = 'Restart now to apply the update.';
      actionBtn.textContent = '🔄 Restart & Install';
      actionBtn.disabled = false;
      actionBtn.onclick = () => this.installUpdate();
      dismissBtn.style.display = '';
      dismissBtn.textContent = 'Later';
    }

    card.classList.add('active');
  },

  downloadUpdate() {
    if (!window.api) return;
    this._showUpdateCard('downloading', this._pendingUpdateVersion || '');
    window.api.downloadUpdate();
    UI.toast('Downloading update...', 'info');
  },

  installUpdate() {
    if (!window.api) return;
    window.api.installUpdate();
  },

  dismissUpdate() {
    const card = document.getElementById('updateCard');
    card.classList.remove('active');
  }
};

/* ─── Boot ─── */
document.addEventListener('DOMContentLoaded', () => app.init());
