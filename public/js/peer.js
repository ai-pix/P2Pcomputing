/* ─── Peer Module — WebRTC DataChannel + Chunked File Transfer ─── */
const CHUNK_SIZE = 64 * 1024; // 64KB chunks

class PeerConnection {
  constructor(jobId = 'unknown') {
    this.jobId = jobId;
    this.pc = null;
    this.dataChannel = null;
    this.onProgress = null;
    this.onFileReceived = null;
    this.onConnected = null;
    this._connected = false;
    this._sending = false;

    /* receive state */
    this._receiveBuffer = [];
    this._receivedSize = 0;
    this._fileMeta = null;
    this._isNative = !!window.api;
    this._nativePath = null;
    this._receiveReady = Promise.resolve();
    this._writeChain = Promise.resolve();
  }

  createConnection() {
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        signaling.send({ type: 'ice-candidate', target: this.remoteId, candidate: event.candidate });
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log('ICE connection state:', this.pc.connectionState);
    };

    return this.pc;
  }

  /* ── Initiator (Client) creates offer ── */
  async createOffer(remoteId) {
    this.remoteId = remoteId;
    this.createConnection();

    this.dataChannel = this.pc.createDataChannel('file-transfer', { ordered: true });
    this.dataChannel.binaryType = 'arraybuffer';
    this._setupDataChannelEvents(this.dataChannel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    signaling.send({ type: 'offer', target: remoteId, sdp: this.pc.localDescription });
  }

  /* ── Responder (Provider) handles offer ── */
  async handleOffer(msg) {
    this.remoteId = msg.from;
    this.createConnection();

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.dataChannel.binaryType = 'arraybuffer';
      this._setupDataChannelEvents(this.dataChannel);
    };

    await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    signaling.send({ type: 'answer', target: msg.from, sdp: this.pc.localDescription });
  }

  async handleAnswer(msg) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  }

  async handleIceCandidate(msg) {
    if (this.pc && msg.candidate) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (e) {}
    }
  }

  /* ── Send a file in chunks ── */
  async sendFile(file, meta) {
    if (this._sending) return Promise.reject(new Error('Already sending a file'));
    this._sending = true;

    if (typeof file === 'string' && !!window.api) {
      return this._sendNativeFile(file, meta).finally(() => { this._sending = false; });
    }
    
    return new Promise((resolve, reject) => {
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        return reject(new Error('DataChannel not open'));
      }

      // Send metadata first
      const metaMsg = JSON.stringify({ type: 'file-meta', fileName: file.name, fileSize: file.size, ...meta });
      this.dataChannel.send(metaMsg);

      const reader = new FileReader();
      let offset = 0;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      const readSlice = () => {
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        reader.readAsArrayBuffer(slice);
      };

      reader.onload = (e) => {
        this.dataChannel.send(e.target.result);
        offset += e.target.result.byteLength;

        if (this.onProgress) this.onProgress('sending', (offset / file.size) * 100);

        if (offset < file.size) {
          // Flow control — wait if buffer is getting full
          if (this.dataChannel.bufferedAmount > 8 * CHUNK_SIZE) {
            setTimeout(readSlice, 50);
          } else {
            readSlice();
          }
        } else {
          // Signal end of file
          this.dataChannel.send(JSON.stringify({ type: 'file-end' }));
          this._sending = false;
          resolve();
        }
      };

      reader.onerror = (e) => { this._sending = false; reject(e); };
      readSlice();
    });
  }

  async _sendNativeFile(filePath, meta) {
    return new Promise(async (resolve, reject) => {
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') return reject(new Error('DataChannel not open'));

      try {
        const fileSize = await window.api.getFileSize(filePath);
        
        // Send metadata first
        const fileName = filePath.split(/[\\/]/).pop();
        const metaMsg = JSON.stringify({ type: 'file-meta', fileName, fileSize, ...meta });
        this.dataChannel.send(metaMsg);

        let offset = 0;
        
        const sendNextChunk = async () => {
          if (offset >= fileSize) {
            this.dataChannel.send(JSON.stringify({ type: 'file-end' }));
            return resolve();
          }

          const end = Math.min(offset + CHUNK_SIZE - 1, fileSize - 1);
          const chunk = await window.api.readOutputFileChunk(filePath, offset, end);
          
          this.dataChannel.send(chunk);
          offset += chunk.byteLength;

          if (this.onProgress) this.onProgress('sending', (offset / fileSize) * 100);

          if (this.dataChannel.bufferedAmount > 8 * CHUNK_SIZE) {
            setTimeout(sendNextChunk, 50);
          } else {
            sendNextChunk();
          }
        };

        sendNextChunk();
      } catch (e) {
        reject(e);
      }
    });
  }

  /* ── Setup DataChannel event handlers ── */
  _setupDataChannelEvents(channel) {
    channel.onopen = () => {
      if (this._connected) return;
      this._connected = true;
      console.log('DataChannel open — ready to transfer');
      if (this.onConnected) this.onConnected();
    };

    channel.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'file-meta') {
            this._fileMeta = msg;
            this._receiveBuffer = [];
            this._receivedSize = 0;
            this._nativePath = null;
            this._writeChain = Promise.resolve();
            if (this._isNative) {
              const ext = msg.fileName ? '.' + msg.fileName.split('.').pop() : '.bin';
              this._receiveReady = window.api.createTempWriteStream(this.jobId, ext).then((path) => {
                this._nativePath = path;
                return path;
              });
              await this._receiveReady;
            } else {
              this._receiveReady = Promise.resolve();
            }
          } else if (msg.type === 'file-end') {
            if (this._isNative) {
              await this._receiveReady;
              await this._writeChain;
              await window.api.finishTempWrite(this.jobId);
              if (this.onFileReceived) this.onFileReceived(this._nativePath, this._fileMeta, true);
            } else {
              const blob = new Blob(this._receiveBuffer);
              if (this.onFileReceived) this.onFileReceived(blob, this._fileMeta, false);
            }
            this._receiveBuffer = [];
            this._receivedSize = 0;
            this._fileMeta = null;
          } else if (msg.type === 'transcode-progress') {
            if (this.onProgress) this.onProgress('transcoding', msg.progress);
          }
        } catch (e) {}
      } else {
        // Binary chunk
        this._receivedSize += event.data.byteLength;
        if (this._isNative) {
          const chunk = event.data;
          this._writeChain = this._writeChain.then(async () => {
            await this._receiveReady;
            await window.api.writeTempChunk(this.jobId, chunk);
          });
          await this._writeChain;
        } else {
          this._receiveBuffer.push(event.data);
        }
        
        if (this._fileMeta && this.onProgress) {
          this.onProgress('receiving', (this._receivedSize / this._fileMeta.fileSize) * 100);
        }
      }
    };

    channel.onerror = (e) => console.error('DataChannel error:', e);
    channel.onclose = () => console.log('DataChannel closed');
  }

  /* Send transcode progress to remote peer */
  sendProgress(progress) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify({ type: 'transcode-progress', progress }));
    }
  }

  close() {
    if (this.dataChannel) this.dataChannel.close();
    if (this.pc) this.pc.close();
    this.pc = null;
    this.dataChannel = null;
  }
}
