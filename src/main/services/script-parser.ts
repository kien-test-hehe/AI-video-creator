import type { ParsedScene } from '../../shared/types';

const HEADING_RE = /^\s*(INT\.?|EXT\.?|INT\.\/EXT\.?|I\/E\.?)\s+(.+?)(?:\s+-\s+(.+))?\s*$/i;

export function parseScreenplay(script: string): ParsedScene[] {
  const lines = script.replace(/\r\n/g, '\n').split('\n');
  const scenes: ParsedScene[] = [];
  let current: ParsedScene | null = null;

  const flush = () => {
    if (!current) return;
    current.body = current.body.trim();
    scenes.push(current);
  };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      flush();
      const prefix = match[1].toUpperCase().replace(/\.$/, '');
      const location = match[2].trim();
      const timeOfDay = match[3]?.trim();
      current = {
        heading: `${prefix}. ${location}${timeOfDay ? ` - ${timeOfDay}` : ''}`,
        location,
        timeOfDay,
        body: ''
      };
      continue;
    }
    if (!current && line.trim()) {
      current = { heading: 'SCENE 1', body: '' };
    }
    if (current) current.body += `${line}\n`;
  }
  flush();

  if (scenes.length === 0 && script.trim()) {
    return [{ heading: 'SCENE 1', body: script.trim() }];
  }
  return scenes;
}
