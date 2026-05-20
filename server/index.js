const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);

/* ─── COOP / COEP headers (required for SharedArrayBuffer → FFmpeg.wasm) ─── */
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

/* ─── State ─── */
const providers = new Map();   // peerId → { ws, status, currentJob }
const clients   = new Map();   // peerId → { ws, currentJob }
const jobs      = new Map();   // jobId  → { clientId, providerId, settings, status, createdAt }
const MAX_HISTORY = 100;       // Max history records to keep
let jobHistory = [];         // Array of completed/failed job records
let peerCounter = 0;
let jobCounter  = 0;
let totalCompleted = 0;

function releaseProviderForJob(jobId, job) {
  if (!job || !job.providerId) return;
  const prov = providers.get(job.providerId);
  if (prov && prov.currentJob === jobId) {
    prov.currentJob = null;
    prov.status = 'online';
  }
}

/* ─── Cleanup Interval (Every 10 mins) ─── */
setInterval(() => {
  const now = Date.now();
  const MAX_AGE = 30 * 60 * 1000; // 30 minutes
  
  for (const [jobId, job] of jobs) {
    if (now - job.createdAt > MAX_AGE) {
      releaseProviderForJob(jobId, job);
      jobs.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

/* ─── History REST API ─── */
app.use(express.json());
app.get('/api/history', (req, res) => {
  res.json(jobHistory.slice().reverse()); // newest first
});
app.delete('/api/history', (req, res) => {
  jobHistory = [];
  res.json({ cleared: true });
});

/* ─── WebSocket Signaling Server ─── */
const wss = new WebSocketServer({ server });

function sanitizeJobSettings(settings) {
  if (!settings) return {};
  return {
    fileName: String(settings.fileName || 'unnamed').replace(/[<>]/g, '').substring(0, 100),
    fileSize: Number(settings.fileSize) || 0,
    mediaType: settings.mediaType === 'image' ? 'image' : 'video',
    format: String(settings.format || 'mp4').replace(/[^a-z0-9]/g, ''),
    quality: String(settings.quality || '720').replace(/[^0-9]/g, '')
  };
}

function broadcast(msg, exclude) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws !== exclude && ws.readyState === 1) ws.send(data);
  });
}

