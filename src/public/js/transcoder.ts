/* ─── Transcoder Module — FFmpeg.wasm wrapper (self-hosted) ─── */
class Transcoder {
  ffmpeg: any;
  loaded: boolean;
  onLog: ((message: string) => void) | null;
  onProgress: ((percent: number) => void) | null;
  onLoadProgress: ((message: string, progress: number) => void) | null;
  _loading: Promise<void> | null;

  constructor() {
    this.ffmpeg = null;
    this.loaded = false;
    this.onLog = null;
    this.onProgress = null;
    this.onLoadProgress = null;
    this._loading = null;
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

    const { FFmpeg } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/+esm' as any);
    const { toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm' as any);

    if (this.onLoadProgress) this.onLoadProgress('Creating FFmpeg instance...', 15);
    this.ffmpeg = new FFmpeg();

    this.ffmpeg.on('log', ({ message }: { message: string }) => {
      if (this.onLog) this.onLog(message);
    });

    this.ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      const pct = Math.round(progress * 100);
      if (this.onProgress) this.onProgress(pct);
    });

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

  getOutputArgs(format: string, quality: string) {
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

  async transcode(fileBlob: Blob, inputName: string, outputFormat: string, quality: string) {
    if (!this.loaded) await this.load();

    const { fetchFile } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm' as any);

    const inputFileName = 'input' + this._getExtension(inputName);
    const outputFileName = 'output.' + outputFormat;

    const inputData = await fetchFile(fileBlob);
    await this.ffmpeg.writeFile(inputFileName, inputData);

    const args = ['-i', inputFileName, ...this.getOutputArgs(outputFormat, quality), outputFileName];

    if (this.onLog) this.onLog(`ffmpeg ${args.join(' ')}`);

    await this.ffmpeg.exec(args);

    const outputData = await this.ffmpeg.readFile(outputFileName);
    const outputBlob = new Blob([outputData.buffer], { type: this._getMimeType(outputFormat) });

    await this.ffmpeg.deleteFile(inputFileName);
    await this.ffmpeg.deleteFile(outputFileName);

    return outputBlob;
  }

  _getExtension(name: string) {
    const parts = name.split('.');
    return parts.length > 1 ? '.' + parts.pop() : '';
  }

  _getMimeType(format: string) {
    switch (format) {
      case 'mp4': return 'video/mp4';
      case 'webm': return 'video/webm';
      case 'avi': return 'video/x-msvideo';
      case 'mkv': return 'video/x-matroska';
      case 'webp': return 'image/webp';
      case 'jpg': return 'image/jpeg';
      case 'png': return 'image/png';
      default: return 'application/octet-stream';
    }
  }
}
