declare module 'rtsp-stream-viewer' {
  export interface RTSPConfig {
    rtspUrl: string;
    transport: 'tcp' | 'udp';
    frameRate: number;
    resolution: string;
    quality: number;
    port: number;
    ffmpegOptions: string[];
  }

  export interface StreamStats {
    activeClients: number;
    frameCount: number;
    totalFrames: number;
    currentFps: number;
    uptime: number;
    isActive: boolean;
    config: RTSPConfig;
  }

  export class RTSPStreamServer {
    constructor(config?: Partial<RTSPConfig>);
    
    start(port?: number): Promise<void>;
    stop(): Promise<void>;
    getStats(): StreamStats;
    updateConfig(config: Partial<RTSPConfig>): Promise<RTSPConfig>;
    resetConfig(): Promise<RTSPConfig>;
  }

  export default RTSPStreamServer;
} 