import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { FilmProject, TimelineClip } from '../../shared/types';

interface ProbeInfo { width: number; height: number; fps: number; hasAudio: boolean }

function quoteConcatPath(path: string): string { return `file '${path.replace(/'/g, "'\\''")}'`; }

export async function exportTimeline(project: FilmProject): Promise<string> {
  const clips = [...project.timeline].sort((a, b) => a.track - b.track || a.order - b.order);
  if (clips.length === 0) throw new Error('Timeline is empty. Add rendered shots first.');
  if (new Set(clips.map(c => c.track)).size > 1) throw new Error('Multi-track compositing is not enabled yet; keep the current master cut on one track.');

  const sources = clips.map(clip => {
    const output = project.renderOutputs.find(o => o.id === clip.renderOutputId);
    if (!output || output.mediaType !== 'video') throw new Error(`Timeline clip ${clip.id} does not reference a video output.`);
    return { clip, path: output.path };
  });

  const ffprobe = deriveFfprobe(project.settings.ffmpegPath);
  const first = await probeVideo(ffprobe, sources[0].path);
  const cacheDir = join(project.rootPath, 'cache', `export-${randomUUID()}`);
  const exportDir = join(project.rootPath, 'exports');
  await Promise.all([mkdir(cacheDir, { recursive: true }), mkdir(exportDir, { recursive: true })]);

  const normalized: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const target = join(cacheDir, `${String(i).padStart(4, '0')}.mp4`);
    const info = await probeVideo(ffprobe, sources[i].path);
    await normalizeClip(project.settings.ffmpegPath, sources[i].path, target, sources[i].clip, info, first);
    normalized.push(target);
  }

  const listPath = join(cacheDir, 'concat.txt');
  await writeFile(listPath, normalized.map(quoteConcatPath).join('\n'), 'utf8');
  const safeName = project.name.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const extension = project.settings.outputContainer;
  const outputPath = join(exportDir, `${safeName}-${Date.now()}.${extension}`);

  if (extension === 'webm') {
    await run(project.settings.ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libvpx-vp9', '-crf', '18', '-b:v', '0', '-c:a', 'libopus', '-b:a', '192k', outputPath]);
  } else {
    await run(project.settings.ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outputPath]);
  }
  return outputPath;
}

async function normalizeClip(ffmpeg: string, input: string, output: string, clip: TimelineClip, info: ProbeInfo, master: ProbeInfo): Promise<void> {
  if (clip.trimOutSec != null && clip.trimOutSec <= clip.trimInSec) {
    throw new Error(`Invalid timeline trim: out (${clip.trimOutSec}s) must be greater than in (${clip.trimInSec}s).`);
  }
  if (!Number.isFinite(clip.volume) || clip.volume < 0) throw new Error(`Invalid timeline volume: ${clip.volume}`);
  const args: string[] = ['-y'];
  if (clip.trimInSec > 0) args.push('-ss', String(clip.trimInSec));
  args.push('-i', input);
  const duration = clip.trimOutSec != null ? clip.trimOutSec - clip.trimInSec : undefined;
  if (duration != null && duration > 0) args.push('-t', String(duration));
  if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  const vf = `scale=${master.width}:${master.height}:force_original_aspect_ratio=decrease,pad=${master.width}:${master.height}:(ow-iw)/2:(oh-ih)/2,fps=${master.fps}`;
  args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p');
  if (info.hasAudio) args.push('-af', `volume=${Math.max(0, clip.volume)}`);
  else args.push('-shortest');
  args.push('-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2', output);
  await run(ffmpeg, args);
}

function deriveFfprobe(ffmpegPath: string): string {
  const ext = extname(ffmpegPath);
  const base = ffmpegPath.slice(0, ffmpegPath.length - ext.length);
  if (/ffmpeg$/i.test(base)) return join(dirname(ffmpegPath), `ffprobe${ext}`);
  return 'ffprobe';
}

async function probeVideo(ffprobe: string, input: string): Promise<ProbeInfo> {
  const stdout = await runCapture(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', input]);
  const parsed = JSON.parse(stdout) as { streams?: any[] };
  const video = parsed.streams?.find(s => s.codec_type === 'video');
  if (!video) throw new Error(`No video stream found: ${input}`);
  const rate = String(video.avg_frame_rate || video.r_frame_rate || '24/1').split('/').map(Number);
  const fps = rate[1] ? rate[0] / rate[1] : rate[0] || 24;
  return {
    width: Number(video.width) || 1280,
    height: Number(video.height) || 720,
    fps: Math.max(1, Math.round(fps * 1000) / 1000),
    hasAudio: Boolean(parsed.streams?.some(s => s.codec_type === 'audio'))
  };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-3000)}`)));
  });
}

function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)));
  });
}
