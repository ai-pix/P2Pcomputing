import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'path';
import db from './db.js';

interface JobSettings {
  fileName: string;
  fileSize: number;
  mediaType: 'image' | 'video';
  format: string;
  quality: string;
  audioBitrate?: string;
  frameCount?: number;
  width?: number;
  height?: number;
  privacyLevel?: 'public' | 'secure';
}

interface Job {
  clientId: string;
  clientNodeId: string;
  providerId: string | null;
  providerNodeId: string | null;
  settings: JobSettings;
  status: 'pending' | 'matched' | 'transferring' | 'transcoding' | 'transcoded' | 'complete' | 'failed' | 'cancelled';
  createdAt: number;
  completedAt?: number;
  failedAt?: number;
  escrowAmount: number;
  escrowRefunded: boolean;
  isSubJob?: boolean;
  mainJobId?: string;
  actualSettings?: JobSettings;
  transcodeLogs?: any[];
}

interface Provider {
  ws: WebSocket;
  status: 'online' | 'offline' | 'busy';
  currentJob: string | null;
  services: string[];
  nodeId: string;
  benchmarkScore: number;
}

interface Client {
  ws: WebSocket;
  currentJob: string | null;
  nodeId: string;
}

const app = express();
const server = http.createServer(app);

function calculateJobCost(settings: JobSettings): number {
  const mediaType = settings.mediaType;
  const format = settings.format;
  const quality = settings.quality;

  if (mediaType === 'image') {
    if (settings.width && settings.height) {
      const pixels = settings.width * settings.height;
      const formatMult = format === 'png' ? 0.25 : 0.1;
      return Math.round((pixels / 10000) * formatMult * 100) / 100;
    }
    const sizeMB = (settings.fileSize || 0) / (1024 * 1024);
    return Math.round(sizeMB * 5 * 100) / 100;
  } else {
    let frames = Number(settings.frameCount);
    if (!frames) {
      frames = Math.round(((settings.fileSize || 0) / 102400) * 30);
    }
    
    let resMult = 0.01;
    if (quality === '360' || quality === '480') resMult = 0.005;
    else if (quality === '720') resMult = 0.01;
    else if (quality === '1080') resMult = 0.02;
    else if (quality === '1440' || quality === '2160') resMult = 0.08;
    
    return Math.round(frames * resMult * 100) / 100;
  }
}

function isProviderScoreSufficient(score: number, settings: JobSettings): boolean {
  if (settings.mediaType === 'video') {
    const isHeavyResolution = ['1080', '1440', '2160'].includes(settings.quality);
    const isHeavySize = settings.fileSize > 100 * 1024 * 1024;
    if (isHeavyResolution || isHeavySize) {
      return (score || 0) >= 150;
    }
  }
  return true;
}

function isProviderEligibleForJob(prov: Provider, settings: JobSettings): boolean {
  const services = prov.services || ['video', 'image'];
  const supportsService = services.includes(settings.mediaType);
  if (!supportsService) return false;

  const scorePass = isProviderScoreSufficient(prov.benchmarkScore, settings);
  if (!scorePass) return false;

  const provAccount = db.getAccount(prov.nodeId);
  const repScore = provAccount ? (provAccount.reputationScore !== undefined ? provAccount.reputationScore : 80) : 0;
  const privacyPass = settings.privacyLevel === 'secure' ? (repScore >= 95 && prov.benchmarkScore >= 150) : true;
  return privacyPass;
}

