import type { ThreadsApi } from '../shared/threads.ts';

declare global {
  interface Window {
    /** What the preload bridge exposes. The page reaches the main process through this and nothing else. */
    agent: {
      threads: ThreadsApi;
    };
  }
}

export {};
