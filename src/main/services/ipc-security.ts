import type { IpcMainInvokeEvent, WebContents } from 'electron';

export function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!frame) throw new Error('Blocked IPC call without a sender frame.');
  const actual = new URL(frame.url);
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev) {
    const expected = new URL(dev);
    if (actual.origin !== expected.origin) throw new Error(`Blocked IPC sender origin: ${actual.origin}`);
    return;
  }
  if (actual.protocol !== 'file:') throw new Error(`Blocked non-file IPC sender: ${actual.href}`);
}

export function isTrustedRendererNavigation(url: string): boolean {
  const actual = new URL(url);
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev) return actual.origin === new URL(dev).origin;
  return actual.protocol === 'file:';
}

export function lockDownWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererNavigation(url)) event.preventDefault();
  });
}
