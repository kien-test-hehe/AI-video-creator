import type { ComfyClient } from './comfy-client';

export async function waitForComfyCompletion(
  client: ComfyClient,
  promptId: string,
  options: { intervalMs?: number; cancelled?: () => boolean; onTick?: (elapsedSec: number) => void | Promise<void> } = {}
): Promise<any> {
  const started = Date.now();
  const interval = options.intervalMs ?? 1500;
  while (true) {
    if (options.cancelled?.()) throw new Error('Job cancelled.');
    const history = await client.history(promptId);
    if (history) {
      if (history.status?.status_str === 'error') throw new Error(`ComfyUI execution failed: ${JSON.stringify(history.status)}`);
      if (history.outputs && Object.keys(history.outputs).length > 0) return history;
      if (history.status?.completed) return history;
    }
    const elapsed = Math.floor((Date.now() - started) / 1000);
    await options.onTick?.(elapsed);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
