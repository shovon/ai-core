// The bridge between the page and the main process. Each feature exposes its
// own surface here, so the page never gets `ipcRenderer` itself.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { THREAD_CHANNELS, type ThreadEvent, type ThreadsApi } from '../shared/threads.ts';

const threads: ThreadsApi = {
  list: () => ipcRenderer.invoke(THREAD_CHANNELS.list),
  read: (thread) => ipcRenderer.invoke(THREAD_CHANNELS.read, thread),
  create: () => ipcRenderer.invoke(THREAD_CHANNELS.create),
  send: (thread, after, text) => ipcRenderer.invoke(THREAD_CHANNELS.send, thread, after, text),
  answer: (thread, after) => ipcRenderer.invoke(THREAD_CHANNELS.answer, thread, after),
  stop: (thread) => ipcRenderer.invoke(THREAD_CHANNELS.stop, thread),
  goTo: (thread, item) => ipcRenderer.invoke(THREAD_CHANNELS.goTo, thread, item),
  rename: (thread, title) => ipcRenderer.invoke(THREAD_CHANNELS.rename, thread, title),
  remove: (thread) => ipcRenderer.invoke(THREAD_CHANNELS.remove, thread),
  // Hands each event on without Electron's own: that one carries `sender`,
  // and the point of the bridge is that the page never gets it.
  subscribe: (listener) => {
    const heard = (_event: IpcRendererEvent, event: ThreadEvent) => listener(event);
    ipcRenderer.on(THREAD_CHANNELS.event, heard);
    return () => {
      ipcRenderer.off(THREAD_CHANNELS.event, heard);
    };
  },
};

contextBridge.exposeInMainWorld('agent', { threads });
