# TranscodeNet: P2P Distributed Video Transcoding Platform

TranscodeNet is a decentralized, peer-to-peer (P2P) platform designed to distribute video and image transcoding tasks across a network of worker nodes. By leveraging Electron, WebRTC, and FFmpeg, it allows users to either request transcoding services (Clients) or provide their computational power (Providers) to the network.

## 🚀 Features

-   **Decentralized Transcoding:** No central server handles the transcoding. Jobs are distributed directly between peers.
-   **P2P Communication:** Uses WebRTC for secure, direct data transfer between Clients and Providers.
-   **Native FFmpeg Performance:** Utilizes native FFmpeg binaries via Electron for high-performance transcoding on worker nodes.
-   **Multi-Format Support:**
    -   **Video:** MP4 (H.264), WebM (VP9), AVI, MKV.
    -   **Image:** WebP, JPG, PNG.
-   **Cross-Platform Client:** Built with Electron, providing a consistent experience across Windows, macOS, and Linux.
-   **Real-time Monitoring:** Track progress, logs, and network statistics in real-time.
-   **Auto-Updates:** Integrated auto-updater to keep the client software current.

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

## 📜 License

This project is licensed under the MIT License - see the LICENSE file for details (if applicable).

---
*Built with ❤️ for decentralized computing.*
