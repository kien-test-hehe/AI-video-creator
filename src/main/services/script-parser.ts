import type { ParsedScene } from '../../shared/types';

const HEADING_RE = /^\s*(INT\.?|EXT\.?|INT\.\/EXT\.?|I\/E\.?)\s+(.+?)(?:\s+-\s+(.+))?\s*$/i;
const MAX_SCRIPT_CHARS=2_000_000,MAX_SCENES=10_000,MAX_SCENE_BODY_CHARS=500_000,MAX_HEADING_CHARS=2000,MAX_TIME_OF_DAY_CHARS=500;

export function parseScreenplay(script: string): ParsedScene[] {
  if(script.length>MAX_SCRIPT_CHARS)throw new Error(`Screenplay exceeds the ${MAX_SCRIPT_CHARS}-character project safety limit.`);
  const lines = script.replace(/\r\n/g, '\n').split('\n');
  const scenes: ParsedScene[] = [];
  let current: ParsedScene | null = null;

  const flush = () => {
    if (!current) return;
    current.body = current.body.trim();
    if(current.body.length>MAX_SCENE_BODY_CHARS)throw new Error(`Scene body exceeds the ${MAX_SCENE_BODY_CHARS}-character project safety limit.`);
    if(current.heading.length>MAX_HEADING_CHARS)throw new Error(`Scene heading exceeds the ${MAX_HEADING_CHARS}-character project safety limit.`);
    if((current.location?.length??0)>MAX_HEADING_CHARS)throw new Error(`Scene location exceeds the ${MAX_HEADING_CHARS}-character project safety limit.`);
    if((current.timeOfDay?.length??0)>MAX_TIME_OF_DAY_CHARS)throw new Error(`Scene time-of-day exceeds the ${MAX_TIME_OF_DAY_CHARS}-character project safety limit.`);
    if(scenes.length>=MAX_SCENES)throw new Error(`Screenplay produces more than the ${MAX_SCENES}-scene project safety limit.`);
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
