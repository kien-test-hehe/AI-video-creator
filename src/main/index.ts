import { app, BrowserWindow, net, protocol, session } from 'electron';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpc, shutdownForegroundOperations } from './ipc';
import { AppSettingsService } from './services/app-settings-service';
import { assertExistingPathInside } from './services/path-safety';
import { ProjectService } from './services/project-service';
import { RenderQueueService } from './services/render-queue';
import { lockDownWebContents } from './services/ipc-security';

protocol.registerSchemesAsPrivileged([
  { scheme: 'cineforge-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

let projects: ProjectService;
let queue: RenderQueueService;
let machineSettings: AppSettingsService;
let mainWindow: BrowserWindow | null = null;
let ipcRegistered = false;
let trustedRendererUrl = '';
let shutdownInProgress=false;

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
      webSecurity: true,
      webviewTag: false
    }
  });
  lockDownWebContents(mainWindow.webContents,trustedRendererUrl);
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());

  if(process.env.ELECTRON_RENDERER_URL)void mainWindow.loadURL(trustedRendererUrl);
  else void mainWindow.loadFile(join(__dirname,'../renderer/index.html'));
}

function registerMediaProtocol(): void {
  protocol.handle('cineforge-media', async request => {
    const project = projects.getCurrent();
    if (!project) return new Response('No project open', { status: 404 });
    const url = new URL(request.url);
    if (url.hostname !== 'project') return new Response('Unknown media host', { status: 404 });
    try {
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const realFile = await assertExistingPathInside(resolve(project.rootPath), resolve(project.rootPath, relative), 'media path');
      return await net.fetch(pathToFileURL(realFile).toString());
    } catch {
      return new Response('Media not found or blocked', { status: 404 });
    }
  });
}

app.whenReady().then(async () => {
  trustedRendererUrl=process.env.ELECTRON_RENDERER_URL||pathToFileURL(join(__dirname,'../renderer/index.html')).toString();
  machineSettings = new AppSettingsService(app.getPath('userData'));
  await machineSettings.load();
  projects = new ProjectService();
  queue = new RenderQueueService(projects, machineSettings);

  registerMediaProtocol();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  if (!ipcRegistered) {
    registerIpc(projects, queue, machineSettings,trustedRendererUrl);
    ipcRegistered = true;
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit',event=>{
  if(shutdownInProgress)return;
  shutdownInProgress=true;event.preventDefault();
  void shutdownForegroundOperations().finally(()=>app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
