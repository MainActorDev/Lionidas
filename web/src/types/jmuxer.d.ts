declare module 'jmuxer' {
  export interface JMuxerOptions {
    node: string | HTMLVideoElement;
    mode?: 'audio' | 'video' | 'both';
    flushingTime?: number;
    fps?: number;
    debug?: boolean;
    onReady?: () => void;
    onError?: (err: string) => void;
  }
  export default class JMuxer {
    constructor(options: JMuxerOptions);
    feed(data: { video: Uint8Array; duration?: number; last?: boolean }): void;
    destroy(): void;
    reset(): void;
  }
}
