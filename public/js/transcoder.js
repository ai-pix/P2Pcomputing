/* ─── Transcoder Module — FFmpeg.wasm wrapper (self-hosted) ─── */
class Transcoder {
  constructor() {
    this.ffmpeg = null;
    this.loaded = false;
    this.onLog = null;
    this.onProgress = null;
    this.onLoadProgress = null;
  }

  async load() {
    if (this.loaded) return;
    if (this._loading) return this._loading;

    this._loading = this._doLoad();
    await this._loading;
    this._loading = null;
  }

  async _doLoad() {
    if (this.onLoadProgress) this.onLoadProgress('Importing FFmpeg module...', 5);

    // Import FFmpeg class and util from npm (served locally via node_modules or CDN fallback)
    const { FFmpeg } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/+esm');
    const { toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm');

    if (this.onLoadProgress) this.onLoadProgress('Creating FFmpeg instance...', 15);
    this.ffmpeg = new FFmpeg();

    this.ffmpeg.on('log', ({ message }) => {
      if (this.onLog) this.onLog(message);
    });

    this.ffmpeg.on('progress', ({ progress, time }) => {
      const pct = Math.round(progress * 100);
      if (this.onProgress) this.onProgress(pct);
    });

    // Load all heavy files from localhost (self-hosted in /vendor/ffmpeg/)
    // This is MUCH faster than CDN since files are served locally
    if (this.onLoadProgress) this.onLoadProgress('Loading FFmpeg core (local)...', 25);
    const coreURL = await toBlobURL('/vendor/ffmpeg/ffmpeg-core.js', 'text/javascript');

    if (this.onLoadProgress) this.onLoadProgress('Loading WASM binary (local ~32MB)...', 40);
    const wasmURL = await toBlobURL('/vendor/ffmpeg/ffmpeg-core.wasm', 'application/wasm');

    if (this.onLoadProgress) this.onLoadProgress('Loading worker (local)...', 80);
    const classWorkerURL = await toBlobURL('/vendor/ffmpeg/ffmpeg-worker.js', 'text/javascript');

    if (this.onLoadProgress) this.onLoadProgress('Initializing FFmpeg engine...', 90);
    await this.ffmpeg.load({ coreURL, wasmURL, classWorkerURL });

    if (this.onLoadProgress) this.onLoadProgress('Ready!', 100);
    this.loaded = true;
  }

  getOutputArgs(format, quality) {
    const scale = `-vf`;
    const scaleVal = `scale=-2:${quality}`;

    switch (format) {
      case 'mp4':
        return [scale, scaleVal, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k'];
      case 'webm':
        return [scale, scaleVal, '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-c:a', 'libopus'];
      case 'avi':
        return [scale, scaleVal, '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'mp3'];
      case 'mkv':
        return [scale, scaleVal, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac'];
      default:
        return [scale, scaleVal, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23'];
    }
  }

  async transcode(fileBlob, inputName, outputFormat, quality) {
    if (!this.loaded) await this.load();

    const { fetchFile } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm');

    const inputFileName = 'input' + this._getExtension(inputName);
    const outputFileName = 'output.' + outputFormat;

    // Write input file to FFmpeg virtual filesystem
    const inputData = await fetchFile(fileBlob);
    await this.ffmpeg.writeFile(inputFileName, inputData);

    // Build FFmpeg arguments
    const args = ['-i', inputFileName, ...this.getOutputArgs(outputFormat, quality), outputFileName];

    if (this.onLog) this.onLog(`ffmpeg ${args.join(' ')}`);

    // Run transcoding
    await this.ffmpeg.exec(args);

    // Read output
    const outputData = await this.ffmpeg.readFile(outputFileName);
    const outputBlob = new Blob([outputData.buffer], { type: this._getMimeType(outputFormat) });

    // Cleanup
    await this.ffmpeg.deleteFile(inputFileName);
    await this.ffmpeg.deleteFile(outputFileName);

    return outputBlob;
  }

  _getExtension(filename) {
    const ext = filename.split('.').pop();
    return ext ? '.' + ext : '.mp4';
  }

  _getMimeType(format) {
    const types = { mp4: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', mkv: 'video/x-matroska' };
    return types[format] || 'video/mp4';
  }
}

const transcoder = new Transcoder();
