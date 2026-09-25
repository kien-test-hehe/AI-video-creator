import type { ModelFamily, Shot } from './types';

export function chooseModelForShot(shot: Pick<Shot, 'dialogue' | 'generation' | 'camera' | 'action'>): ModelFamily {
  const seconds = shot.generation.frames / Math.max(1, shot.generation.fps);
  if (seconds > 10) return 'ltx-2.5-fast';
  if (shot.dialogue.trim() || shot.generation.includeAudio) return 'ltx-2.5-fast';
  if (shot.generation.quality === 'hero') return 'hunyuan-video-1.5';
  if (/fast|whip|fight|action|tracking|orbit|chase|sprint|explosion/i.test(`${shot.camera} ${shot.action}`)) return 'wan-2.2-5b';
  return 'ltx-2.5-fast';
}
