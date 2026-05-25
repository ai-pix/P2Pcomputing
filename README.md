# TranscodeNet: P2P Distributed Video Transcoding Platform

TranscodeNet is a decentralized, peer-to-peer (P2P) platform designed to distribute video and image transcoding tasks across a network of worker nodes. By leveraging Electron, WebRTC, and FFmpeg, it allows users to either request transcoding services (Clients) or provide their computational power (Providers) to the network.

## 📥 Download

Get the latest alpha version of TranscodeNet:

- **[Windows (v0.0.3-alpha)](https://github.com/ai-pix/P2Pcomputing/releases/download/v0.0.3-alpha/TranscodeNet-Setup-0.0.3-alpha.exe)**

## 🚀 Features

-   **Decentralized Transcoding:** No central server handles the transcoding. Jobs are distributed directly between peers.
-   **P2P Communication:** Uses WebRTC for secure, direct data transfer between Clients and Providers.
-   **Native FFmpeg Performance:** Utilizes native FFmpeg binaries via Electron for high-performance transcoding on worker nodes.
-   **Economic Incentives (15% Orchestrator Commission):** Orchestrator nodes coordinate segment slices and retain a 15% coordination fee from sub-job segment rewards.
-   **Work Verification:** Shifted validation authority to the client with a 30-second auto-complete fallback timeout to protect worker rewards.
-   **Media Privacy (Secure Route):** Restricts worker matchmaking for secure jobs to nodes with a reputation score &ge; 95 and benchmark score &ge; 150.
-   **Dynamic Signaling Failover:** Automatic connection cycling to backup signaling servers if the primary one goes offline.
-   **Orchestrator Worker Selection:** Orchestrator nodes take direct charge of matchmaking, target routing sub-jobs specifically to capable workers.

## 🏗 Architecture

TranscodeNet consists of three main components:

1.  **Signaling Server (`/server`):** A Node.js/WebSocket server that facilitates peer discovery and WebRTC signaling. It does *not* handle any media data.
2.  **Provider Node:** An Electron application instance that registers itself as a "compute provider." It receives media files via P2P, transcodes them using local FFmpeg, and sends the result back.
3.  **Client Node:** An Electron application instance where users upload media, select transcoding settings, and get matched with available Providers.

## 🛠 Getting Started

### Prerequisites

-   [Node.js](https://nodejs.org/) (v16 or higher recommended)
-   npm or yarn

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/ai-pix/P2Pcomputing.git
    cd transcode-p2p
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

### Running the Application

#### 1. Start the Signaling Server
The signaling server must be running for peers to find each other.
```bash
npm start
```
By default, it runs on `http://localhost:3000`.

#### 2. Launch the Desktop Application
Open two or more instances to test the P2P functionality (one as Client, others as Providers).
```bash
npm run electron
```

## 📖 Usage

### As a Client
1.  Open the app and ensure you are on the **"Transcode Media"** tab.
2.  Drag and drop a video or image file into the upload zone.
3.  Choose your desired output format and quality/resolution.
4.  Click **"Submit Job"**. The app will find an available provider and start the P2P transfer.
5.  Once complete, download the transcoded file.

### As a Provider
1.  Open the app and switch to the **"Share Compute"** tab.
2.  Configure which modules you want to host (Video/Image).
3.  Toggle the status to **"Online"**.
4.  The app will now automatically accept and process incoming jobs from the network.

## 💻 Technical Stack

-   **Frontend:** HTML5, Vanilla CSS, JavaScript (ES6+)
-   **Desktop Framework:** [Electron](https://www.electronjs.org/)
-   **P2P Networking:** WebRTC (via `RTCPeerConnection` and `RTCDataChannel`)
-   **Transcoding Engine:** [FFmpeg](https://ffmpeg.org/) (via `ffmpeg-static`)
-   **Signaling:** [WebSockets](https://github.com/websockets/ws)
-   **Server:** [Express](https://expressjs.com/)

## 📋 Changelog

### v0.0.3-alpha (Current Release)
- **Economic Incentive Uplifts**: 15% Orchestrator fee retention on Worker segment payouts.
- **Client-Led Work Verification**: Handled output validation and client-side confirmation/rejection signaling, backed by a 30-second server auto-complete timeout to protect workers.
- **Secure Transcode Routing**: Matchmaking blocks `'secure'` jobs to workers unless they have reputation >= 95 and benchmark >= 150. Added `reputationScore` tracking in DB (bounds `[0, 100]`, default `80`, `+1` on success, `-10` on failures).
- **Orchestrator Worker Selection**: Shifted worker selection logic from server to Orchestrator nodes. Orchestrators assign chunks to specific workers from their probed pool of capable workers.
- **Decentralized Signaling Failover**: Dynamic signaling URL backup array (`wsUrls`) that automatically rotates/reconnects on websocket closed/error events.
- **UI Enhancements**: Adjusted desktop CSS layout to keep status indicators, balance, reputation, and signaling URL input fixed in the bottom-left corner of the sidebar, making navigation scrollable.

### v0.0.2-alpha
- Migrated codebase to TypeScript.
- Matchmaking memory leaks and status sync issue fixes.
- Optimized hardware benchmarking.
- Added testing credits button.

## 📜 License

This project is licensed under the MIT License - see the LICENSE file for details (if applicable).

---
*Built with ❤️ for decentralized computing.*
