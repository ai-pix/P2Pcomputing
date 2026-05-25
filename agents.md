# 🤖 Agent Handbook: TranscodeNet Developer Guide

Welcome, Agent! This file is designed specifically for AI coding assistants working on the **TranscodeNet** codebase. It contains critical architectural context, system designs, code mapping, and development guidelines to help you understand the codebase instantly and start working safely and effectively.

---

## 📖 1. Project Vision & Core Concept
TranscodeNet is a **decentralized, peer-to-peer (P2P) media transcoding platform**.
* **The Problem**: Centralized video/image transcoding is expensive and resource-intensive.
* **The Solution**: Distribute media processing workloads across a network of compute providers directly from browser-to-browser (or application-to-application) via WebRTC.
* **Economic Model**: Clients fund jobs using utility credits (Points). Compute providers (Workers) earn credits for transcoding, and coordination nodes (Orchestrators) earn a 15% commission fee for dividing, scheduling, and merging large media files.

---

## 🏗️ 2. System Architecture

TranscodeNet runs on a split architecture consisting of three primary peer types and a central signaling server:

```
                  +--------------------------------+
                  |    Signaling & Ledger Server   |
                  |     (WebSockets, Port 3000)    |
                  +-----------------+--------------+
                                    | (Relay & Ledger)
                +-------------------+-------------------+
                | (Job Request)                         | (Sub-jobs)
     +----------v----------+                 +----------v----------+
     |     Client Node     |                 |  Orchestrator Node  |
     |   (Electron/Web)    |                 |   (Electron Host)   |
     +----------+----------+                 +----------+----------+
                |                                       |
                | <========== WebRTC P2P Data ==========>|
                |             Channel Link              | (Segment processing)
                |                                       |
                |                            +----------v----------+
                |                            |     Worker Node     |
                |                            |   (Electron/Web)    |
                |                            +---------------------+
                +=======================================> (Simple fallback path)
```

### The Roles
1. **Client Node**: 
   - Submits transcode jobs with resolution/format specs.
   - Puts points into escrow on the signaling server.
   - Receives output files directly via P2P and verifies output integrity (verifies output file size $>0$).
   - Sends `confirm-job` (releasing escrow to provider) or `reject-job` (failing the job, refunding client points, and penalizing provider reputation).
2. **Provider (Worker) Node**:
   - Registers as online, sending local capability telemetry (GPU check, CPU benchmark score, max file size limit).
   - Receives raw media chunks via P2P, runs native FFmpeg processes, and transfers transcoded results back.
3. **Orchestrator Node**:
   - A high-tier provider that acts as a client for multiple worker nodes.
   - Slices large video files into segments using native FFmpeg.
   - Conducts **pre-flight worker probing** to find capable workers.
   - Coordinates worker sub-jobs, relays chunks, verifies segment integrity, and merges segments back into a single output file to return to the client.
4. **Signaling Server**:
   - A lightweight Node.js server.
   - Manages socket connections and relays SDP offers/answers/ICE candidates between peers.
   - Operates the ledger database (`db.json`) which stores accounts, point balances, benchmark scores, and reputation metrics.
   - Enforces matchmaking rules, payouts (deducting 15% commission for orchestrators), and validation timers.

---

## 🔄 3. Critical Workflows & Protocols

### A. Pre-Flight Worker Probing
To prevent accepting orchestrator jobs that cannot be completed, the Orchestrator runs a pre-flight probe:
1. On receiving `job-available`, the Orchestrator broadcasts a `probe-workers` message.
2. Online worker nodes receive the request and respond with their telemetry (`cpuLoad`, `benchmarkScore`, `maxFileSize`, `gpuEnabled`, `ready` status).
3. The Orchestrator aggregates responses for 1 second.
4. It estimates the segment size ($\text{fileSize} / N$) and checks if at least $2$ workers are ready, idle, and have limits $\ge$ segment size.
5. If yes, it accepts the job; otherwise, it declines.

### B. Client-Led Verification Loop
To prevent workers from submitting corrupt/empty results and claiming rewards, clients verify output files:
1. Worker finishes transcoding and sends the output file to the client via WebRTC.
2. Worker notifies the signaling server with `job-transcoded`.
3. Signaling server sets the job status to `'transcoded'` and fires a **30-second verification timer**.
4. On file receipt, the client verifies if `fileSize > 0`.
   - **Pass**: Sends `confirm-job` to signaling server. Server clears the timer, registers job completion, and transfers points.
   - **Fail/Corrupt**: Sends `reject-job`. Server clears timer, refunds escrow, sets job status to `'failed'`, and deducts $-10$ provider reputation.
   - **Timeout (Client Offline/Freeloading)**: After 30 seconds, the server automatically completes the job, transferring points to protect the worker.

