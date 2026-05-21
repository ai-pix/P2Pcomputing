/* ─── Main App — State Management & Orchestration ─── */
const app = {
  role: null,        // 'client' | 'provider'
  selectedFile: null,
  currentJobId: null,
  pendingJobId: null,
  peer: null,
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
      UI.setText('jobIdLabel', msg.jobId);
      UI.show('jobCard');
      UI.hide('settingsPanel');
      UI.setStage('stageFinding', 'active', 'searching...');
    });

    signaling.on('job-matched', (msg) => {
      UI.toast('Provider found! Establishing P2P connection...', 'success');
      this.notifyUser('Provider Found', 'Establishing P2P connection to process your job...');
      UI.setStage('stageFinding', 'done', '✓ matched');
      UI.setText('jobStatusLabel', 'Connecting to provider...');

      // Create WebRTC connection as initiator
      this.peer = new PeerConnection();
      this.peer.onConnected = () => {
        UI.toast('P2P connection established!', 'success');
        UI.setStage('stageUploading', 'active', 'uploading...');
        UI.setText('jobStatusLabel', 'Uploading to provider...');
        this._sendFileToProvider();
      };
      this.peer.onProgress = (stage, pct) => {
        if (stage === 'sending') {
          UI.setProgress('uploadProgress', pct);
          UI.setStage('stageUploading', 'active', Math.round(pct) + '%');
        } else if (stage === 'transcoding') {
          UI.setProgress('transcodeProgress', pct);
          UI.setStage('stageTranscoding', 'active', Math.round(pct) + '%');
        } else if (stage === 'receiving') {
          UI.setProgress('downloadProgress', pct);
          UI.setStage('stageDownloading', 'active', Math.round(pct) + '%');
        }
      };
      this.peer.onFileReceived = async (resultData, meta, isNative) => {
        this.resultBlob = resultData;
        this.resultMeta = meta;
        this.resultIsNative = !!isNative;
        const resultSize = isNative && window.api
          ? await window.api.getFileSize(resultData)
          : resultData.size;
        UI.setStage('stageDownloading', 'done', '✓ done');
        UI.setText('jobStatusLabel', 'Transcoding complete!');
        UI.setText('resultInfo', `Output: ${meta.fileName} (${UI.formatBytes(resultSize)})`);
        UI.show('downloadArea');
        UI.toast('Transcoding complete! 🎉', 'success');
        this.notifyUser('Transcoding Complete', `Finished transcoding output: ${meta.fileName}`);
      };

      this.peer.createOffer(msg.providerId);
    });

    signaling.on('job-progress', (msg) => {
      if (msg.stage === 'transcoding') {
        UI.setStage('stageTranscoding', 'active', msg.progress + '%');
        UI.setProgress('transcodeProgress', msg.progress);
        UI.setText('jobStatusLabel', 'Provider is transcoding...');
      }
    });

    signaling.on('job-failed', (msg) => {
      UI.toast('Job failed: ' + (msg.error || 'Unknown error'), 'error');
      document.getElementById('submitBtn').disabled = false;
      UI.setText('jobStatusLabel', 'Failed — ' + msg.error);
    });

    /* ── Provider events ── */
    signaling.on('job-available', (msg) => {
      if (this.role !== 'provider' || !this.providerOnline) return;
      this.pendingJobId = msg.jobId;
      const s = msg.settings;
      UI.setText('jobNotifDetails',
        `File: ${s.fileName}\nSize: ${UI.formatBytes(s.fileSize)}\nFormat: ${this._formatJobOutput(s)}`
      );
      UI.show('jobNotification');
      UI.hideEl('providerIdle');
      this.notifyUser('Incoming Job Request', `File: ${s.fileName} (${UI.formatBytes(s.fileSize)})`);
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

      // Setup WebRTC as responder — wait for offer
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
      if (this.peer) await this.peer.handleAnswer(msg);
    });

    signaling.on('ice-candidate', async (msg) => {
      if (this.peer) await this.peer.handleIceCandidate(msg);
    });

    /* Drag and drop */
    UI.setupDragDrop('uploadZone', 'fileInput', (file) => this._handleFile(file));
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

  /* ─── Client: File selection ─── */
  _handleFile(file) {
    const MAX_SIZE = 500 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      UI.toast('File too large! Max 500MB for browser transcoding.', 'error');
      return;
    }
    
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    
    if (!isVideo && !isImage) {
      UI.toast('Please select a video or image file.', 'error');
      return;
    }
    
    this.selectedFile = file;
    this.resultBlob = null;
    this.resultMeta = null;
    this.resultIsNative = false;
    this.mediaType = isVideo ? 'video' : 'image';
    
    // Update format options
    const formatSelect = document.getElementById('formatSelect');
    if (isVideo) {
      formatSelect.innerHTML = `
        <option value="mp4">MP4 (H.264)</option>
        <option value="webm">WebM (VP9)</option>
        <option value="avi">AVI</option>
        <option value="mkv">MKV</option>
      `;
    } else {
      formatSelect.innerHTML = `
        <option value="webp">WebP (Modern)</option>
        <option value="jpg">JPG (Standard)</option>
        <option value="png">PNG (Lossless)</option>
      `;
    }

    // Update quality options
    const qualitySelect = document.getElementById('qualitySelect');
    if (isVideo) {
      qualitySelect.parentElement.querySelector('label').textContent = 'Quality Preset';
      qualitySelect.innerHTML = `
        <option value="720">720p</option>
        <option value="1080" selected>1080p</option>
        <option value="1440">1440p</option>
        <option value="2160">4K</option>
      `;
    } else {
      qualitySelect.parentElement.querySelector('label').textContent = 'Compression Level';
      qualitySelect.innerHTML = `
        <option value="100">Best (100%)</option>
        <option value="80" selected>High (80%)</option>
        <option value="50">Medium (50%)</option>
      `;
    }
    
    const icon = document.querySelector('.file-icon');
    if (icon) icon.textContent = isVideo ? '🎞️' : '📸';

    UI.setText('fileName', file.name);
    UI.setText('fileSize', UI.formatBytes(file.size));
    UI.show('settingsPanel');
  },

  /* ─── Client: Submit job ─── */
  submitJob() {
    if (!this.selectedFile) return;
    this._uploadStarted = false;
    const format = document.getElementById('formatSelect').value;
    const quality = document.getElementById('qualitySelect').value;

    signaling.send({
      type: 'post-job',
      settings: {
        fileName: this.selectedFile.name,
        fileSize: this.selectedFile.size,
        mediaType: this.mediaType,
        format,
        quality
      }
    });

    document.getElementById('submitBtn').disabled = true;
    UI.toast('Job posted — looking for a provider...', 'info');
  },

  /* ─── Client: Send file to provider ─── */
  async _sendFileToProvider() {
    if (this._uploadStarted) return;
    this._uploadStarted = true;
    try {
      // Selected client files are outside the app temp sandbox, so upload
      // them from the File object instead of the native temp-file path flow.
      await this.peer.sendFile(this.selectedFile, {
        format: document.getElementById('formatSelect').value,
        quality: document.getElementById('qualitySelect').value,
        mediaType: this.mediaType
      });
      UI.setStage('stageUploading', 'done', '✓ sent');
      UI.setStage('stageTranscoding', 'active', '0%');
      UI.setText('jobStatusLabel', 'Provider is transcoding...');
    } catch (e) {
      signaling.send({
        type: 'job-upload-failed',
        jobId: this.currentJobId,
        error: e.message
      });
      if (this.peer) {
        this.peer.close();
        this.peer = null;
      }
      UI.setText('jobStatusLabel', 'Upload failed');
      document.getElementById('submitBtn').disabled = false;
      UI.toast('Upload failed: ' + e.message, 'error');
    }
  },

  /* ─── Client: Download result ─── */
  async downloadResult() {
    if (!this.resultBlob) return;
    const format = this.resultMeta?.format || document.getElementById('formatSelect').value;
    const baseName = this.selectedFile.name.replace(/\.[^.]+$/, '');
    const defaultName = this.resultMeta?.fileName || `${baseName}_transcoded.${format}`;

    if (this.resultIsNative && window.api) {
      const saveResult = await window.api.saveOutputFile(this.resultBlob, defaultName);
      if (!saveResult?.canceled) UI.toast('Output saved successfully', 'success');
      return;
    }

    const url = URL.createObjectURL(this.resultBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(url);
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
      
      UI.toast('You are now online — ready for jobs', 'success');
    } else {
      signaling.send({ type: 'provider-offline' });
      clearInterval(this.uptimeInterval);
      UI.toast('You are now offline', 'info');
    }
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
        UI.setProgress('provSendProgress', pct);
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
              UI.setProgress('provTranscodeProgress', data.pct);
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