function refundEscrow(jobId: string, job: Job) {
  if (!job || !job.escrowAmount || job.escrowRefunded) return;
  const clientAcct = db.getAccount(job.clientNodeId);
  if (clientAcct) {
    const updated = db.adjustPoints(job.clientNodeId, clientAcct.points + job.escrowAmount);
    job.escrowRefunded = true;
    console.log(`[Escrow] Refunded ${job.escrowAmount.toFixed(2)} to client ${job.clientNodeId} for job ${jobId}`);
    
    const cl = clients.get(job.clientId);
    if (cl && cl.ws) {
      send(cl.ws, { type: 'balance-update', points: updated.points, reputationScore: updated.reputationScore });
    }
  }
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// Network Benchmark Endpoint
app.post('/api/test-upload', express.raw({ limit: '20mb', type: '*/*' }), (req, res) => {
  // We just want to measure the time it takes to receive the data
  res.status(200).send('ok');
});

const providers = new Map<string, Provider>();
const clients = new Map<string, Client>();
const jobs = new Map<string, Job>();
const verificationTimers = new Map<string, NodeJS.Timeout>();
const MAX_HISTORY = 100;
let jobHistory: any[] = [];
let peerCounter = 0;
let jobCounter = 0;
let totalCompleted = 0;

function releaseProviderForJob(jobId: string, job: Job) {
  if (!job || !job.providerId) return;
  const prov = providers.get(job.providerId);
  if (prov && prov.currentJob === jobId) {
    prov.currentJob = null;
    prov.status = 'online';
  }
}

setInterval(() => {
  const now = Date.now();
  const MAX_AGE = 30 * 60 * 1000;
  
  for (const [jobId, job] of jobs) {
    if (now - job.createdAt > MAX_AGE) {
      releaseProviderForJob(jobId, job);
      jobs.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

app.use(express.json());
app.get('/api/history', (req, res) => {
  res.json(jobHistory.slice().reverse());
});
app.delete('/api/history', (req, res) => {
  jobHistory = [];
  res.json({ cleared: true });
});

const wss = new WebSocketServer({ server });

function sanitizeJobSettings(settings: any): JobSettings {
  if (!settings) return { fileName: 'unnamed', fileSize: 0, mediaType: 'video', format: 'mp4', quality: '720', audioBitrate: '128k', privacyLevel: 'public' };
  return {
    fileName: String(settings.fileName || 'unnamed').replace(/[<>]/g, '').substring(0, 100),
    fileSize: Number(settings.fileSize) || 0,
    mediaType: settings.mediaType === 'image' ? 'image' : 'video',
    format: String(settings.format || 'mp4').replace(/[^a-z0-9]/g, ''),
    quality: String(settings.quality || '720').replace(/[^0-9a-zA-Z]/g, ''),
    audioBitrate: settings.audioBitrate ? String(settings.audioBitrate).replace(/[^a-z0-9]/g, '') : '128k',
    privacyLevel: settings.privacyLevel === 'secure' ? 'secure' : 'public'
  };
}

function broadcast(msg: any, exclude?: WebSocket) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws !== exclude && ws.readyState === 1) ws.send(data);
  });
}

function send(ws: WebSocket, msg: any) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function getStats() {
  return {
    activeProviders: [...providers.values()].filter(p => p.status === 'online').length,
    totalProviders: providers.size,
    pendingJobs: [...jobs.values()].filter(j => j.status === 'pending').length,
    activeJobs: [...jobs.values()].filter(j => ['matched', 'transferring', 'transcoding'].includes(j.status)).length,
    totalCompleted
  };
}

function finalizeJobCompletion(jobId: string, actualSettings: JobSettings, logs: any[]) {
  const job = jobs.get(jobId);
  if (!job || job.status === 'complete' || job.status === 'failed') return;

  const timer = verificationTimers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    verificationTimers.delete(jobId);
  }

  const prov = job.providerId ? providers.get(job.providerId) : null;
  if (prov) {
    let finalCost = calculateJobCost(actualSettings);
    if (job.isSubJob) {
      finalCost = Math.round(finalCost * 0.85 * 100) / 100;
    }
    const escrow = job.escrowAmount || 0;

    job.escrowAmount = 0;
    job.escrowRefunded = true;

    try {
      const clientAcct = db.getAccount(job.clientNodeId);
      if (clientAcct) {
        db.adjustPoints(job.clientNodeId, clientAcct.points + escrow);
      }
      const transferRes = db.transferPoints(job.clientNodeId, prov.nodeId, finalCost, job.settings.fileSize);

      const cl = clients.get(job.clientId) || providers.get(job.clientId);
      if (cl) send(cl.ws, { type: 'balance-update', points: transferRes.client.points, reputationScore: transferRes.client.reputationScore });
      send(prov.ws, { type: 'balance-update', points: transferRes.provider.points, reputationScore: transferRes.provider.reputationScore });
    } catch (err) {
      console.error('Point settlement failed:', err);
    }
  }

  job.status = 'complete';
  job.completedAt = Date.now();
  totalCompleted++;
  releaseProviderForJob(jobId, job);

  const record = {
    jobId: jobId,
    status: 'complete',
    settings: job.settings,
    clientId: job.clientId,
    providerId: job.providerId,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    duration: job.completedAt - job.createdAt,
    error: null,
    logs: Array.isArray(logs) ? logs.slice(0, 50) : []
  };
  jobHistory.push(record);
  if (jobHistory.length > MAX_HISTORY) jobHistory.shift();

  // Notify client and worker that job is finalized
  const cl = clients.get(job.clientId) || providers.get(job.clientId);
  if (cl) send(cl.ws, { type: 'job-finalized', jobId });
  if (prov) send(prov.ws, { type: 'job-finalized', jobId });

  broadcast({ type: 'stats', ...getStats() });
}

