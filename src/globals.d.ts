interface Window {
  api?: {
    createTempWriteStream: (jobId: string, extension: string) => Promise<string>;
    writeTempChunk: (jobId: string, buffer: any) => Promise<void>;
    finishTempWrite: (jobId: string) => Promise<string>;
    readOutputFileChunk: (path: string, start: number, end: number) => Promise<any>;
    getFileSize: (path: string) => Promise<number>;
    deleteFile: (path: string) => Promise<void>;
    saveOutputFile: (tempPath: string, defaultName: string) => Promise<{ canceled: boolean; filePath?: string }>;
    transcode: (jobId: string, inputPath: string, format: string, quality: string, mediaType: string, useGpu?: boolean, audioBitrate?: string) => Promise<string>;
    getHwInfo: () => Promise<{ encoder: string | null; label: string; model: string }>;
    getSystemStats: () => Promise<{ cpuLoad: number; totalMem: number; freeMem: number; memUsage: number; temp: number }>;
    getNodeIdentity: () => Promise<{ nodeId: string; nodeSecret: string }>;
    runBenchmark: (useGpu: boolean) => Promise<number>;
    onTranscodeProgress: (callback: (data: { jobId: string; pct: number }) => void) => () => void;
    onTranscodeLog: (callback: (data: { jobId: string; msg: string }) => void) => () => void;
    minimizeWindow: () => Promise<void>;
    maximizeWindow: () => Promise<void>;
    closeWindow: () => Promise<void>;
    sendNotification: (title: string, message: string) => Promise<void>;
    onUpdateAvailable: (callback: (data: { version: string; releaseDate?: string }) => void) => () => void;
    onUpdateDownloaded: (callback: (data: { version: string }) => void) => () => void;
    downloadUpdate: () => Promise<void>;
    installUpdate: () => Promise<void>;
    runNetworkBenchmark: () => Promise<{ dlSpeed: number; ulSpeed: number }>;
    onNetworkProgress: (callback: (data: { stage: 'download' | 'upload'; pct: number; speed: number }) => void) => () => void;
  };
}
