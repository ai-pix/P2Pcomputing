/* ─── Main App — State Management & Orchestration ─── */

interface QueueItem {
  id: string;
  file: File;
  mediaType: 'video' | 'image';
  format: string;
  quality: string;
  status: string;
  progress: number;
  jobId: string | null;
  providerId: string | null;
  resultBlob: Blob | null;
  resultMeta: any | null;
  resultIsNative: boolean;
  error: string | null;
  frameCount: number;
  width: number;
  height: number;
  estimatedCost: number;
}

const app = {
  role: null as 'client' | 'provider' | null,
  queue: [] as QueueItem[],
  peers: new Map<string, any>(), // remoteProviderId -> PeerConnection
  activeQueueItem: null as QueueItem | null,
  currentJobId: null as string | null,
  pendingJobId: null as string | null,
  peer: null as any | null, // current/fallback PeerConnection
  resultBlob: null as Blob | null,
  resultMeta: null as any | null,
  resultIsNative: false,
  historyData: [] as any[],
  jobLogs: [] as { time: number; msg: string }[],
  ffmpegLogUnsubscribe: null as (() => void) | null,
  ffmpegProgressUnsubscribe: null as (() => void) | null,

  /* Provider state */
  providerOnline: false,
  provJobsDone: 0,
  provDataProcessed: 0,
  provStartTime: null as number | null,
  uptimeInterval: null as any,
  statsInterval: null as any,
  lastSystemStats: null as any,

  identity: null as { nodeId: string; nodeSecret: string } | null,
  pointsBalance: 100.0,
  benchmarkScore: 0,
  _pendingUpdateVersion: null as string | null,

  /* ─── Init ─── */
  init() {
    this.role = 'client';
    this.identity = null;
    this.pointsBalance = 100.0;
    this.benchmarkScore = 0;
    
    if ((window as any).api) {
      document.body.classList.add('is-electron');

      // Listen for auto-updater events
      (window as any).api.onUpdateAvailable((data: any) => {
        this._pendingUpdateVersion = data.version;
        this._showUpdateCard('available', data.version);
      });
      (window as any).api.onUpdateDownloaded((data: any) => {
        this._showUpdateCard('downloaded', data.version);
      });

      // Fetch and display hardware info
      (window as any).api.getHwInfo().then((info: any) => {
        const display = document.getElementById('hwInfoDisplay');
        const label = document.getElementById('detectedHwLabel');
        if (display && label) {
          display.style.display = 'flex';
          const modelStr = info.model ? ` on ${info.model}` : '';
          label.textContent = (info.label || 'None (Software Only)') + modelStr;
          if (!info.encoder) {
            (label as HTMLElement).style.color = 'var(--text-muted)';
          } else {
            (label as HTMLElement).style.color = 'var(--amber)';
            (label as HTMLElement).style.fontWeight = '800';
            // Auto-enable GPU if detected
            const gpuCheck = document.getElementById('srvGpu') as HTMLInputElement | null;
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
    signaling.on('welcome', (msg: any) => {
      UI.updateStats(msg.stats);
      UI.setText('clientPeerId', signaling.peerId || 'Offline');
      this.syncIdentity();
    });
    signaling.on('stats', (msg: any) => UI.updateStats(msg));
    
    signaling.on('registered', (msg: any) => {
      if (msg.account) {
        this.updateBalanceUI(msg.account.points);
      }
    });

    signaling.on('balance-update', (msg: any) => {
      this.updateBalanceUI(msg.points);
    });

    signaling.on('error', (msg: any) => {
      UI.toast(msg.message, 'error');
      if (this.activeQueueItem && msg.message.includes('Insufficient')) {
        this.activeQueueItem.status = 'failed';
        this.activeQueueItem.error = msg.message;
        this.renderQueue();
        this.activeQueueItem = null;
        this.processQueue();
      }
    });

    /* ── Client events ── */
    signaling.on('job-created', (msg: any) => {
      this.currentJobId = msg.jobId;
      if (this.activeQueueItem) {
        this.activeQueueItem.jobId = msg.jobId;
        this.activeQueueItem.status = 'matching';
        this.renderQueue();
      }
    });

    signaling.on('job-matched', (msg: any) => {
      const item = this.queue.find(q => q.jobId === msg.jobId || (this.activeQueueItem && this.activeQueueItem.jobId === msg.jobId));
      if (!item) return;

      item.status = 'connecting';
      item.providerId = msg.providerId;
      this.renderQueue();

      UI.toast(`Provider found for ${item.file.name}! Establishing P2P connection...`, 'success');
      this.notifyUser('Provider Found', `Establishing P2P connection to process ${item.file.name}...`);

      const peer = new PeerConnection(msg.jobId);
      this.peers.set(msg.providerId, peer);
      this.peer = peer;

      peer.onConnected = () => {
        item.status = 'uploading';
        this.renderQueue();
        UI.toast(`P2P connected for ${item.file.name}! Uploading...`, 'success');
        this._sendFileToProvider(item, peer);
      };
      
      peer.onProgress = (stage: string, pct: number) => {
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
      
      peer.onFileReceived = async (resultData: any, meta: any, isNative: boolean) => {
        item.status = 'complete';
        item.progress = 100;
        item.resultBlob = resultData;
        item.resultMeta = meta;
        item.resultIsNative = !!isNative;
        this.renderQueue();

        UI.toast(`Transcoding complete for ${item.file.name}! 🎉`, 'success');
        this.notifyUser('Transcoding Complete', `Finished transcoding output: ${meta.fileName}`);

        peer.close();
        this.peers.delete(msg.providerId);
        if (this.peer === peer) this.peer = null;

        this.activeQueueItem = null;
        this.processQueue();
      };

      peer.createOffer(msg.providerId);
    });

    signaling.on('job-progress', (msg: any) => {
      const item = this.queue.find(q => q.jobId === msg.jobId);
      if (item && msg.stage === 'transcoding') {
        item.status = 'transcoding';
        item.progress = msg.progress;
        this.renderQueue();
      }
    });

    signaling.on('job-failed', (msg: any) => {
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
    signaling.on('job-available', (msg: any) => {
      if (this.role !== 'provider' || !this.providerOnline) return;

      const s = msg.settings;
      const maxFileSizeMB = parseFloat((document.getElementById('srvMaxFileSize') as HTMLInputElement).value);
      const maxFileSizeBytes = maxFileSizeMB * 1024 * 1024;
      const cpuLimit = parseFloat((document.getElementById('srvCpuLimit') as HTMLInputElement).value);

      let cpuPass = true;
      if (this.lastSystemStats && this.lastSystemStats.cpu > cpuLimit) {
        cpuPass = false;
      }

      let sizePass = true;
      if (s.fileSize > maxFileSizeBytes) {
        sizePass = false;
      }

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

      if (!cpuPass || !sizePass) {
        console.log(`Decline job ${msg.jobId}: CPU pass=${cpuPass}, Size pass=${sizePass}`);
        return;
      }

      this.pendingJobId = msg.jobId;

      const autoAccept = (document.getElementById('srvAutoAccept') as HTMLInputElement).checked;
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

    signaling.on('job-accepted', (msg: any) => {
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
    signaling.on('offer', async (msg: any) => {
      if (this.role === 'provider') {
        this.peer = new PeerConnection(this.currentJobId || undefined);
        this._setupProviderPeer();
        await this.peer.handleOffer(msg);
      }
    });

    signaling.on('answer', async (msg: any) => {
      if (this.role === 'client') {
        const peer = this.peers.get(msg.from);
        if (peer) await peer.handleAnswer(msg);
      } else {
        if (this.peer) await this.peer.handleAnswer(msg);
      }
    });

    signaling.on('ice-candidate', async (msg: any) => {
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

  /* ─── Identity & Benchmark Management ─── */
  async syncIdentity() {
    if ((window as any).api) {
      this.identity = await (window as any).api.getNodeIdentity();
    } else {
      let nodeId = localStorage.getItem('transcodenet_node_id');
      let nodeSecret = localStorage.getItem('transcodenet_node_secret');
      if (!nodeId || !nodeSecret) {
        nodeId = 'web-' + Math.random().toString(36).substr(2, 9);
        nodeSecret = Math.random().toString(36).substr(2, 9);
        localStorage.setItem('transcodenet_node_id', nodeId);
        localStorage.setItem('transcodenet_node_secret', nodeSecret);
      }
      this.identity = { nodeId, nodeSecret };
    }
    
    let score = 0;
    const savedScore = localStorage.getItem('transcodenet_benchmark_score');
    if (savedScore) {
      score = parseInt(savedScore) || 0;
      this.benchmarkScore = score;
      UI.setText('benchmarkScoreVal', `Score: ${score}`);
      const btn = document.getElementById('runBenchmarkBtn');
      if (btn) btn.textContent = 'Re-Run';
    } else if ((window as any).api) {
      setTimeout(() => this.runBenchmark(true), 2000);
    }
    
    if (this.identity) {
      signaling.send({
        type: 'register-identity',
        nodeId: this.identity.nodeId,
        nodeSecret: this.identity.nodeSecret,
        role: this.role,
        services: this.getProviderServices(),
        benchmarkScore: score,
        status: this.role === 'provider' ? (this.providerOnline ? 'online' : 'offline') : undefined
      });
    }
  },

  async runBenchmark(isAuto = false) {
    if (!(window as any).api) return;
    
    const useGpu = (document.getElementById('srvGpu') as HTMLInputElement | null)?.checked || false;
    UI.setText('benchmarkScoreVal', 'Running transcode benchmark...');
    const btn = document.getElementById('runBenchmarkBtn') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    
    try {
      const score = await (window as any).api.runBenchmark(useGpu);
      this.benchmarkScore = score;
      localStorage.setItem('transcodenet_benchmark_score', String(score));
      UI.setText('benchmarkScoreVal', `Score: ${score} FPS`);
      UI.toast(`Benchmark completed! Speed: ${score} FPS`, 'success');
      
      if (signaling.peerId && this.identity) {
        signaling.send({
          type: 'register-identity',
          nodeId: this.identity.nodeId,
          nodeSecret: this.identity.nodeSecret,
          role: this.role,
          services: this.getProviderServices(),
          benchmarkScore: score,
          status: this.role === 'provider' ? (this.providerOnline ? 'online' : 'offline') : undefined
        });
      }
    } catch (e) {
      console.error('Benchmark failed:', e);
      UI.setText('benchmarkScoreVal', 'Benchmark failed');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Re-Run';
      }
    }
  },

  updateBalanceUI(points: number) {
    this.pointsBalance = points;
    const rounded = (points || 0).toFixed(1);
    UI.setText('accountBalanceVal', `${rounded} pts`);
    UI.setText('headerBalanceVal', rounded);
  },
  
  addTestCredits() {
    signaling.send({ type: 'add-test-credits' });
    UI.toast('Requesting 1000 test credits...', 'info');
  },

  /* ─── Navigation ─── */
  switchTab(tabId: string, btnEl?: HTMLElement) {
    document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
    document.getElementById(tabId)?.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    const viewTitle = document.getElementById('viewTitle');
    const viewSubtitle = document.getElementById('viewSubtitle');
    if (!viewTitle || !viewSubtitle) return;

    if (tabId === 'viewClient') {
      this.role = 'client';
      viewTitle.textContent = 'Transcode Media';
      viewSubtitle.textContent = 'Decentralized P2P transcoding engine';
      if (this.identity) {
        signaling.send({
          type: 'register-identity',
          nodeId: this.identity.nodeId,
          nodeSecret: this.identity.nodeSecret,
          role: 'client'
        });
      }
    } else if (tabId === 'viewProvider') {
      this.role = 'provider';
      viewTitle.textContent = 'Share Compute';
      viewSubtitle.textContent = 'Host worker nodes and receive encoding jobs';
      if (this.identity) {
        signaling.send({
          type: 'register-identity',
          nodeId: this.identity.nodeId,
          nodeSecret: this.identity.nodeSecret,
          role: 'provider',
          services: this.getProviderServices(),
          benchmarkScore: this.benchmarkScore || 0,
          status: this.providerOnline ? 'online' : 'offline'
        });
      }
      UI.toast('Registered as compute provider', 'success');
    } else if (tabId === 'viewHistory') {
      viewTitle.textContent = 'Job History';
      viewSubtitle.textContent = 'Decentralized job transaction logs and statistics';
      this.refreshHistory();
    }
  },

  /* ─── Client: Batch queue management ─── */
  _handleFile(files: FileList) {
    if (!files || !files.length) return;
    
    let addedCount = 0;
    const MAX_SIZE = 500 * 1024 * 1024;
    const videoExtensions = ['.mp4', '.webm', '.avi', '.mkv', '.mov', '.ogg'];
    const imageExtensions = ['.webp', '.jpg', '.jpeg', '.png', '.gif'];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > MAX_SIZE) {
        UI.toast(`File "${file.name}" too large! Max 500MB.`, 'error');
        continue;
      }
      
      const ext = '.' + file.name.split('.').pop()!.toLowerCase();
      const isVideo = file.type.startsWith('video/') || videoExtensions.includes(ext);
      const isImage = file.type.startsWith('image/') || imageExtensions.includes(ext);
      
      if (!isVideo && !isImage) {
        UI.toast(`File "${file.name}" is not a supported media type.`, 'error');
        continue;
      }

      const itemId = 'qitem-' + Math.random().toString(36).substr(2, 9);
      const format = isVideo ? 'mp4' : 'webp';
      const quality = isVideo ? '1080' : '80';

      const queueItem: QueueItem = {
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
        error: null,
        frameCount: 0,
        width: 0,
        height: 0,
        estimatedCost: 0
      };

      this.queue.push(queueItem);
      addedCount++;

      this.analyzeFileMetadata(queueItem);
    }

    if (addedCount > 0) {
      UI.toast(`Added ${addedCount} file(s) to queue`, 'success');
      UI.showEl('queueCard');
      this.renderQueue();
    }
  },

  async analyzeFileMetadata(item: QueueItem) {
    try {
      if (item.mediaType === 'image') {
        const meta = await new Promise<{ width: number; height: number }>((resolve) => {
          const img = new Image();
          const timer = setTimeout(() => {
            img.src = '';
            resolve({ width: 0, height: 0 });
          }, 1000);
          img.src = URL.createObjectURL(item.file);
          img.onload = () => {
            clearTimeout(timer);
            URL.revokeObjectURL(img.src);
            resolve({ width: img.width || 0, height: img.height || 0 });
          };
          img.onerror = () => {
            clearTimeout(timer);
            resolve({ width: 0, height: 0 });
          };
        });
        item.width = meta.width;
        item.height = meta.height;
      } else {
        const meta = await new Promise<{ duration: number; width: number; height: number }>((resolve) => {
          const video = document.createElement('video');
          video.preload = 'metadata';
          const timer = setTimeout(() => {
            video.src = '';
            resolve({ duration: 0, width: 0, height: 0 });
          }, 1000);
          video.src = URL.createObjectURL(item.file);
          video.onloadedmetadata = () => {
            clearTimeout(timer);
            URL.revokeObjectURL(video.src);
            resolve({ duration: video.duration || 0, width: video.videoWidth || 0, height: video.videoHeight || 0 });
          };
          video.onerror = () => {
            clearTimeout(timer);
            resolve({ duration: 0, width: 0, height: 0 });
          };
        });
        item.width = meta.width;
        item.height = meta.height;
        item.frameCount = Math.round((meta.duration || 0) * 30);
      }
    } catch (e) {
      console.error('Metadata parsing failed for queue item:', e);
    }
    this.recalculateItemCost(item);
    this.renderQueue();
  },

  recalculateItemCost(item: QueueItem) {
    const format = item.format;
    const quality = item.quality;
    
    if (item.mediaType === 'image') {
      if (item.width && item.height) {
        const pixels = item.width * item.height;
        const formatMult = format === 'png' ? 0.25 : 0.1;
        item.estimatedCost = Math.round((pixels / 10000) * formatMult * 100) / 100;
      } else {
        item.estimatedCost = Math.round((item.file.size / (1024 * 1024)) * 5 * 100) / 100;
      }
    } else {
      let frames = item.frameCount;
      if (!frames) {
        frames = Math.round((item.file.size / 102400) * 30);
      }
      
      let resMult = 0.01;
      if (quality === '360' || quality === '480') resMult = 0.005;
      else if (quality === '720') resMult = 0.01;
      else if (quality === '1080') resMult = 0.02;
      else if (quality === '1440' || quality === '2160') resMult = 0.08;
      
      item.estimatedCost = Math.round(frames * resMult * 100) / 100;
    }
  },

  updateQueueItemConfig(id: string, key: 'format' | 'quality', value: string) {
    const item = this.queue.find(q => q.id === id);
    if (item && item.status === 'queued') {
      item[key] = value;
      this.recalculateItemCost(item);
      this.renderQueue();
    }
  },

  removeQueueItem(id: string) {
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
    UI.hideEl('queueCard');
  },

  startQueue() {
    this.processQueue();
  },

  processQueue() {
    if (this.role !== 'client') return;
    
    const isBusy = this.queue.some(q => ['matching', 'connecting', 'uploading', 'transcoding', 'downloading'].includes(q.status));
    if (isBusy) {
      console.log('Queue is busy. Waiting for active job...');
      return;
    }

    const nextItem = this.queue.find(q => q.status === 'queued');
    if (!nextItem) {
      UI.toast('All queued jobs finished!', 'success');
      return;
    }

    if (this.pointsBalance < nextItem.estimatedCost) {
      UI.toast(`Insufficient credits! Job costs ~${nextItem.estimatedCost.toFixed(1)} points, but you only have ${this.pointsBalance.toFixed(1)} points. Host compute to earn credits!`, 'error');
      nextItem.status = 'failed';
      nextItem.error = 'Insufficient credits';
      this.renderQueue();
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
        quality: nextItem.quality,
        frameCount: nextItem.frameCount || 0,
        width: nextItem.width || 0,
        height: nextItem.height || 0
      }
    });
  },

  /* ─── Client: Send file to provider ─── */
  async _sendFileToProvider(item: QueueItem, peer: any) {
    try {
      await peer.sendFile(item.file, {
        format: item.format,
        quality: item.quality,
        mediaType: item.mediaType,
        frameCount: item.frameCount || 0,
        width: item.width || 0,
        height: item.height || 0
      });
      item.status = 'transcoding';
      item.progress = 0;
      this.renderQueue();
    } catch (e: any) {
      signaling.send({
        type: 'job-upload-failed',
        jobId: item.jobId || this.currentJobId,
        error: e.message
      });
      peer.close();
      this.peers.delete(item.providerId!);
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
  async downloadQueueItem(itemId: string) {
    const item = this.queue.find(q => q.id === itemId);
    if (!item || !item.resultBlob) return;

    const format = item.resultMeta?.format || item.format;
    const baseName = item.file.name.replace(/\.[^.]+$/, '');
    const defaultName = item.resultMeta?.fileName || `${baseName}_transcoded.${format}`;

    if (item.resultIsNative && (window as any).api) {
      const saveResult = await (window as any).api.saveOutputFile(item.resultBlob, defaultName);
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
            <div style="display:flex; gap:10px; align-items:center;">
              <span class="queue-item-size">${UI.formatBytes(item.file.size)}</span>
              <span style="font-size:0.75rem; color:var(--amber); font-weight:700;">Est: ~${item.estimatedCost || 0} pts</span>
            </div>
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
    if (toggle) toggle.classList.toggle('active', this.providerOnline);
    if (label) label.textContent = this.providerOnline ? 'Online' : 'Offline';
    UI.setText('provStatus', this.providerOnline ? 'Online' : 'Offline');

    if (this.providerOnline) {
      signaling.send({ type: 'provider-online', services: this.getProviderServices() });
      this.provStartTime = Date.now();
      this.uptimeInterval = setInterval(() => {
        const mins = Math.floor((Date.now() - (this.provStartTime || Date.now())) / 60000);
        UI.setText('provUptime', mins + 'm');
      }, 10000);
      
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
    if (!(window as any).api) return;

    UI.showEl('diagnosticsCard');

    const updateStats = async () => {
      if (!this.providerOnline) return;
      try {
        const stats = await (window as any).api.getSystemStats();
        this.lastSystemStats = stats;

        UI.setText('diagCpuVal', `${Math.round(stats.cpuLoad)}%`);
        const cpuBar = document.getElementById('diagCpuBar');
        if (cpuBar) cpuBar.style.width = `${stats.cpuLoad}%`;
        
        UI.setText('diagMemVal', `${Math.round(stats.memUsage)}%`);
        const memBar = document.getElementById('diagMemBar');
        if (memBar) memBar.style.width = `${stats.memUsage}%`;
        
        UI.setText('diagTempVal', `${Math.round(stats.temp)}°C`);
        const tempBar = document.getElementById('diagTempBar');
        if (tempBar) {
          tempBar.style.width = `${Math.min(100, stats.temp)}%`;
          if (stats.temp > 80) {
            tempBar.style.background = 'var(--red)';
          } else if (stats.temp > 65) {
            tempBar.style.background = 'var(--amber)';
          } else {
            tempBar.style.background = 'var(--emerald)';
          }
        }

        const cpuLimit = parseFloat((document.getElementById('srvCpuLimit') as HTMLInputElement).value);
        const cpuBadge = document.getElementById('policyCpuBadge');
        if (cpuBadge) {
          if (stats.cpuLoad > cpuLimit) {
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

    this.peer.onProgress = (stage: string, pct: number) => {
      if (stage === 'receiving') {
        UI.setProgress('provReceiveProgress', pct);
        UI.setStage('provStageReceive', 'active', Math.round(pct) + '%');
      } else if (stage === 'sending') {
        UI.setProgress('provStageSendProgress', pct);
        UI.setStage('provStageSend', 'active', Math.round(pct) + '%');
      }
    };

    this.peer.onFileReceived = async (fileData: any, meta: any, isNative: boolean) => {
      UI.setStage('provStageReceive', 'done', '✓ received');
      UI.setStage('provStageTranscode', 'active', 'starting engine...');
      this._appendLog('File received: ' + UI.formatBytes(meta.fileSize));

      try {
        let resultData: any;

        if (isNative && (window as any).api) {
          this._appendLog('Starting native FFmpeg transcode...');
          this._cleanupProviderListeners();

          this.ffmpegLogUnsubscribe = (window as any).api.onTranscodeLog((data: any) => {
            if (data.jobId === this.currentJobId) this._appendLog(data.msg);
          });
          
          this.ffmpegProgressUnsubscribe = (window as any).api.onTranscodeProgress((data: any) => {
            if (data.jobId === this.currentJobId) {
              UI.setProgress('provStageTranscodeProgress', data.pct);
              UI.setStage('provStageTranscode', 'active', data.pct + '%');
              this.peer.sendProgress(data.pct);
              signaling.send({ type: 'job-progress', jobId: this.currentJobId, stage: 'transcoding', progress: data.pct });
            }
          });

          const useGpu = (document.getElementById('srvGpu') as HTMLInputElement | null)?.checked || false;
          resultData = await (window as any).api.transcode(this.currentJobId, fileData, meta.format, meta.quality, meta.mediaType, useGpu);
        } else {
          throw new Error('Native IPC bridge not available. Please run in Electron.');
        }

        UI.setStage('provStageTranscode', 'done', '✓ done');
        UI.setStage('provStageSend', 'active', 'sending...');
        this._appendLog('Transcode complete! Sending result back...');

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

        signaling.send({ 
          type: 'job-complete', 
          jobId: this.currentJobId, 
          logs: this.jobLogs.slice(),
          actualFrames: meta.frameCount || 0,
          actualWidth: meta.width || 0,
          actualHeight: meta.height || 0
        });

        if (isNative && (window as any).api) {
          (window as any).api.deleteFile(fileData);
          (window as any).api.deleteFile(resultData);
        }

        this._cleanupProviderListeners();
        setTimeout(() => this._providerReset(), 3000);

      } catch (e: any) {
        this._appendLog('❌ ERROR: ' + e.message);
        UI.toast('Transcoding failed: ' + e.message, 'error');
        signaling.send({ type: 'job-failed', jobId: this.currentJobId, error: e.message, stack: e.stack || null, logs: this.jobLogs.slice() });
        this._cleanupProviderListeners();
        
        if (isNative && (window as any).api && typeof fileData === 'string') {
          (window as any).api.deleteFile(fileData);
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

  _formatJobOutput(settings: any = {}) {
    const format = (settings.format || '—').toUpperCase();
    if (settings.mediaType === 'image') {
      const quality = settings.quality || '—';
      return `${format} @ ${quality}%`;
    }
    return `${format} @ ${settings.quality || '—'}p`;
  },

  _appendLog(msg: string) {
    const log = document.getElementById('ffmpegLog');
    if (log) {
      log.textContent += '\n' + msg;
      log.scrollTop = log.scrollHeight;
    }
    this.jobLogs.push({ time: Date.now(), msg });
  },

  /* ─── History & Logs ─── */
  async refreshHistory() {
    try {
      const baseUrl = (window as any).api ? 'http://localhost:3000' : '';
      const res = await fetch(`${baseUrl}/api/history`);
      this.historyData = await res.json();
      this.renderHistory(this.historyData);
    } catch (e) {
      UI.toast('Failed to load history', 'error');
    }
  },

  filterHistory() {
    const filter = (document.getElementById('historyFilter') as HTMLSelectElement).value;
    if (filter === 'all') {
      this.renderHistory(this.historyData);
    } else {
      this.renderHistory(this.historyData.filter(j => j.status === filter));
    }
  },

  async clearHistory() {
    if (!confirm('Clear all job history?')) return;
    const baseUrl = (window as any).api ? 'http://localhost:3000' : '';
    await fetch(`${baseUrl}/api/history`, { method: 'DELETE' });
    this.historyData = [];
    this.renderHistory([]);
    UI.toast('History cleared', 'success');
  },

  renderHistory(data: any[]) {
    const body = document.getElementById('historyBody');
    if (!body) return;

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

    body.innerHTML = '';
    const fragment = document.createDocumentFragment();

    data.forEach((job, i) => {
      const s = job.settings || {};
      const dur = job.duration ? (job.duration / 1000).toFixed(1) + 's' : '—';
      const time = job.createdAt ? new Date(job.createdAt).toLocaleString() : '—';
      const isErr = job.status === 'failed';
      
      const tr = document.createElement('tr');
      
      tr.innerHTML = `
        <td class="job-id-cell"></td>
        <td class="file-cell"></td>
        <td></td>
        <td><span class="status-badge ${job.status}"></span></td>
        <td style="font-family:var(--mono);">${dur}</td>
        <td style="font-size:0.8rem; color:var(--text-muted);">${time}</td>
        <td><button class="detail-btn ${isErr ? 'error-btn' : ''}">${isErr ? '⚠ Error' : '👁 View'}</button></td>
      `;

      tr.querySelector('.job-id-cell')!.textContent = job.jobId;
      tr.querySelector('.file-cell')!.textContent = s.fileName || '—';
      (tr.querySelector('.file-cell') as HTMLElement).title = s.fileName || '';
      tr.querySelectorAll('td')[2].textContent = this._formatJobOutput(s);
      tr.querySelector('.status-badge')!.textContent = isErr ? 'Failed' : 'Complete';
      (tr.querySelector('.detail-btn') as HTMLButtonElement).onclick = () => this.viewDetail(i, (document.getElementById('historyFilter') as HTMLSelectElement).value);

      fragment.appendChild(tr);
    });
    
    body.appendChild(fragment);
  },

  viewDetail(index: number, filter: string) {
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
    if (statusEl) {
      statusEl.innerHTML = '';
      const badge = document.createElement('span');
      badge.className = `status-badge ${job.status}`;
      badge.textContent = job.status === 'failed' ? 'Failed' : 'Complete';
      statusEl.appendChild(badge);
    }

    const errSection = document.getElementById('detailErrorSection');
    if (errSection) {
      if (job.error) {
        errSection.style.display = 'block';
        UI.setText('detailErrorMsg', job.error);
        const stackSection = document.getElementById('detailStackSection');
        if (stackSection) {
          if (job.stack) {
            stackSection.style.display = 'block';
            UI.setText('detailStack', job.stack);
          } else {
            stackSection.style.display = 'none';
          }
        }
      } else {
        errSection.style.display = 'none';
      }
    }

    const logsEl = document.getElementById('detailLogs');
    if (logsEl) {
      if (job.logs && job.logs.length) {
        logsEl.textContent = job.logs.map((l: any) => {
          const t = l.time ? new Date(l.time).toLocaleTimeString() : '';
          return `[${t}] ${l.msg}`;
        }).join('\n');
      } else {
        logsEl.textContent = 'No logs recorded for this job';
      }
    }

    document.getElementById('errorDetailPanel')?.classList.add('active');
    document.getElementById('errorDetailPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  closeDetail() {
    document.getElementById('errorDetailPanel')?.classList.remove('active');
  },

  /* ─── Provider Services Configuration ─── */
  getProviderServices() {
    const services: string[] = [];
    if ((document.getElementById('srvVideo') as HTMLInputElement | null)?.checked) services.push('video');
    if ((document.getElementById('srvImage') as HTMLInputElement | null)?.checked) services.push('image');
    if ((document.getElementById('srvGpu') as HTMLInputElement | null)?.checked) services.push('gpu');
    return services;
  },

  updateProviderServices() {
    const services = this.getProviderServices();
    if (services.length === 0) {
      UI.toast('Please enable at least one compute module to host jobs.', 'error');
      const vCheck = document.getElementById('srvVideo') as HTMLInputElement | null;
      const iCheck = document.getElementById('srvImage') as HTMLInputElement | null;
      if (vCheck) vCheck.checked = true;
      if (iCheck) iCheck.checked = true;
      return;
    }
    
    if (this.role === 'provider' && this.providerOnline) {
      if (this.identity) {
        signaling.send({
          type: 'register-identity',
          nodeId: this.identity.nodeId,
          nodeSecret: this.identity.nodeSecret,
          role: this.role,
          services,
          benchmarkScore: this.benchmarkScore || 0,
          status: this.providerOnline ? 'online' : 'offline'
        });
      }
      UI.toast('Compute modules updated successfully', 'success');
      setTimeout(() => this.runBenchmark(true), 500);
    }
  },

  /* ─── Custom Titlebar Window Control ─── */
  minimizeWindow() {
    if ((window as any).api) (window as any).api.minimizeWindow();
  },
  maximizeWindow() {
    if ((window as any).api) (window as any).api.maximizeWindow();
  },
  closeWindow() {
    if ((window as any).api) (window as any).api.closeWindow();
  },

  /* ─── OS & Browser Notifications ─── */
  notifyUser(title: string, message: string) {
    if ((window as any).api) {
      (window as any).api.sendNotification(title, message);
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
  _showUpdateCard(state: 'available' | 'downloading' | 'downloaded', version: string) {
    const card = document.getElementById('updateCard');
    const title = document.getElementById('updateTitle');
    const desc = document.getElementById('updateDesc');
    const actionBtn = document.getElementById('updateActionBtn') as HTMLButtonElement | null;
    const dismissBtn = document.getElementById('updateDismissBtn') as HTMLButtonElement | null;

    if (!card || !title || !desc || !actionBtn || !dismissBtn) return;

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
    if (!(window as any).api) return;
    this._showUpdateCard('downloading', this._pendingUpdateVersion || '');
    (window as any).api.downloadUpdate();
    UI.toast('Downloading update...', 'info');
  },

  installUpdate() {
    if (!(window as any).api) return;
    (window as any).api.installUpdate();
  },

  dismissUpdate() {
    const card = document.getElementById('updateCard');
    if (card) card.classList.remove('active');
  }
};

/* ─── Boot ─── */
document.addEventListener('DOMContentLoaded', () => app.init());
