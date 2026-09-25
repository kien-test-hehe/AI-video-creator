import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpc } from './ipc';
import { ProjectService } from './services/project-service';
import { RenderQueueService } from './services/render-queue';

protocol.registerSchemesAsPrivileged([
  { scheme: 'cineforge-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const projects = new ProjectService();
const queue = new RenderQueueService(projects);
let mainWindow: BrowserWindow | null = null;
let ipcRegistered = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#090b10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

function registerMediaProtocol(): void {
  protocol.handle('cineforge-media', async request => {
    const project = projects.getCurrent();
    if (!project) return new Response('No project open', { status: 404 });
    const url = new URL(request.url);
    if (url.hostname !== 'project') return new Response('Unknown media host', { status: 404 });

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const root = resolve(project.rootPath);
    const absolute = resolve(root, relative);
    const insideRoot = absolute === root || absolute.startsWith(`${root}${sep}`);
    if (!insideRoot) return new Response('Blocked path', { status: 403 });

    try {
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(absolute)]);
      const realInsideRoot = realFile === realRoot || realFile.startsWith(`${realRoot}${sep}`);
      if (!realInsideRoot) return new Response('Blocked symlink path', { status: 403 });
      return await net.fetch(pathToFileURL(realFile).toString());
    } catch { return new Response('Media not found', { status: 404 }); }
  });
}

app.whenReady().then(() => {
  registerMediaProtocol();
  if (!ipcRegistered) {
    registerIpc(projects, queue);
    ipcRegistered = true;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