### C. Direct Worker Selection & Target Routing
- Because Orchestrators earn a 15% commission fee, they are responsible for finding and assigning workers.
- The Orchestrator maps chunks to specific workers from the probed pool (`activeCapableWorkers`).
- It sends the list of peer IDs in `workers` inside the `request-workers` socket message.
- The signaling server targets the sub-job notifications **specifically** to those worker peer IDs, bypassing automatic backend matching.
- During worker failure/disconnect, the Orchestrator selects an idle worker from the probed pool to reassign the chunk.

---

## 📂 4. Codebase Navigation Map

* **`src/main.ts`** *(Electron Main Process)*: 
  - Handles WMI queries for hardware encoder checks on Windows.
  - Spawns and manages local FFmpeg processes (transcoding, slicing, and merging).
  - Handles path normalization via `path.resolve()` to prevent sandbox path traversal exploits.
* **`src/preload.ts`** *(IPC Bridge)*:
  - Exposes sandbox-safe file APIs (`getFileSize`, `readChunk`, `saveOutputFile`) and FFmpeg logs/progress listeners to the renderer.
* **`src/public/js/app.ts`** *(Renderer App Controller)*:
  - The central state engine for both Clients and Workers.
  - Manages the transcode queue, active Orchestrator job states, performance analytics (using Chart.js), and settings.
* **`src/public/js/peer.ts`** *(WebRTC Connection Wrapper)*:
  - Encapsulates RTCPeerConnection, ICE candidate handling, and chunked file transfer rules over `RTCDataChannel`.
* **`src/public/js/signaling.ts`** *(Signaling Client)*:
  - Manages the WebSocket connection.
  - Implements dynamic failover connection cycling across a backup list of signaling URLs (`wsUrls`).
* **`src/server/db.ts`** *(Ledger Database)*:
  - Manages `server/db.json` reads/writes, account authentication, credit balance transactions, and reputation scores.
* **`src/server/index.ts`** *(Signaling & Coordination Server)*:
  - WebSocket signaling server handling job matching rules, escrow locks, orchestrator commission reductions, and verification timeouts.
* **`public/index.html` & `public/css/styles.css`** *(UI & Styling)*:
  - Responsive viewport layout. Contains the bottom-left sidebar footer status card (Node Ready, Balance, Reputation, Signaling input) styled as a static component to avoid viewport scroll cut-off.

---

## 🛡️ 5. Key Constraints & Security Rules

Keep the following rules in mind when modifying this codebase:

1. **Path Sandboxing (CRITICAL)**:
   - Any file-system operation executed in `src/main.ts` MUST resolve and validate the input paths.
   - Always run `path.resolve(path)` and verify it starts with `BASE_TEMP_DIR` before executing reads/writes/deletes to prevent directory traversal exploits.
2. **Cross-Platform Compatibility**:
   - Hardware detection using WMI (`powershell.exe`) is win32-specific.
   - Always wrap Windows-only commands under `process.platform === 'win32'` checks, and provide a fallback logic (e.g. standard CPU FFmpeg logs) for macOS and Linux.
3. **Escrow Refund Integrity**:
   - When calling escrow refunds or point transfers, update the state flags (e.g. `job.escrowAmount = 0` and `job.escrowRefunded = true`) **before** running the database operations to prevent double-refund race conditions.

---

## 🚀 6. Future Roadmap & Plans
When planning new features, align with the following direction:
* **Proof-of-Transcode (PoT)**: Implement a verification protocol using cryptographic watermarks or deterministic subset checks (e.g., verifying specific random frames) to ensure workers actually executed the transcode.
* **Auction & Dynamic Bidding**: Replace static job cost calculations with a decentralized market bidding engine where workers can bid rates based on demand and hardware specs.
* **Blockchain Integrations**: Migrate the credit ledger database from `db.json` to a Layer 2 blockchain or state channels for trustless decentralized payouts.
* **Distributed Red-Herring Tasks**: Introduce decoy jobs (pre-transcoded segments) submitted by orchestrators to catch and ban malicious workers submitting fake results.
