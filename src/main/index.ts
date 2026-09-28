import { app, BrowserWindow, dialog, net, protocol, session } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpc, shutdownForegroundOperations } from './ipc';
import { AppSettingsService } from './services/app-settings-service';
import { assertExistingProjectMediaPath } from './services/path-safety';
import { ProjectService } from './services/project-service';
import { RenderQueueService } from './services/render-queue';
import { lockDownWebContents, resolveTrustedRendererUrl } from './services/ipc-security';
import { KeyframeLeaseStore, recoverOrphanedKeyframeLease } from './services/keyframe-lease';
import { RenderLeaseStore } from './services/render-lease';
import { ProductionRuntimeService } from './services/production-runtime-service';

protocol.registerSchemesAsPrivileged([
  { scheme: 'cineforge-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

let projects: ProjectService;
let queue: RenderQueueService;
let machineSettings: AppSettingsService;
let keyframeLeases:KeyframeLeaseStore;
let renderLeases:RenderLeaseStore;
let automation:ProductionRuntimeService;
let mainWindow: BrowserWindow | null = null;
let ipcRegistered = false;
let trustedRendererUrl = '';
let shutdownInProgress=false;
const ownsSingleInstanceLock=app.requestSingleInstanceLock();
if(!ownsSingleInstanceLock)app.quit();

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

  if(new URL(trustedRendererUrl).protocol==='file:')void mainWindow.loadFile(join(__dirname,'../renderer/index.html'));
  else void mainWindow.loadURL(trustedRendererUrl);
}

function registerMediaProtocol(): void {
  protocol.handle('cineforge-media', async request => {
    const project = projects.getCurrent();
    if (!project) return new Response('No project open', { status: 404 });
    const url = new URL(request.url);
    if (url.hostname !== 'project') return new Response('Unknown media host', { status: 404 });
    try {
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const realFile = await assertExistingProjectMediaPath(project.rootPath,relative);
      return await net.fetch(pathToFileURL(realFile).toString());
    } catch {
      return new Response('Media not found or blocked', { status: 404 });
    }
  });
}

if(ownsSingleInstanceLock)app.whenReady().then(async () => {
  trustedRendererUrl=resolveTrustedRendererUrl(app.isPackaged,process.env.ELECTRON_RENDERER_URL,pathToFileURL(join(__dirname,'../renderer/index.html')).toString());
  machineSettings = new AppSettingsService(app.getPath('userData'));
  await machineSettings.load();
  keyframeLeases=new KeyframeLeaseStore(app.getPath('userData'),machineSettings.getJournalKey());
  try{await recoverOrphanedKeyframeLease(keyframeLeases,machineSettings.get());}
  catch(error){
    dialog.showErrorBox('CineForge GPU recovery blocked',error instanceof Error?error.message:String(error));
    app.quit();return;
  }
  renderLeases=new RenderLeaseStore(app.getPath('userData'),machineSettings.getJournalKey());
  projects = new ProjectService();
  queue = new RenderQueueService(projects, machineSettings,renderLeases);
  automation = new ProductionRuntimeService(projects,queue,machineSettings);
  const activeRenderLease=await renderLeases.read();
  if(activeRenderLease){
    const recoveredProject=await projects.openAt(activeRenderLease.projectRoot);
    if(recoveredProject.id!==activeRenderLease.projectId)throw new Error('Active render recovery lease does not match the project stored at its recorded path.');
    if(!recoveredProject.renderJobs.some(job=>job.id===activeRenderLease.jobId))throw new Error(`Active render recovery lease references missing project job ${activeRenderLease.jobId}. Stop the prior backend work before clearing the lease.`);
    await queue.reconcileAfterProjectOpen();
  }

  registerMediaProtocol();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  if (!ipcRegistered) {
    registerIpc(projects, queue, machineSettings,keyframeLeases,automation,trustedRendererUrl);
    ipcRegistered = true;
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error=>{
  dialog.showErrorBox('CineForge startup blocked',error instanceof Error?error.message:String(error));
  app.quit();
});
if(ownsSingleInstanceLock)app.on('second-instance',()=>{
  if(!mainWindow||mainWindow.isDestroyed())return;
  if(mainWindow.isMinimized())mainWindow.restore();
  mainWindow.show();mainWindow.focus();
});

app.on('before-quit',event=>{
  if(shutdownInProgress)return;
  shutdownInProgress=true;event.preventDefault();
  void shutdownForegroundOperations().finally(()=>app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