interface SocketWithMetadata extends WebSocket {
  _peerId?: string;
  _nodeId?: string;
}

wss.on('connection', (ws: SocketWithMetadata) => {
  const peerId = `peer-${++peerCounter}`;
  ws._peerId = peerId;

  send(ws, { type: 'welcome', peerId, stats: getStats() });

  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'register-identity': {
        try {
          const account = db.authenticate(msg.nodeId, msg.nodeSecret);
          ws._nodeId = msg.nodeId;
          
          if (msg.role === 'provider') {
            // Prevent client/provider leaks
            clients.delete(peerId);

            if (msg.benchmarkScore) {
              db.updateBenchmark(msg.nodeId, msg.benchmarkScore);
              account.benchmarkScore = msg.benchmarkScore;
            }
            const services = Array.isArray(msg.services) ? msg.services : ['video', 'image'];
            const status = msg.status === 'online' ? 'online' : 'offline';
            
            providers.set(peerId, { 
              ws, 
              status, 
              currentJob: null, 
              services, 
              nodeId: msg.nodeId, 
              benchmarkScore: account.benchmarkScore || 0 
            });
            send(ws, { type: 'registered', role: 'provider', peerId, account });

            if (status === 'online') {
              const prov = providers.get(peerId);
              if (prov) {
                for (const [jobId, job] of jobs) {
                  if (job.status === 'pending' && isProviderEligibleForJob(prov, job.settings)) {
                    send(ws, { type: 'job-available', jobId, settings: job.settings, clientId: job.clientId });
                  }
                }
              }
            }
          } else {
            // Prevent client/provider leaks
            providers.delete(peerId);

            clients.set(peerId, { ws, currentJob: null, nodeId: msg.nodeId });
            send(ws, { type: 'registered', role: 'client', peerId, account });
          }
          broadcast({ type: 'stats', ...getStats() });
        } catch (e: any) {
          send(ws, { type: 'error', message: 'Authentication failed: ' + e.message });
        }
        break;
      }

      case 'register-provider': {
        const services = Array.isArray(msg.services) ? msg.services : ['video', 'image'];
        const existing = providers.get(peerId);
        const nodeId = existing ? existing.nodeId : (ws._nodeId || 'unknown');
        const benchmarkScore = existing ? existing.benchmarkScore : 0;
        
        // Prevent client/provider leaks
        clients.delete(peerId);

        const status = msg.status === 'online' ? 'online' : 'offline';

        providers.set(peerId, { ws, status, currentJob: null, services, nodeId, benchmarkScore });
        send(ws, { type: 'registered', role: 'provider', peerId });

        const prov = providers.get(peerId);
        if (status === 'online' && prov) {
          for (const [jobId, job] of jobs) {
            if (job.status === 'pending' && isProviderEligibleForJob(prov, job.settings)) {
              send(prov.ws, { type: 'job-available', jobId, settings: job.settings, clientId: job.clientId });
            }
          }
        }

        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      case 'provider-offline': {
        const prov = providers.get(peerId);
        if (prov) prov.status = 'offline';
        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      case 'provider-online': {
        const prov = providers.get(peerId);
        if (prov) {
          prov.status = 'online';
          if (Array.isArray(msg.services)) {
            prov.services = msg.services;
          }
          const services = prov.services || ['video', 'image'];
          const score = prov.benchmarkScore || 0;
          for (const [jobId, job] of jobs) {
            if (job.status === 'pending' && isProviderEligibleForJob(prov, job.settings)) {
              send(prov.ws, { type: 'job-available', jobId, settings: job.settings, clientId: job.clientId });
            }
          }
        }
        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      case 'provider-update-services': {
        const prov = providers.get(peerId);
        if (prov && Array.isArray(msg.services)) {
          prov.services = msg.services;
          
          for (const [jobId, job] of jobs) {
            if (job.status === 'pending' && isProviderEligibleForJob(prov, job.settings)) {
              send(prov.ws, { type: 'job-available', jobId, settings: job.settings, clientId: job.clientId });
            }
          }
        }
        break;
      }

      case 'post-job': {
        const clientInfo = clients.get(peerId);
        if (!clientInfo || !clientInfo.nodeId) {
          send(ws, { type: 'error', message: 'Client not authenticated. Please register identity first.' });
          break;
        }

        const account = db.getAccount(clientInfo.nodeId);
        if (!account) {
          send(ws, { type: 'error', message: 'Account not found' });
          break;
        }

        const settings = sanitizeJobSettings(msg.settings);
        settings.frameCount = Number(msg.settings.frameCount) || 0;
        settings.width = Number(msg.settings.width) || 0;
        settings.height = Number(msg.settings.height) || 0;

        const estimatedCost = calculateJobCost(settings);
        if (account.points < estimatedCost) {
          send(ws, { 
            type: 'error', 
            message: `Insufficient balance! Job costs ~${estimatedCost.toFixed(1)} points, you only have ${account.points.toFixed(1)} points. Host compute to earn credits.` 
          });
          break;
        }

        const jobId = `job-${++jobCounter}`;
        clientInfo.currentJob = jobId;

        const job: Job = {
          clientId: peerId,
          clientNodeId: clientInfo.nodeId,
          providerId: null,
          providerNodeId: null,
          settings,
          status: 'pending',
          createdAt: Date.now(),
          escrowAmount: estimatedCost,
          escrowRefunded: false
        };
        jobs.set(jobId, job);

        db.adjustPoints(clientInfo.nodeId, account.points - estimatedCost);

        send(ws, { type: 'job-created', jobId, estimatedCost, newBalance: account.points - estimatedCost });

        for (const [pid, prov] of providers) {
          if (prov.status === 'online' && !prov.currentJob && isProviderEligibleForJob(prov, settings)) {
            const services = prov.services || ['video', 'image'];
            const isOrchestrator = services.includes('orchestrator');

            // If it's a video job and we have an orchestrator, prefer them
            const isSmallFile = settings.fileSize && settings.fileSize < 100 * 1024 * 1024;
            if (settings.mediaType === 'video' && isOrchestrator && !isSmallFile) {
              send(prov.ws, { type: 'job-available', jobId, settings: job.settings, clientId: peerId, isOrchestrator: true });
            } else {
              send(prov.ws, { type: 'job-available', jobId, settings: job.settings, clientId: peerId });
            }
          }
        }

        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      case 'accept-job': {
        const job = jobs.get(msg.jobId);
        const prov = providers.get(peerId);
        if (!job || job.status !== 'pending' || !prov) {
          send(ws, { type: 'error', message: 'Job no longer available' });
          break;
        }

        job.providerId = peerId;
        job.providerNodeId = prov.nodeId;
        job.status = 'matched';
        prov.currentJob = msg.jobId;
        prov.status = 'busy';

        const client = clients.get(job.clientId) || providers.get(job.clientId);
        if (client) {
          send(client.ws, { 
            type: 'job-matched', 
            jobId: msg.jobId, 
            providerId: peerId, 
            clientId: job.clientId,
            isSubJob: !!job.isSubJob 
          });
        }

        send(ws, { type: 'job-accepted', jobId: msg.jobId, clientId: job.clientId, isSubJob: !!job.isSubJob });

        for (const [pid, p] of providers) {
          if (pid !== peerId) {
            send(p.ws, { type: 'job-taken', jobId: msg.jobId });
          }
        }

        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      case 'job-upload-failed': {
        const job = jobs.get(msg.jobId);
        if (!job) break;
        if (job.clientId !== peerId) break;
        if (!['matched', 'transferring'].includes(job.status)) break;

        refundEscrow(msg.jobId, job);

        job.status = 'failed';
        job.failedAt = Date.now();

        const prov = providers.get(job.providerId!);
        if (prov) {
          send(prov.ws, {
            type: 'job-cancelled',
            jobId: msg.jobId,
            error: String(msg.error || 'Client upload failed').substring(0, 200)
          });
        }
        releaseProviderForJob(msg.jobId, job);

        jobHistory.push({
          jobId: msg.jobId,
          status: 'failed',
          settings: job.settings,
          clientId: job.clientId,
          providerId: job.providerId,
          createdAt: job.createdAt,
          completedAt: job.failedAt,
          duration: job.failedAt - job.createdAt,
          error: String(msg.error || 'Client upload failed').substring(0, 200),
          logs: [],
          stack: null
        });
        if (jobHistory.length > MAX_HISTORY) jobHistory.shift();

        broadcast({ type: 'job-failed', jobId: msg.jobId, error: msg.error || 'Client upload failed' });
        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate':
      case 'probe-workers-response': {
        const targetId = msg.target;
        let targetWs = providers.get(targetId)?.ws || clients.get(targetId)?.ws;
        if (targetWs) {
          send(targetWs, { ...msg, from: peerId });
        }
        break;
      }

      case 'job-progress': {
        const job = jobs.get(msg.jobId);
        if (!job) break;
        if (job.providerId !== peerId) break;

        const cl = clients.get(job.clientId);
        if (cl) send(cl.ws, { type: 'job-progress', jobId: msg.jobId, stage: msg.stage, progress: msg.progress });
        break;
      }

      case 'job-transcoded': {
        const job = jobs.get(msg.jobId);
        const prov = providers.get(peerId);
        if (job && prov) {
          if (job.providerId !== peerId) break;
          if (job.status === 'complete' || job.status === 'failed') break;

          const actualSettings = { ...job.settings };
          if (msg.actualFrames) actualSettings.frameCount = msg.actualFrames;
          if (msg.actualWidth && msg.actualHeight) {
            actualSettings.width = msg.actualWidth;
            actualSettings.height = msg.actualHeight;
          }

          job.actualSettings = actualSettings;
          job.transcodeLogs = Array.isArray(msg.logs) ? msg.logs : [];
          job.status = 'transcoded';

          console.log(`[Verification] Job ${msg.jobId} transcoded by worker. Starting 30s auto-complete timer.`);

          // Start 30s auto-complete timeout
          if (verificationTimers.has(msg.jobId)) {
            clearTimeout(verificationTimers.get(msg.jobId)!);
          }
          const timer = setTimeout(() => {
            console.log(`[Verification] Timeout for job ${msg.jobId}. Auto-completing...`);
            finalizeJobCompletion(msg.jobId, actualSettings, job.transcodeLogs || []);
          }, 30000);
          verificationTimers.set(msg.jobId, timer);

          // Notify client and worker
          const cl = clients.get(job.clientId) || providers.get(job.clientId);
          if (cl) {
            send(cl.ws, { type: 'job-transcoded', jobId: msg.jobId });
          }
          send(prov.ws, { type: 'job-transcoded', jobId: msg.jobId });
        }
        break;
      }

      case 'confirm-job': {
        const job = jobs.get(msg.jobId);
        if (job && job.clientId === peerId) {
          console.log(`[Verification] Client confirmed job ${msg.jobId}. Finalizing...`);
          finalizeJobCompletion(msg.jobId, job.actualSettings || job.settings, job.transcodeLogs || []);
        }
        break;
      }

      case 'reject-job': {
        const job = jobs.get(msg.jobId);
        if (job && job.clientId === peerId && job.status !== 'complete' && job.status !== 'failed') {
          console.log(`[Verification] Client rejected job ${msg.jobId}. Failing...`);
          
          const timer = verificationTimers.get(msg.jobId);
          if (timer) {
            clearTimeout(timer);
            verificationTimers.delete(msg.jobId);
          }

          refundEscrow(msg.jobId, job);
          job.status = 'failed';
          job.failedAt = Date.now();
          releaseProviderForJob(msg.jobId, job);

          const prov = job.providerId ? providers.get(job.providerId) : null;
          if (prov) {
            send(prov.ws, { type: 'job-cancelled', jobId: msg.jobId, error: msg.error || 'Client rejected verification' });
            db.adjustReputation(prov.nodeId, -10);
          }

          const record = {
            jobId: msg.jobId,
            status: 'failed',
            settings: job.settings,
            clientId: job.clientId,
            providerId: job.providerId,
            createdAt: job.createdAt,
            completedAt: job.failedAt,
            duration: job.failedAt - job.createdAt,
            error: String(msg.error || 'Client rejected verification').substring(0, 200),
            logs: job.transcodeLogs || []
          };
          jobHistory.push(record);
          if (jobHistory.length > MAX_HISTORY) jobHistory.shift();

          broadcast({ type: 'stats', ...getStats() });
        }
        break;
      }

      case 'job-failed': {
        const job = jobs.get(msg.jobId);
        if (job) {
          if (job.providerId !== peerId) break;
          if (job.status === 'failed' || job.status === 'complete') break;

          const timer = verificationTimers.get(msg.jobId);
          if (timer) {
            clearTimeout(timer);
            verificationTimers.delete(msg.jobId);
          }

          refundEscrow(msg.jobId, job);

          job.status = 'failed';
          job.failedAt = Date.now();
          releaseProviderForJob(msg.jobId, job);

          if (job.providerNodeId) {
            db.adjustReputation(job.providerNodeId, -10);
          }

          const cl = clients.get(job.clientId) || providers.get(job.clientId);
          if (cl) send(cl.ws, { type: 'job-failed', jobId: msg.jobId, error: msg.error });
          
          const record = {
            jobId: msg.jobId,
            status: 'failed',
            settings: job.settings,
            clientId: job.clientId,
            providerId: job.providerId,
            createdAt: job.createdAt,
            completedAt: job.failedAt,
            duration: job.failedAt - job.createdAt,
            error: String(msg.error || 'Unknown error').substring(0, 200),
            logs: Array.isArray(msg.logs) ? msg.logs.slice(0, 50) : [],
            stack: msg.stack ? String(msg.stack).substring(0, 500) : null
          };
          jobHistory.push(record);
          if (jobHistory.length > MAX_HISTORY) jobHistory.shift();
        }
        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      case 'get-stats': {
        send(ws, { type: 'stats', ...getStats() });
        break;
      }

      case 'add-test-credits': {
        if (!ws._nodeId) {
          send(ws, { type: 'error', message: 'Identity not registered. Cannot add credits.' });
          break;
        }
        try {
          const account = db.getAccount(ws._nodeId);
          if (account) {
            const updated = db.adjustPoints(ws._nodeId, account.points + 1000);
            send(ws, { type: 'balance-update', points: updated.points, reputationScore: updated.reputationScore });
            console.log(`🎁 Added 1000 test credits to node ${ws._nodeId}. New balance: ${updated.points}`);
          } else {
            send(ws, { type: 'error', message: 'Account not found.' });
          }
        } catch (e: any) {
          send(ws, { type: 'error', message: 'Failed to add credits: ' + e.message });
        }
        break;
      }

      case 'request-workers': {
        const mainJob = jobs.get(msg.jobId);
        if (!mainJob || mainJob.providerId !== peerId) break;

        const subJobSettings = msg.settings;
        let found = 0;

        if (Array.isArray(msg.workers)) {
          for (const targetPid of msg.workers) {
            const prov = providers.get(targetPid);
            if (prov && prov.status === 'online' && !prov.currentJob && isProviderEligibleForJob(prov, subJobSettings)) {
              const services = prov.services || ['video', 'image'];
              if (services.includes(subJobSettings.mediaType)) {
                const subJobId = `${msg.jobId}-sub-${found}-${Math.random().toString(36).substring(2, 8)}`;
                
                // Register sub-job
                jobs.set(subJobId, {
                  clientId: peerId, // Orchestrator is client
                  clientNodeId: mainJob.providerNodeId!, 
                  providerId: null,
                  providerNodeId: null,
                  settings: {
                    ...subJobSettings,
                    audioBitrate: subJobSettings.audioBitrate || '128k'
                  },
                  status: 'pending',
                  createdAt: Date.now(),
                  escrowAmount: 0,
                  escrowRefunded: true,
                  isSubJob: true,
                  mainJobId: msg.jobId
                } as any);

                send(prov.ws, { 
                  type: 'job-available', 
                  jobId: subJobId, 
                  settings: subJobSettings, 
                  clientId: peerId,
                  isSubJob: true 
                });
                
                found++;
              }
            }
          }
        } else {
          const count = Number(msg.count) || 1;
          for (const [pid, prov] of providers) {
            if (pid !== peerId && prov.status === 'online' && !prov.currentJob && isProviderEligibleForJob(prov, subJobSettings)) {
              const services = prov.services || ['video', 'image'];
              if (services.includes(subJobSettings.mediaType)) {
                const subJobId = `${msg.jobId}-sub-${found}-${Math.random().toString(36).substring(2, 8)}`;
                
                // Register sub-job
                jobs.set(subJobId, {
                  clientId: peerId, // Orchestrator is client
                  clientNodeId: mainJob.providerNodeId!, 
                  providerId: null,
                  providerNodeId: null,
                  settings: {
                    ...subJobSettings,
                    audioBitrate: subJobSettings.audioBitrate || '128k'
                  },
                  status: 'pending',
                  createdAt: Date.now(),
                  escrowAmount: 0,
                  escrowRefunded: true,
                  isSubJob: true,
                  mainJobId: msg.jobId
                } as any);

                send(prov.ws, { 
                  type: 'job-available', 
                  jobId: subJobId, 
                  settings: subJobSettings, 
                  clientId: peerId,
                  isSubJob: true 
                });
                
                found++;
                if (found >= count) break;
              }
            }
          }
        }
        break;
      }

      case 'probe-workers': {
        const settings = sanitizeJobSettings(msg.settings);
        for (const [pid, prov] of providers) {
          if (pid !== peerId && prov.status === 'online') {
            const services = prov.services || ['video', 'image'];
            if (services.includes(settings.mediaType)) {
              send(prov.ws, {
                type: 'probe-workers-request',
                jobId: msg.jobId,
                orchestratorId: peerId,
                settings
              });
            }
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (providers.has(peerId)) {
      const prov = providers.get(peerId)!;
      if (prov.currentJob) {
        const job = jobs.get(prov.currentJob);
        if (job && job.status !== 'complete' && job.status !== 'failed') {
          const timer = verificationTimers.get(prov.currentJob);
          if (timer) {
            clearTimeout(timer);
            verificationTimers.delete(prov.currentJob);
          }

          refundEscrow(prov.currentJob, job);
          job.status = 'failed';
          job.failedAt = Date.now();

          db.adjustReputation(prov.nodeId, -10);

          const cl = clients.get(job.clientId) || providers.get(job.clientId);
          if (cl) send(cl.ws, { type: 'job-failed', jobId: prov.currentJob, error: 'Provider disconnected' });
          
          jobHistory.push({
            jobId: prov.currentJob, status: 'failed', settings: job.settings,
            clientId: job.clientId, providerId: job.providerId,
            createdAt: job.createdAt, completedAt: job.failedAt,
            duration: job.failedAt - job.createdAt,
            error: 'Provider disconnected', logs: [], stack: null
          });
          if (jobHistory.length > MAX_HISTORY) jobHistory.shift();
        }
      }
      providers.delete(peerId);
    }

    if (clients.has(peerId)) {
      const cl = clients.get(peerId)!;
      if (cl.currentJob) {
        const job = jobs.get(cl.currentJob);
        if (job && job.status !== 'complete') {
          refundEscrow(cl.currentJob, job);
          job.status = 'cancelled';
          const prov = providers.get(job.providerId || '');
          if (prov) {
            send(prov.ws, { type: 'job-cancelled', jobId: cl.currentJob });
          }
          releaseProviderForJob(cl.currentJob, job);
        }
      }
      clients.delete(peerId);
    }

    broadcast({ type: 'stats', ...getStats() });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  ⚡ TranscodeNet signaling server running`);
  console.log(`  🌐 http://localhost:${PORT}\n`);
});
