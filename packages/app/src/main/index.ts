// Composition root for the main process. Whatever holds state or does I/O is
// built here, handed to what needs it, and closed here. The model's client
// and its credentials live here: the page never sees either.
import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { anthropic, type AnthropicSettings } from '@ai-idioms/anthropic-provider';
import { openMigrated } from './sqlite.ts';
import { settings } from './settings.ts';
import { cloudflareSearch } from './features/web-search/cloudflare.ts';
import { webSearch } from './features/web-search/web-search.ts';
import { createThreads } from './features/threads/threads.ts';
import { sqliteStore, THREAD_MIGRATIONS } from './features/threads/sqlite-store.ts';
import { broadcastThreads, registerThreadsIpc } from './features/threads/threads-ipc.ts';

// Electron names `userData` after `productName`, which is a display name and
// may change. The directory is named here instead, so a rename never strands
// what is kept in it. An explicit `--user-data-dir` still wins, so a scratch
// profile stays a scratch profile.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'ai-agent-library'));
}

/** The variables in a file of NAME=value lines; none if there is no such file. */
const fromFile = (file: string): Record<string, string | undefined> => {
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1000,
    height: 680,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // What the model writes can hold links. One must never take the window away
  // from the app, which has no way back, so anything outward opens in the
  // real browser, or the mail app, and nothing else opens at all.
  const openExternally = (url: string) => {
    if (/^(https?:\/\/|mailto:)/.test(url)) void shell.openExternal(url);
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return;
    event.preventDefault();
    openExternally(url);
  });

  // The dev server while developing, the built page once packaged.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
};

app.on('ready', () => {
  // Every thread, on this machine, in one file.
  const db = openMigrated(path.join(app.getPath('userData'), 'threads.db'), THREAD_MIGRATIONS);

  // The environment, and under it the `.env` beside the app while developing.
  // The file is read here and handed to what needs it. It is not put into
  // `process.env`, so nothing else picks a setting up by accident.
  const { webSearch: search, missing } = settings({ ...fromFile(path.join(app.getAppPath(), '.env')), ...process.env });
  if (!search) console.warn(`Web search is off: ${missing.join(' and ')} not set.`);

  // The client finds its own credentials: ANTHROPIC_API_KEY, or the profile
  // `ant auth login` saved. Without either, the first send says so.
  const claude = anthropic(new Anthropic());
  // What every request to Anthropic is sent with. This model always thinks
  // before it answers, and by default shows none of it, which reads as a long
  // silence. A summary is asked for instead, and arrives as reasoning while
  // the thinking goes on.
  const opus = {
    model: 'claude-opus-5-5',
    max_tokens: 64000,
    thinking: { type: 'adaptive', display: 'summarized' },
  } satisfies AnthropicSettings;

  const threads = createThreads({
    store: sqliteStore(db),
    provider: (request) => claude({ ...request, settings: { anthropic: opus } }),
    // What the model may call. It decides when; the tool's description is what it goes by.
    tools: search ? [webSearch(cloudflareSearch({ fetch, ...search, limit: 5 }))] : [],
    newId: randomUUID,
    emit: broadcastThreads,
  });
  registerThreadsIpc(threads);

  createWindow();

  // On macOS, clicking the dock icon with no window open makes one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('will-quit', () => db.close());
});

// Quit when every window is closed, except on macOS, where an app stays
// running until it is quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