function send(ws, msg) {
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

wss.on('connection', (ws) => {
  const peerId = `peer-${++peerCounter}`;
  ws._peerId = peerId;

  send(ws, { type: 'welcome', peerId, stats: getStats() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      /* ── Provider Registration ── */
      case 'register-provider': {
        const services = Array.isArray(msg.services) ? msg.services : ['video', 'image'];
        providers.set(peerId, { ws, status: 'online', currentJob: null, services });
        send(ws, { type: 'registered', role: 'provider', peerId });
        broadcast({ type: 'stats', ...getStats() });

        // Send any pending jobs that match this provider's services
        for (const [jobId, job] of jobs) {
          if (job.status === 'pending') {
            const supportsService = services.includes(job.settings.mediaType);
            if (supportsService) {
              send(ws, { type: 'job-available', jobId, settings: job.settings, clientId: job.clientId });
            }
          }
        }
        break;
      }

      /* ── Provider goes offline ── */
      case 'provider-offline': {
        const prov = providers.get(peerId);
        if (prov) prov.status = 'offline';
        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      /* ── Provider goes online ── */
      case 'provider-online': {
        const prov = providers.get(peerId);
        if (prov) {
          prov.status = 'online';
          if (Array.isArray(msg.services)) {
            prov.services = msg.services;
          }
          const services = prov.services || ['video', 'image'];
          // Send pending jobs that match this provider's services
          for (const [jobId, job] of jobs) {
            if (job.status === 'pending') {
              const supportsService = services.includes(job.settings.mediaType);
              if (supportsService) {
                send(ws, { type: 'job-available', jobId, settings: job.settings, clientId: job.clientId });
              }
            }
          }
        }
        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      /* ── Provider updates services ── */
      case 'provider-update-services': {
        const prov = providers.get(peerId);
        if (prov && Array.isArray(msg.services)) {
          prov.services = msg.services;
          
          // Send matching pending jobs
          for (const [jobId, job] of jobs) {
            if (job.status === 'pending') {
              const supportsService = prov.services.includes(job.settings.mediaType);
              if (supportsService) {
                send(ws, { type: 'job-available', jobId, settings: job.settings, clientId: job.clientId });
              }
            }
          }
        }
        break;
      }

      /* ── Client Posts a Job ── */
      case 'post-job': {
        const jobId = `job-${++jobCounter}`;
        clients.set(peerId, { ws, currentJob: jobId });

        const settings = sanitizeJobSettings(msg.settings);
        const job = {
          clientId: peerId,
          providerId: null,
          settings,
          status: 'pending',
          createdAt: Date.now()
        };
        jobs.set(jobId, job);

        send(ws, { type: 'job-created', jobId });

        // Notify all online providers who support this service type
        for (const [pid, prov] of providers) {
          if (prov.status === 'online' && !prov.currentJob) {
            const services = prov.services || ['video', 'image'];
            const supportsService = services.includes(settings.mediaType);
            if (supportsService) {
              send(prov.ws, { type: 'job-available', jobId, settings: job.settings, clientId: peerId });
            }
          }
        }

        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      /* ── Provider Accepts a Job ── */
      case 'accept-job': {
        const job = jobs.get(msg.jobId);
        const prov = providers.get(peerId);
        if (!job || job.status !== 'pending' || !prov) {
          send(ws, { type: 'error', message: 'Job no longer available' });
          break;
        }

        job.providerId = peerId;
        job.status = 'matched';
        prov.currentJob = msg.jobId;
        prov.status = 'busy';

        // Tell client they got matched
        const client = clients.get(job.clientId);
        if (client) {
          send(client.ws, { type: 'job-matched', jobId: msg.jobId, providerId: peerId });
        }

        // Tell provider to initiate WebRTC
        send(ws, { type: 'job-accepted', jobId: msg.jobId, clientId: job.clientId });

        // Tell other providers job is taken
        for (const [pid, p] of providers) {
          if (pid !== peerId) {
            send(p.ws, { type: 'job-taken', jobId: msg.jobId });
          }
        }

        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      /* ── WebRTC Signaling Relay ── */
      case 'job-upload-failed': {
        const job = jobs.get(msg.jobId);
        if (!job) break;
        if (job.clientId !== peerId) break;
        if (!['matched', 'transferring'].includes(job.status)) break;

        job.status = 'failed';
        job.failedAt = Date.now();

        const prov = providers.get(job.providerId);
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
      case 'ice-candidate': {
        const targetId = msg.target;
        let targetWs = providers.get(targetId)?.ws || clients.get(targetId)?.ws;
        if (targetWs) {
          send(targetWs, { ...msg, from: peerId });
        }
        break;
      }

      /* ── Job Status Updates (with Auth) ── */
      case 'job-progress': {
        const job = jobs.get(msg.jobId);
        if (!job) break;
        // Only provider can report progress
        if (job.providerId !== peerId) break;

        // Relay progress to client
        const cl = clients.get(job.clientId);
        if (cl) send(cl.ws, { type: 'job-progress', jobId: msg.jobId, stage: msg.stage, progress: msg.progress });
        break;
      }

      case 'job-complete': {
        const job = jobs.get(msg.jobId);
        if (job) {
          // Only assigned provider can report successful completion
          if (job.providerId !== peerId) break;
          if (job.status === 'complete') break;

          job.status = 'complete';
          job.completedAt = Date.now();
          totalCompleted++;
          releaseProviderForJob(msg.jobId, job);
          
          const record = {
            jobId: msg.jobId,
            status: 'complete',
            settings: job.settings,
            clientId: job.clientId,
            providerId: job.providerId,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            duration: job.completedAt - job.createdAt,
            error: null,
            logs: Array.isArray(msg.logs) ? msg.logs.slice(0, 50) : [] // Limit logs
          };
          jobHistory.push(record);
          if (jobHistory.length > MAX_HISTORY) jobHistory.shift();
        }
        broadcast({ type: 'stats', ...getStats() });
        break;
      }

      case 'job-failed': {
        const job = jobs.get(msg.jobId);
        if (job) {
          // Only assigned provider can report failure
          if (job.providerId !== peerId) break;
          if (job.status === 'failed' || job.status === 'complete') break;

          job.status = 'failed';
          job.failedAt = Date.now();
          releaseProviderForJob(msg.jobId, job);
          const cl = clients.get(job.clientId);
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

      /* ── Get Stats ── */
      case 'get-stats': {
        send(ws, { type: 'stats', ...getStats() });
        break;
      }
    }
  });

  ws.on('close', () => {
    // Clean up provider
    if (providers.has(peerId)) {
      const prov = providers.get(peerId);
      if (prov.currentJob) {
        const job = jobs.get(prov.currentJob);
        if (job && job.status !== 'complete') {
          job.status = 'failed';
          job.failedAt = Date.now();
          const cl = clients.get(job.clientId);
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

    // Clean up client
    if (clients.has(peerId)) {
      const cl = clients.get(peerId);
      if (cl.currentJob) {
        const job = jobs.get(cl.currentJob);
        if (job && job.status !== 'complete') {
          job.status = 'cancelled';
          const prov = providers.get(job.providerId);
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

/* ─── Start ─── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  ⚡ TranscodeNet signaling server running`);
  console.log(`  🌐 http://localhost:${PORT}\n`);
});
