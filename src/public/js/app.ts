/* ─── Main App — State Management & Orchestration ─── */

interface QueueItem {
  id: string;
  file: File;
  mediaType: 'video' | 'image';
  format: string;
  quality: string;
  audioBitrate?: string;
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
  privacyLevel?: 'public' | 'secure';
}

const app = {
  role: null as 'client' | 'provider' | 'orchestrator' | null,
  queue: [] as QueueItem[],
  activeProvidersCount: 0,
  peers: new Map<string, PeerConnection>(), // Client's worker peers
  activeQueueItem: null as QueueItem | null,
  analytics: {
    fpsHistory: [] as number[],
    earningsHistory: [] as number[],
    bandwidthHistory: Array(10).fill(0) as number[]
  },
  charts: {
    fps: null as any,
    earnings: null as any,
    bandwidth: null as any
  },
  bandwidthInterval: null as any,
  currentJobId: null as string | null,
  pendingJobId: null as string | null,
  peer: null as any | null, // current primary PeerConnection
  resultBlob: null as Blob | null,
  resultMeta: null as any | null,
  resultIsNative: false,
  historyData: [] as any[],
  jobLogs: [] as { time: number; msg: string }[],
  ffmpegLogUnsubscribe: null as (() => void) | null,
  ffmpegProgressUnsubscribe: null as (() => void) | null,

  /* Orchestrator state */
  isOrchestratorEnabled: false,
  activeOrchJob: null as any | null,
  orchSubJobs: new Map<string, any>(), // subJobId -> status
  orchWorkerPeers: new Map<string, any>(), // workerId -> PeerConnection
  probeTimeoutId: null as any,
  probedWorkers: [] as any[],
  activeProbeJobId: null as string | null,
  probeJobSettings: null as any,
  
  activeCapableWorkers: [] as any[],
  
  /* Network & Tiering state */
  networkScore: 0, // Mbps upload
  nodeTier: 'Basic' as 'Basic' | 'Professional' | 'Elite',
  isBenchmarking: false,

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
    
    try {
      const savedFps = localStorage.getItem('transcodenet_fps_history');
      if (savedFps) this.analytics.fpsHistory = JSON.parse(savedFps);
      const savedEarnings = localStorage.getItem('transcodenet_earnings_history');
      if (savedEarnings) this.analytics.earningsHistory = JSON.parse(savedEarnings);
    } catch (e) {
      console.error('Failed to load analytics from localStorage', e);
    }
    
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
    // Load and set backup signaling URLs
    const savedUrls = localStorage.getItem('transcodenet_signaling_urls');
    if (savedUrls) {
      const urlsArray = savedUrls.split(',').map(u => u.trim()).filter(u => u.length > 0);
      if (urlsArray.length > 0) {
        signaling.wsUrls = urlsArray;
      }
      setTimeout(() => {
        const input = document.getElementById('backupServersInput') as HTMLInputElement | null;
        if (input) {
          input.value = savedUrls;
        }
      }, 500);
    }
    signaling.connect();
    signaling.on('welcome', (msg: any) => {
      this.activeProvidersCount = msg.stats ? (msg.stats.activeProviders || 0) : 0;
      UI.updateStats(msg.stats);
      UI.setText('clientPeerId', signaling.peerId || 'Offline');
      this.syncIdentity();
    });
    signaling.on('stats', (msg: any) => {
      this.activeProvidersCount = msg.activeProviders || 0;
      UI.updateStats(msg);
    });
    
    signaling.on('registered', (msg: any) => {
      if (msg.account) {
        this.updateBalanceUI(msg.account.points);
        if (msg.account.reputationScore !== undefined) {
          UI.setText('accountReputationVal', msg.account.reputationScore + '%');
        }
      }
    });

    signaling.on('balance-update', (msg: any) => {
      this.updateBalanceUI(msg.points);
      if (msg.reputationScore !== undefined) {
        UI.setText('accountReputationVal', msg.reputationScore + '%');
      }
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

    signaling.on('probe-workers-request', (msg: any) => {
      // Respond to pre-flight check if we are online and ready
      const slider = document.getElementById('srvMaxFileSize') as HTMLInputElement | null;
      const maxFileSizeMB = slider ? parseFloat(slider.value) : 200;
      const maxFileSizeBytes = maxFileSizeMB * 1024 * 1024;
      const cpuLoad = this.lastSystemStats ? (this.lastSystemStats.cpuLoad || 0) : 0;
      const ready = this.providerOnline && !this.currentJobId && !this.pendingJobId;
      const gpuEnabled = (document.getElementById('srvGpu') as HTMLInputElement | null)?.checked || false;

      signaling.send({
        type: 'probe-workers-response',
        target: msg.orchestratorId,
        jobId: msg.jobId,
        workerInfo: {
          peerId: signaling.peerId,
          nodeId: this.identity?.nodeId || 'unknown',
          cpuLoad,
          benchmarkScore: this.benchmarkScore || 0,
          maxFileSize: maxFileSizeBytes,
          gpuEnabled,
          ready
        }
      });
    });

    signaling.on('probe-workers-response', (msg: any) => {
      if (this.role === 'provider' && this.isOrchestratorEnabled && this.activeProbeJobId === msg.jobId) {
        this.probedWorkers.push(msg.workerInfo);
        console.log(`Orchestrator: Received probe response from ${msg.from}`, msg.workerInfo);
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
      // 1. If we are a Worker matched to an Orchestrator (Sub-job)
      if (msg.isSubJob && this.role === 'provider') {
        this.currentJobId = msg.jobId;
        this.peer = new PeerConnection(msg.jobId);
        this._setupProviderPeer(); 
        this.peer.handleOffer(msg); 
        return;
      }

      // 2. If we are an Orchestrator matched to a Worker
      if (msg.isSubJob && this.isOrchestratorEnabled && this.activeOrchJob) {
        this.handleSubJobMatched(msg);
        return;
      }

      const item = this.queue.find(q => q.jobId === msg.jobId) || (this.activeQueueItem && this.activeQueueItem.jobId === msg.jobId ? this.activeQueueItem : null);
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
        let isValid = false;
        let size = 0;
        if (isNative && (window as any).api) {
          try {
            size = await (window as any).api.getFileSize(resultData);
            isValid = size > 0;
          } catch (e) {
            console.error('Failed to get native file size', e);
          }
        } else {
          size = resultData ? resultData.size : 0;
          isValid = size > 0;
        }

        if (isValid) {
          signaling.send({ type: 'confirm-job', jobId: item.jobId });
          item.status = 'complete';
          item.progress = 100;
          item.resultBlob = resultData;
          item.resultMeta = meta;
          item.resultIsNative = !!isNative;
          UI.toast(`Transcoding complete for ${item.file.name}! 🎉`, 'success');
          this.notifyUser('Transcoding Complete', `Finished transcoding output: ${meta.fileName}`);
        } else {
          signaling.send({ type: 'reject-job', jobId: item.jobId, error: 'File size is zero or corrupted' });
          item.status = 'failed';
          item.progress = 0;
          item.error = 'Verification failed: Received file is empty or corrupted';
          UI.toast(`Verification failed for ${item.file.name}`, 'error');
        }
        
        this.renderQueue();

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

      if (msg.isSubJob) {
        console.log('Worker: Sub-job available:', msg.subJobId);
        // Workers handle sub-jobs like normal jobs, but with a subJobId
      }

      const s = msg.settings;
      const maxFileSizeMB = parseFloat((document.getElementById('srvMaxFileSize') as HTMLInputElement).value);
      const maxFileSizeBytes = maxFileSizeMB * 1024 * 1024;
      const cpuLimit = parseFloat((document.getElementById('srvCpuLimit') as HTMLInputElement).value);

      let cpuPass = true;
      if (this.lastSystemStats && this.lastSystemStats.cpuLoad > cpuLimit) {
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

      if (this.isOrchestratorEnabled && msg.isOrchestrator && !msg.isSubJob) {
        console.log(`Orchestrator: Job available. Initiating pre-flight worker probe...`);
        this.runPreFlightProbe(msg.jobId, s);
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

  updateSignalingUrls(value: string) {
    localStorage.setItem('transcodenet_signaling_urls', value);
    const urlsArray = value.split(',').map(u => u.trim()).filter(u => u.length > 0);
    signaling.setUrls(urlsArray);
    UI.toast('Signaling servers configuration updated!', 'success');
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
      
      this.calculateNodeTier(); // Update tiering logic

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

  async runNetworkBenchmark() {
    if (this.isBenchmarking) return;
    this.isBenchmarking = true;
    
    this._appendLog('📡 Starting Advanced Network Multi-Phase Test...');
    UI.showEl('netProgressContainer');
    UI.setProgress('netProgressBar', 0);
    const netBtn = document.getElementById('runNetBtn') as HTMLButtonElement | null;
    if (netBtn) netBtn.disabled = true;

    if ((window as any).api) {
      try {
        const unsubscribe = (window as any).api.onNetworkProgress((data: any) => {
          if (data.stage === 'download') {
            UI.setProgress('netProgressBar', data.pct);
            UI.setText('networkScoreVal', `DL: ${data.speed} Mbps...`);
          } else if (data.stage === 'upload') {
            UI.setProgress('netProgressBar', data.pct);
            if (data.speed > 0) {
              UI.setText('networkScoreVal', `UL: ${data.speed} Mbps...`);
            } else {
              UI.setText('networkScoreVal', `Testing Upload...`);
            }
          }
        });

        const result = await (window as any).api.runNetworkBenchmark();
        unsubscribe();

        this.networkScore = result.ulSpeed;
        this.calculateNodeTier();

        this._appendLog(`✅ Download: ${result.dlSpeed} Mbps`);
        this._appendLog(`✅ Upload: ${result.ulSpeed} Mbps`);
        UI.setText('networkScoreVal', `DL: ${result.dlSpeed} | UL: ${result.ulSpeed}`);
        UI.toast(`Network Test Complete: ${this.nodeTier} Tier`, 'success');
      } catch (e: any) {
        this._appendLog('❌ Network Test Error: ' + e.message);
        UI.setText('networkScoreVal', 'Test Failed');
      } finally {
        this.isBenchmarking = false;
        if (netBtn) netBtn.disabled = false;
        setTimeout(() => UI.hideEl('netProgressContainer'), 3000);
      }
      return;
    }

    // Fallback for Web/Browser mode
    try {
      // PHASE 1: Download Test (10MB)
      UI.setText('networkScoreVal', 'Testing Download...');
      this._appendLog('⬇️ Phase 1: Measuring Download Throughput...');
      
      const dlStart = performance.now();
      const dlRes = await fetch(`/vendor/ffmpeg/ffmpeg-core.wasm?t=${Date.now()}`);
      if (!dlRes.ok) throw new Error(`Download failed with status ${dlRes.status}`);
      
      const reader = dlRes.body?.getReader();
      let dlBytes = 0;
      const contentLength = dlRes.headers.get('content-length');
      const totalDl = contentLength ? parseInt(contentLength, 10) : 32 * 1024 * 1024;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          dlBytes += value.length;
          const pct = Math.min(Math.round((dlBytes / totalDl) * 100), 100);
          UI.setProgress('netProgressBar', pct / 2); // First 50% for DL
          
          const now = performance.now();
          const elapsed = Math.max((now - dlStart) / 1000, 0.001);
          const mbps = Math.round((dlBytes * 8 / (1024 * 1024 * elapsed)) * 10) / 10;
          UI.setText('networkScoreVal', `DL: ${mbps} Mbps...`);
        }
      }
      const dlDuration = Math.max((performance.now() - dlStart) / 1000, 0.001);
      const dlMbps = Math.round((dlBytes * 8 / (1024 * 1024 * dlDuration)) * 10) / 10;
      this._appendLog(`✅ Download: ${dlMbps} Mbps`);

      // PHASE 2: Upload Test (10MB)
      UI.setText('networkScoreVal', 'Testing Upload...');
      this._appendLog('⬆️ Phase 2: Measuring Upload Throughput...');
      
      const ulData = new Uint8Array(10 * 1024 * 1024);
      window.crypto.getRandomValues(ulData);
      
      const ulStart = performance.now();
      const ulRes = await fetch(`/api/test-upload`, {
        method: 'POST',
        body: ulData
      });
      if (!ulRes.ok) throw new Error(`Upload failed with status ${ulRes.status}`);
      
      const ulDuration = Math.max((performance.now() - ulStart) / 1000, 0.001);
      const ulMbps = Math.round((10 * 8 / ulDuration) * 10) / 10;
      UI.setProgress('netProgressBar', 100);
      
      this.networkScore = ulMbps;
      this.calculateNodeTier();
      
      this._appendLog(`✅ Upload: ${ulMbps} Mbps`);
      UI.setText('networkScoreVal', `DL: ${dlMbps} | UL: ${ulMbps}`);
      UI.toast(`Network Test Complete: ${this.nodeTier} Tier`, 'success');

    } catch (e: any) {
      this._appendLog('❌ Network Test Error: ' + e.message);
      UI.setText('networkScoreVal', 'Test Failed');
    } finally {
      this.isBenchmarking = false;
      if (netBtn) netBtn.disabled = false;
      setTimeout(() => UI.hideEl('netProgressContainer'), 3000);
    }
  },

  calculateNodeTier() {
    const bw = this.networkScore;
    const cpu = this.benchmarkScore;

    // Intelligent Tiering: The bottleneck determines the tier
    let tier: 'Basic' | 'Professional' | 'Elite' = 'Basic';

    if (bw >= 100 && cpu >= 500) {
      tier = 'Elite';
    } else if (bw >= 30 && cpu >= 250) {
      tier = 'Professional';
    } else {
      tier = 'Basic';
    }

    this.nodeTier = tier;
    UI.setText('nodeTierLabel', `Tier: ${tier}`);
    
    const orchToggle = document.getElementById('srvOrch') as HTMLInputElement | null;
    const orchLabel = document.getElementById('orchToggleLabel');
    if (orchToggle && orchLabel) {
      if (tier === 'Basic') {
        orchLabel.style.opacity = '0.5';
        orchLabel.style.pointerEvents = 'none';
        orchToggle.checked = false;
        this.isOrchestratorEnabled = false;
        orchLabel.title = "Requires Professional or Elite Tier (min 30Mbps & 250 FPS)";
      } else {
        orchLabel.style.opacity = '1';
        orchLabel.style.pointerEvents = 'auto';
        orchLabel.title = "";
      }
    }
  },

  updateBalanceUI(points: number) {
    this.pointsBalance = points;
    const rounded = (points || 0).toFixed(1);
    UI.setText('accountBalanceVal', `${rounded} pts`);
    UI.setText('headerBalanceVal', rounded);

    if (this.providerOnline) {
      this.analytics.earningsHistory.push(Number(points));
      if (this.analytics.earningsHistory.length > 10) {
        this.analytics.earningsHistory.shift();
      }
      try {
        localStorage.setItem('transcodenet_earnings_history', JSON.stringify(this.analytics.earningsHistory));
      } catch (e) {}

      if (this.charts.earnings) {
        this.charts.earnings.data.labels = this.analytics.earningsHistory.map((_, idx) => `Update ${idx + 1}`);
        this.charts.earnings.data.datasets[0].data = this.analytics.earningsHistory;
        this.charts.earnings.update();
      }
      this.updateEarningsTotal();
    }
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
    const MAX_SIZE = 5000 * 1024 * 1024;
    const videoExtensions = ['.mp4', '.webm', '.avi', '.mkv', '.mov', '.ogg'];
    const imageExtensions = ['.webp', '.jpg', '.jpeg', '.png', '.gif'];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > MAX_SIZE) {
        UI.toast(`File "${file.name}" too large! Max 5GB.`, 'error');
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
        audioBitrate: isVideo ? '128k' : undefined,
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
        estimatedCost: 0,
        privacyLevel: 'public'
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

  updateQueueItemConfig(id: string, key: 'format' | 'quality' | 'audioBitrate' | 'privacyLevel', value: any) {
    const item = this.queue.find(q => q.id === id);
    if (item && item.status === 'queued') {
      (item as any)[key] = value;
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
    this.queue = this.queue.filter(q => q.status === 'complete'); // Keep completed jobs in queue list so finishedCard displays them
    this.renderQueue();
  },

  clearFinished() {
    this.queue = this.queue.filter(q => q.status !== 'complete');
    this.renderQueue();
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
        height: nextItem.height || 0,
        privacyLevel: nextItem.privacyLevel || 'public'
      }
    });
  },

  /* ─── Client: Send file to provider ─── */
  async _sendFileToProvider(item: QueueItem, peer: any) {
    try {
      await peer.sendFile(item.file, {
        format: item.format,
        quality: item.quality,
        audioBitrate: item.audioBitrate,
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
    const finishedList = document.getElementById('finishedList');
    if (!queueList) return;

    const activeItems = this.queue.filter(q => q.status !== 'complete');
    const finishedItems = this.queue.filter(q => q.status === 'complete');

    // 1. Control Visibility of Queue Section
    if (activeItems.length > 0) {
      UI.showEl('queueCard');
    } else {
      UI.hideEl('queueCard');
    }

    // 2. Control Visibility of Finished Section
    if (finishedItems.length > 0) {
      UI.showEl('finishedCard');
    } else {
      UI.hideEl('finishedCard');
    }

    // 3. Render Stats (based on entire queue)
    const total = this.queue.length;
    const completed = finishedItems.length;
    const failed = this.queue.filter(q => q.status === 'failed').length;
    
    UI.setText('queueTotalVal', total);
    UI.setText('queueCompleteVal', completed);
    UI.setText('queueFailedVal', failed);
    
    if (this.activeQueueItem && this.activeQueueItem.jobId) {
      UI.setText('queueActiveJobId', this.activeQueueItem.jobId);
    } else {
      UI.setText('queueActiveJobId', '—');
    }

    // 4. Render Active Items inside #queueList
    queueList.innerHTML = '';
    if (activeItems.length === 0) {
      queueList.innerHTML = '<div style="text-align:center; padding:16px; color:var(--text-muted); font-size:0.9rem;">No active items in queue.</div>';
    } else {
      const activeFragment = document.createDocumentFragment();
      activeItems.forEach(item => {
        const el = this._createQueueItemElement(item);
        activeFragment.appendChild(el);
      });
      queueList.appendChild(activeFragment);
    }

    // 5. Render Finished Items inside #finishedList
    if (finishedList) {
      finishedList.innerHTML = '';
      if (finishedItems.length > 0) {
        const finishedFragment = document.createDocumentFragment();
        finishedItems.forEach(item => {
          const el = this._createQueueItemElement(item);
          finishedFragment.appendChild(el);
        });
        finishedList.appendChild(finishedFragment);
      }
    }
  },

  _createQueueItemElement(item: QueueItem) {
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
        <option value="original" ${item.quality === 'original' ? 'selected' : ''}>Original Res</option>
        <option value="2160" ${item.quality === '2160' ? 'selected' : ''}>4K (2160p)</option>
        <option value="1440" ${item.quality === '1440' ? 'selected' : ''}>2K (1440p)</option>
        <option value="1080" ${item.quality === '1080' ? 'selected' : ''}>FHD (1080p)</option>
        <option value="720" ${item.quality === '720' ? 'selected' : ''}>HD (720p)</option>
        <option value="480" ${item.quality === '480' ? 'selected' : ''}>SD (480p)</option>
        <option value="360" ${item.quality === '360' ? 'selected' : ''}>Low (360p)</option>
      `;
    } else {
      qualityOptions = `
        <option value="100" ${item.quality === '100' ? 'selected' : ''}>100% (Lossless)</option>
        <option value="80" ${item.quality === '80' ? 'selected' : ''}>80% (High)</option>
        <option value="50" ${item.quality === '50' ? 'selected' : ''}>50% (Medium)</option>
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
        ${isVideo ? `
          <select class="queue-select queue-audio" onchange="app.updateQueueItemConfig('${item.id}', 'audioBitrate', this.value)" ${!isQueued ? 'disabled' : ''}>
            <option value="128k" ${item.audioBitrate === '128k' ? 'selected' : ''}>AAC 128k</option>
            <option value="192k" ${item.audioBitrate === '192k' ? 'selected' : ''}>AAC 192k</option>
            <option value="256k" ${item.audioBitrate === '256k' ? 'selected' : ''}>AAC 256k</option>
            <option value="mute" ${item.audioBitrate === 'mute' ? 'selected' : ''}>Mute Audio</option>
          </select>
        ` : ''}
        <label style="display:flex; align-items:center; gap:6px; font-size:0.75rem; color:var(--text-secondary); cursor:pointer; font-weight:700; user-select:none; margin-left:4px;" title="Route job only to nodes with high reputation & specifications">
          <input type="checkbox" onchange="app.updateQueueItemConfig('${item.id}', 'privacyLevel', this.checked ? 'secure' : 'public')" ${item.privacyLevel === 'secure' ? 'checked' : ''} ${!isQueued ? 'disabled' : ''} style="accent-color:var(--emerald); width:14px; height:14px; cursor:pointer;">
          🛡️ Secure
        </label>
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

    return el;
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
      if (this.isOrchestratorEnabled) {
        const minWorkersRequired = 2;
        const availableWorkers = this.activeProvidersCount - 1; // Since we are counted as an active provider when registering online
        if (availableWorkers < minWorkersRequired) {
          UI.toast(`Orchestrator Mode Disabled: Not enough online worker nodes (Available: ${availableWorkers}, Required: ${minWorkersRequired}).`, 'warning');
          this.isOrchestratorEnabled = false;
          const orchCheck = document.getElementById('srvOrch') as HTMLInputElement | null;
          if (orchCheck) orchCheck.checked = false;

          // Restore srvMaxFileSize slider to 500 MB max
          const slider = document.getElementById('srvMaxFileSize') as HTMLInputElement | null;
          const sliderLabel = document.getElementById('srvMaxFileSizeLabel');
          if (slider && sliderLabel) {
            slider.max = '500';
            if (parseInt(slider.value) > 500) {
              slider.value = '500';
              sliderLabel.textContent = '500 MB';
            }
          }
        }
      }
      signaling.send({ type: 'provider-online', services: this.getProviderServices() });
      this.provStartTime = Date.now();
      this.uptimeInterval = setInterval(() => {
        const mins = Math.floor((Date.now() - (this.provStartTime || Date.now())) / 60000);
        UI.setText('provUptime', mins + 'm');
      }, 10000);
      
      this.pollSystemStats();

      setTimeout(() => {
        this.initAnalyticsCharts();
        this.bandwidthInterval = setInterval(() => this.updateThroughput(), 1000);
      }, 100);

      UI.toast('You are now online — ready for jobs', 'success');
    } else {
      signaling.send({ type: 'provider-offline' });
      clearInterval(this.uptimeInterval);
      
      if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
      }
      UI.hideEl('diagnosticsCard');

      if (this.bandwidthInterval) {
        clearInterval(this.bandwidthInterval);
        this.bandwidthInterval = null;
      }
      UI.hideEl('analyticsCard');
      if (this.charts.fps) { this.charts.fps.destroy(); this.charts.fps = null; }
      if (this.charts.earnings) { this.charts.earnings.destroy(); this.charts.earnings = null; }
      if (this.charts.bandwidth) { this.charts.bandwidth.destroy(); this.charts.bandwidth = null; }

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
      
      const isSmallFile = meta.fileSize && meta.fileSize < 100 * 1024 * 1024;
      const availableWorkers = this.providerOnline ? (this.activeProvidersCount - 1) : this.activeProvidersCount;
      const hasEnoughWorkers = availableWorkers >= 2;

      if (this.isOrchestratorEnabled && meta.mediaType === 'video' && (window as any).api) {
        if (isSmallFile) {
          this._appendLog(`⚠️ Bypassing orchestration: File size (${UI.formatBytes(meta.fileSize)}) is under 100 MB. Processing locally...`);
        } else if (!hasEnoughWorkers) {
          this._appendLog(`⚠️ Bypassing orchestration: Not enough online worker nodes (Available: ${availableWorkers}, Required: 2). Processing locally...`);
        } else {
          this.runOrchestration(fileData, meta);
          return;
        }
      }

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

          const startT = performance.now();
          const useGpu = (document.getElementById('srvGpu') as HTMLInputElement | null)?.checked || false;
          resultData = await (window as any).api.transcode(this.currentJobId, fileData, meta.format, meta.quality, meta.mediaType, useGpu, meta.audioBitrate);
          const endT = performance.now();

          const elapsedSec = (endT - startT) / 1000;
          if (meta.frameCount && meta.frameCount > 0 && elapsedSec > 0) {
            const fps = meta.frameCount / elapsedSec;
            this.analytics.fpsHistory.push(Math.round(fps));
            if (this.analytics.fpsHistory.length > 10) {
              this.analytics.fpsHistory.shift();
            }
            try {
              localStorage.setItem('transcodenet_fps_history', JSON.stringify(this.analytics.fpsHistory));
            } catch (e) {}

            if (this.charts.fps) {
              this.charts.fps.data.labels = this.analytics.fpsHistory.map((_, idx) => `Job ${idx + 1}`);
              this.charts.fps.data.datasets[0].data = this.analytics.fpsHistory;
              this.charts.fps.update();
            }
            this.updateFpsAvg();
          }
        } else {
          throw new Error('Native IPC bridge not available. Please run in Electron.');
        }

        UI.setStage('provStageTranscode', 'done', '✓ done');
        UI.setStage('provStageSend', 'active', 'sending...');
        this._appendLog('Transcode complete! Sending result back...');

        const inputBaseName = (meta.fileName || 'output').replace(/\.[^.]+$/, '');
        await this.peer.sendFile(resultData, {
          format: meta.format,
          fileName: `${inputBaseName}_transcoded.${meta.format}`,
          chunkName: meta.chunkName // Preserve chunk name for orchestrator
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
    
    // Clean up active orchestration worker peers and monitor intervals
    if (this.activeOrchJob && this.activeOrchJob.monitorInterval) {
      clearInterval(this.activeOrchJob.monitorInterval);
    }
    this.orchWorkerPeers.forEach((p: any) => p.close());
    this.orchWorkerPeers.clear();
    this.activeOrchJob = null;
    this.activeCapableWorkers = [];

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

  runPreFlightProbe(jobId: string, settings: any) {
    if (this.probeTimeoutId) clearTimeout(this.probeTimeoutId);
    
    this.activeProbeJobId = jobId;
    this.probeJobSettings = settings;
    this.probedWorkers = [];
    
    UI.toast(`Pre-flight checks: probing worker nodes...`, 'info');
    this._appendLog(`🔍 Orchestrator: Probing worker pool for job ${jobId}...`);
    
    signaling.send({
      type: 'probe-workers',
      jobId,
      settings
    });
    
    this.probeTimeoutId = setTimeout(() => {
      this.evaluateProbedWorkers();
    }, 1000); // 1 second aggregation window
  },

  evaluateProbedWorkers() {
    const jobId = this.activeProbeJobId;
    const settings = this.probeJobSettings;
    
    if (!jobId || !settings) return;
    
    this.activeProbeJobId = null;
    this.probeJobSettings = null;
    
    const fileSize = settings.fileSize || 0;
    
    // Estimate segments
    let estimatedSegments = 1;
    if (settings.frameCount && settings.frameCount > 0) {
      estimatedSegments = Math.max(1, Math.ceil(settings.frameCount / (15 * 30)));
    } else {
      estimatedSegments = Math.max(1, Math.ceil(fileSize / (15 * 1024 * 1024)));
    }
    
    const segmentSize = fileSize / estimatedSegments;
    
    // Filter ready and capable workers
    const capableWorkers = this.probedWorkers.filter(w => {
      if (!w.ready) return false;
      
      // Check file size limit
      if (w.maxFileSize < segmentSize) {
        console.log(`Worker ${w.peerId} size limit ${w.maxFileSize} too small for segment ${segmentSize}`);
        return false;
      }
      
      // Check CPU load limit of worker
      const cpuLimit = 85;
      if (w.cpuLoad > cpuLimit) {
        console.log(`Worker ${w.peerId} CPU load ${w.cpuLoad} too high`);
        return false;
      }
      
      return true;
    });
    
    console.log(`Orchestrator: Probed workers count: ${this.probedWorkers.length}, Capable: ${capableWorkers.length}`);
    
    this.activeCapableWorkers = capableWorkers;

    const minWorkersRequired = 2;
    if (capableWorkers.length >= minWorkersRequired) {
      UI.toast(`Pre-flight check passed! Found ${capableWorkers.length} ready workers. Accepting job...`, 'success');
      this.pendingJobId = jobId;
      
      const autoAccept = (document.getElementById('srvAutoAccept') as HTMLInputElement).checked;
      if (autoAccept) {
        this.acceptJob();
      } else {
        UI.setText('jobNotifDetails',
          `File: ${settings.fileName}\nSize: ${UI.formatBytes(settings.fileSize)}\nFormat: ${this._formatJobOutput(settings)}\nCapable Workers: ${capableWorkers.length}`
        );
        UI.show('jobNotification');
        UI.hideEl('providerIdle');
        this.notifyUser('Incoming Job Request', `File: ${settings.fileName} (${UI.formatBytes(settings.fileSize)})`);
      }
    } else {
      const msgText = `Pre-flight check failed: Not enough capable workers (Found: ${capableWorkers.length}, Required: ${minWorkersRequired}). Job declined.`;
      console.log(msgText);
      UI.toast(msgText, 'warning');
      this._appendLog(`⚠️ ${msgText}`);
      this._providerReset();
    }
  },

  async runOrchestration(fileData: any, meta: any) {
    this._appendLog('🏛️ ORCHESTRATOR: Slicing file for distributed cluster...');
    UI.setStage('provStageTranscode', 'active', 'slicing video...');
    
    try {
      const res = await (window as any).api.sliceVideo(this.currentJobId, fileData);
      const { chunkDir, chunks } = res;
      this._appendLog(`🔪 Sliced into ${chunks.length} chunks. Requesting workers...`);
      
      this.activeOrchJob = { 
        chunkDir, 
        chunks: chunks.map((c: any) => ({ ...c, status: 'pending', workerId: null, startTime: null, requestTime: Date.now() })), 
        meta, 
        completed: 0,
        monitorInterval: setInterval(() => this.monitorOrchSubJobs(), 3000)
      };
      
      const chosenWorkerPeerIds: string[] = [];
      if (this.activeCapableWorkers && this.activeCapableWorkers.length > 0) {
        for (let i = 0; i < chunks.length; i++) {
          const worker = this.activeCapableWorkers[i % this.activeCapableWorkers.length];
          chosenWorkerPeerIds.push(worker.peerId);
        }
      }

      signaling.send({
        type: 'request-workers',
        jobId: this.currentJobId,
        workers: chosenWorkerPeerIds.length > 0 ? chosenWorkerPeerIds : undefined,
        count: chosenWorkerPeerIds.length > 0 ? undefined : chunks.length,
        settings: {
          mediaType: 'video',
          format: meta.format,
          quality: meta.quality
        }
      });
      
      UI.setStage('provStageTranscode', 'active', `found 0/${chunks.length} workers`);
    } catch (e: any) {
       this._appendLog('❌ Orchestration Error: ' + e.message);
       this._providerReset();
    }
  },

  handleSubJobMatched(msg: any) {
    if (!this.activeOrchJob) return;

    const pendingChunk = this.activeOrchJob.chunks.find((c: any) => c.status === 'pending');
    if (!pendingChunk) return;

    pendingChunk.status = 'connecting';
    pendingChunk.workerId = msg.providerId;

    const peer = new PeerConnection(msg.jobId);
    this.orchWorkerPeers.set(msg.providerId, peer);

    peer.onDisconnected = () => {
      if (pendingChunk.status !== 'done') {
        this._appendLog(`⚠️ Connection lost to Worker ${msg.providerId} while processing chunk ${pendingChunk.name}.`);
        this.reassignChunk(pendingChunk);
      }
    };

    peer.onConnected = async () => {
      this._appendLog(`📡 P2P connected to Worker ${msg.providerId}. Sending chunk ${pendingChunk.name}...`);
      pendingChunk.status = 'uploading';
      pendingChunk.startTime = Date.now(); // Record start time for timeout monitoring
      
      await peer.sendFile(pendingChunk.path, {
        ...this.activeOrchJob.meta,
        chunkName: pendingChunk.name,
        isSubJob: true
      });
      
      pendingChunk.status = 'processing';
      this._appendLog(`✅ Chunk ${pendingChunk.name} sent to Worker.`);
    };

    peer.onFileReceived = async (resultData: any, meta: any) => {
      this._appendLog(`📥 Received transcoded chunk ${meta.chunkName} from Worker ${msg.providerId}`);
      
      let isValid = false;
      try {
        const size = await (window as any).api.getFileSize(resultData);
        isValid = size > 0;
      } catch (e) {
        console.error('Failed to get chunk file size:', e);
      }

      if (isValid) {
        // Send confirm-job signal for sub-job
        signaling.send({ type: 'confirm-job', jobId: msg.jobId });
        
        await (window as any).api.saveChunk(this.currentJobId, this.activeOrchJob.chunkDir, meta.chunkName, resultData);
        
        pendingChunk.status = 'done';
        this.activeOrchJob.completed++;
        
        const pct = Math.round((this.activeOrchJob.completed / this.activeOrchJob.chunks.length) * 100);
        UI.setProgress('provStageTranscodeProgress', pct);
        UI.setStage('provStageTranscode', 'active', `${this.activeOrchJob.completed}/${this.activeOrchJob.chunks.length} done`);
        
        // Notify client
        signaling.send({ type: 'job-progress', jobId: this.currentJobId, stage: 'transcoding', progress: pct });
      } else {
        this._appendLog(`❌ Verification failed for chunk ${meta.chunkName} from Worker ${msg.providerId} (empty chunk received)`);
        signaling.send({ type: 'reject-job', jobId: msg.jobId, error: 'Chunk size is zero or corrupted' });
        
        // Reassign chunk
        this.reassignChunk(pendingChunk);
      }

      peer.close();
      this.orchWorkerPeers.delete(msg.providerId);

      if (this.activeOrchJob.completed === this.activeOrchJob.chunks.length) {
        this.finalizeOrchestration();
      }
    };

    peer.handleOffer(msg); 
  },

  reassignChunk(chunk: any) {
    if (!this.activeOrchJob) return;
    if (chunk.status === 'done' || chunk.status === 'pending') return; // Already finished or pending, ignore

    this._appendLog(`🔄 Reassigning chunk ${chunk.name} to a new worker...`);

    // 1. Close old peer if any
    if (chunk.workerId) {
      const oldPeer = this.orchWorkerPeers.get(chunk.workerId);
      if (oldPeer) {
        oldPeer.close();
        this.orchWorkerPeers.delete(chunk.workerId);
      }
    }

    // 2. Reset chunk properties
    chunk.status = 'pending';
    chunk.workerId = null;
    chunk.startTime = null;
    chunk.requestTime = Date.now();

    // 3. Request a new worker from signaling server
    let availableWorkers = [];
    if (this.activeCapableWorkers) {
      availableWorkers = this.activeCapableWorkers.filter((w: any) => !this.orchWorkerPeers.has(w.peerId));
    }

    let targetWorkers = undefined;
    if (availableWorkers.length > 0) {
      targetWorkers = [availableWorkers[0].peerId];
    }

    signaling.send({
      type: 'request-workers',
      jobId: this.currentJobId,
      workers: targetWorkers,
      count: targetWorkers ? undefined : 1,
      settings: {
        mediaType: 'video',
        format: this.activeOrchJob.meta.format,
        quality: this.activeOrchJob.meta.quality
      }
    });
  },

  monitorOrchSubJobs() {
    if (!this.activeOrchJob) return;
    
    const now = Date.now();
    const TIMEOUT_MS = 25000; // 25 seconds timeout
    const PENDING_FALLBACK_TIMEOUT_MS = 8000; // 8 seconds fallback
    
    this.activeOrchJob.chunks.forEach((chunk: any) => {
      if (chunk.status === 'pending' && chunk.requestTime) {
        if (now - chunk.requestTime > PENDING_FALLBACK_TIMEOUT_MS) {
          this.processChunkLocally(chunk);
        }
      } else if (chunk.status !== 'pending' && chunk.status !== 'done' && chunk.startTime) {
        if (now - chunk.startTime > TIMEOUT_MS) {
          this._appendLog(`⚠️ Chunk ${chunk.name} timed out (no response in ${TIMEOUT_MS / 1000}s).`);
          this.reassignChunk(chunk);
        }
      }
    });
  },

  async processChunkLocally(chunk: any) {
    if (!this.activeOrchJob) return;
    if (chunk.status !== 'pending') return;

    chunk.status = 'connecting';
    chunk.workerId = 'local';
    chunk.startTime = Date.now();

    this._appendLog(`🏠 ORCHESTRATOR: No worker found for chunk ${chunk.name}. Processing locally...`);
    chunk.status = 'processing';
    
    try {
      const useGpu = (document.getElementById('srvGpu') as HTMLInputElement | null)?.checked || false;
      
      const resultPath = await (window as any).api.transcode(
        `${this.currentJobId}-local-${chunk.name}`,
        chunk.path,
        this.activeOrchJob.meta.format,
        this.activeOrchJob.meta.quality,
        'video',
        useGpu,
        this.activeOrchJob.meta.audioBitrate
      );

      if (!this.activeOrchJob) {
        (window as any).api.deleteFile(resultPath);
        return;
      }

      this._appendLog(`📥 Local transcode finished for chunk ${chunk.name}.`);
      
      await (window as any).api.saveChunk(this.currentJobId, this.activeOrchJob.chunkDir, chunk.name, resultPath);
      
      (window as any).api.deleteFile(resultPath);

      chunk.status = 'done';
      this.activeOrchJob.completed++;

      const pct = Math.round((this.activeOrchJob.completed / this.activeOrchJob.chunks.length) * 100);
      UI.setProgress('provStageTranscodeProgress', pct);
      UI.setStage('provStageTranscode', 'active', `${this.activeOrchJob.completed}/${this.activeOrchJob.chunks.length} done`);
      
      signaling.send({ type: 'job-progress', jobId: this.currentJobId, stage: 'transcoding', progress: pct });

      if (this.activeOrchJob.completed === this.activeOrchJob.chunks.length) {
        this.finalizeOrchestration();
      }
    } catch (e: any) {
      this._appendLog(`❌ Local transcode failed for chunk ${chunk.name}: ${e.message}`);
      chunk.status = 'pending';
      chunk.workerId = null;
      chunk.startTime = null;
      chunk.requestTime = Date.now(); // reset request time to try fallback again
    }
  },

  async finalizeOrchestration() {
    this._appendLog('🏁 All chunks completed! Merging final stream...');
    UI.setStage('provStageTranscode', 'done', '✓ chunks done');
    UI.setStage('provStageSend', 'active', 'merging...');

    try {
      const finalPath = await (window as any).api.mergeVideo(this.currentJobId, this.activeOrchJob.chunkDir, this.activeOrchJob.meta.format);
      this._appendLog('✅ Merge complete! Sending final file to Client...');

      await this.peer.sendFile(finalPath, {
        format: this.activeOrchJob.meta.format,
        fileName: `orchestrated_${this.activeOrchJob.meta.fileName}`
      });

      UI.setStage('provStageSend', 'done', '✓ sent');
      this._appendLog('🏆 ORCHESTRATION COMPLETE!');
      UI.toast('Orchestrated job finished!', 'success');

      signaling.send({ type: 'job-complete', jobId: this.currentJobId, logs: this.jobLogs.slice() });

      // cleanup
      (window as any).api.deleteFile(finalPath);
      this._providerReset();

    } catch (e: any) {
      this._appendLog('❌ Finalization Error: ' + e.message);
      this._providerReset();
    }
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

  async toggleOrchestrator() {
    const orchCheck = document.getElementById('srvOrch') as HTMLInputElement | null;
    if (!orchCheck) return;

    if (orchCheck.checked) {
      // Check criteria
      if (this.benchmarkScore < 150) {
        UI.toast('Orchestrator requires a benchmark score of at least 150 FPS.', 'error');
        orchCheck.checked = false;
        return;
      }
      if (!(window as any).api) {
        UI.toast('Orchestrator mode requires the native Electron desktop app.', 'error');
        orchCheck.checked = false;
        return;
      }
      
      const minWorkersRequired = 2;
      const availableWorkers = this.providerOnline ? (this.activeProvidersCount - 1) : this.activeProvidersCount;
      if (availableWorkers < minWorkersRequired) {
        UI.toast(`Orchestrator mode requires at least ${minWorkersRequired} online worker nodes (Currently available: ${availableWorkers}).`, 'error');
        orchCheck.checked = false;
        return;
      }
      
      this.isOrchestratorEnabled = true;

      // Update srvMaxFileSize slider to allow up to 5 GB
      const slider = document.getElementById('srvMaxFileSize') as HTMLInputElement | null;
      const sliderLabel = document.getElementById('srvMaxFileSizeLabel');
      if (slider && sliderLabel) {
        slider.max = '5000';
        slider.value = '5000';
        sliderLabel.textContent = '5000 MB';
      }

      UI.toast('Orchestrator Mode Enabled (High-Tier)', 'success');
    } else {
      this.isOrchestratorEnabled = false;

      // Restore srvMaxFileSize slider to 500 MB max
      const slider = document.getElementById('srvMaxFileSize') as HTMLInputElement | null;
      const sliderLabel = document.getElementById('srvMaxFileSizeLabel');
      if (slider && sliderLabel) {
        slider.max = '500';
        if (parseInt(slider.value) > 500) {
          slider.value = '500';
          sliderLabel.textContent = '500 MB';
        }
      }

      UI.toast('Orchestrator Mode Disabled', 'info');
    }

    if (this.role === 'provider' && this.providerOnline) {
      this.updateProviderServices();
    }
  },

  getProviderServices() {
    const services: string[] = [];
    if ((document.getElementById('srvVideo') as HTMLInputElement | null)?.checked) services.push('video');
    if ((document.getElementById('srvImage') as HTMLInputElement | null)?.checked) services.push('image');
    if ((document.getElementById('srvGpu') as HTMLInputElement | null)?.checked) services.push('gpu');
    if (this.isOrchestratorEnabled) services.push('orchestrator');
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
  },

  initAnalyticsCharts() {
    const ChartClass = (window as any).Chart;
    if (!ChartClass) {
      console.warn('Chart.js not loaded. Skipping chart visualization.');
      return;
    }

    UI.showEl('analyticsCard');

    // 1. FPS Chart
    const ctxFps = (document.getElementById('fpsChart') as HTMLCanvasElement)?.getContext('2d');
    if (ctxFps) {
      if (this.charts.fps) this.charts.fps.destroy();
      this.charts.fps = new ChartClass(ctxFps, {
        type: 'line',
        data: {
          labels: this.analytics.fpsHistory.map((_, idx) => `Job ${idx + 1}`),
          datasets: [{
            label: 'Speed (FPS)',
            data: this.analytics.fpsHistory,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.05)',
            borderWidth: 2,
            tension: 0.3,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 9 } } },
            y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#64748b', font: { size: 9 } } }
          }
        }
      });
      this.updateFpsAvg();
    }

    // 2. Earnings Chart
    const ctxEarnings = (document.getElementById('earningsChart') as HTMLCanvasElement)?.getContext('2d');
    if (ctxEarnings) {
      if (this.charts.earnings) this.charts.earnings.destroy();
      this.charts.earnings = new ChartClass(ctxEarnings, {
        type: 'line',
        data: {
          labels: this.analytics.earningsHistory.map((_, idx) => `Update ${idx + 1}`),
          datasets: [{
            label: 'Balance',
            data: this.analytics.earningsHistory,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.05)',
            borderWidth: 2,
            tension: 0.3,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 9 } } },
            y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#64748b', font: { size: 9 } } }
          }
        }
      });
      this.updateEarningsTotal();
    }

    // 3. Bandwidth Chart
    const ctxBandwidth = (document.getElementById('bandwidthChart') as HTMLCanvasElement)?.getContext('2d');
    if (ctxBandwidth) {
      if (this.charts.bandwidth) this.charts.bandwidth.destroy();
      this.charts.bandwidth = new ChartClass(ctxBandwidth, {
        type: 'line',
        data: {
          labels: Array(10).fill(''),
          datasets: [{
            label: 'Throughput (MB/s)',
            data: this.analytics.bandwidthHistory,
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.05)',
            borderWidth: 2,
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          animation: { duration: 200 },
          scales: {
            x: { grid: { display: false }, ticks: { display: false } },
            y: { grid: { color: 'rgba(255,255,255,0.03)' }, min: 0, ticks: { color: '#64748b', font: { size: 9 } } }
          }
        }
      });
    }
  },

  updateThroughput() {
    const bytes = (window as any).PeerConnection ? (window as any).PeerConnection.bytesTransferred : 0;
    if ((window as any).PeerConnection) {
      (window as any).PeerConnection.bytesTransferred = 0;
    }
    
    const mbps = bytes / (1024 * 1024);
    
    const curLabel = document.getElementById('chartBandwidthCur');
    if (curLabel) curLabel.textContent = `Current: ${mbps.toFixed(1)} MB/s`;

    this.analytics.bandwidthHistory.push(mbps);
    if (this.analytics.bandwidthHistory.length > 10) {
      this.analytics.bandwidthHistory.shift();
    }

    if (this.charts.bandwidth) {
      this.charts.bandwidth.data.datasets[0].data = this.analytics.bandwidthHistory;
      this.charts.bandwidth.update();
    }
  },

  updateFpsAvg() {
    const avgLabel = document.getElementById('chartFpsAvg');
    if (avgLabel) {
      if (this.analytics.fpsHistory.length > 0) {
        const sum = this.analytics.fpsHistory.reduce((a, b) => a + b, 0);
        const avg = sum / this.analytics.fpsHistory.length;
        avgLabel.textContent = `Avg: ${avg.toFixed(1)} FPS`;
      } else {
        avgLabel.textContent = `Avg: — FPS`;
      }
    }
  },

  updateEarningsTotal() {
    const totalLabel = document.getElementById('chartTotalEarnings');
    if (totalLabel) {
      if (this.analytics.earningsHistory.length > 0) {
        const currentBal = this.analytics.earningsHistory[this.analytics.earningsHistory.length - 1];
        totalLabel.textContent = `Bal: ${currentBal.toFixed(1)} pts`;
      } else {
        totalLabel.textContent = `Bal: — pts`;
      }
    }
  }
};

/* ─── Boot ─── */
document.addEventListener('DOMContentLoaded', () => app.init());
