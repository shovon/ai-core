// The threads feature's end of the bridge: channels in, events out. Nothing
// here decides anything.
import { BrowserWindow, ipcMain } from 'electron';
import { THREAD_CHANNELS, type Sent, type ThreadEvent } from '../../../shared/threads.ts';
import type { Threads } from './threads.ts';

export const registerThreadsIpc = (threads: Threads) => {
  ipcMain.handle(THREAD_CHANNELS.list, () => threads.list());
  ipcMain.handle(THREAD_CHANNELS.read, (_event, thread: unknown) => {
    if (typeof thread !== 'string') throw new Error('read takes a thread id');
    return threads.read(thread);
  });
  ipcMain.handle(THREAD_CHANNELS.create, () => threads.create());
  // A failed model call is answered, not thrown: Electron would wrap a throw
  // in its own message, and the page shows this one as it is.
  ipcMain.handle(THREAD_CHANNELS.send, async (_event, thread: unknown, after: unknown, text: unknown): Promise<Sent> => {
    if (typeof thread !== 'string' || (after !== null && typeof after !== 'string') || typeof text !== 'string')
      return { error: 'send takes a thread id, the id of an item or null, and text' };
    try {
      await threads.send(thread, after, text);
      return {};
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(THREAD_CHANNELS.answer, async (_event, thread: unknown, after: unknown): Promise<Sent> => {
    if (typeof thread !== 'string' || typeof after !== 'string') return { error: 'answer takes a thread id and the id of an item' };
    try {
      await threads.answer(thread, after);
      return {};
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(THREAD_CHANNELS.stop, async (_event, thread: unknown) => {
    if (typeof thread !== 'string') throw new Error('stop takes a thread id');
    await threads.stop(thread);
  });
  ipcMain.handle(THREAD_CHANNELS.rename, async (_event, thread: unknown, title: unknown) => {
    if (typeof thread !== 'string' || typeof title !== 'string') throw new Error('rename takes a thread id and a title');
    await threads.rename(thread, title);
  });
  ipcMain.handle(THREAD_CHANNELS.remove, async (_event, thread: unknown) => {
    if (typeof thread !== 'string') throw new Error('remove takes a thread id');
    await threads.remove(thread);
  });
  ipcMain.handle(THREAD_CHANNELS.goTo, async (_event, thread: unknown, item: unknown) => {
    if (typeof thread !== 'string' || typeof item !== 'string') throw new Error('goTo takes a thread id and an item id');
    await threads.goTo(thread, item);
  });
};

/** Every window of the app hears every thread's events. */
export const broadcastThreads = (event: ThreadEvent) => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(THREAD_CHANNELS.event, event);
};
