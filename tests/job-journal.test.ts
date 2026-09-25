import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { JobJournal } from '../src/main/services/job-journal';
import type { RenderJob } from '../src/shared/types';

function job():RenderJob{
  const now=new Date().toISOString();
  return{id:'job-1',shotId:'shot-1',createdAt:now,updatedAt:now,status:'queued',progress:0,message:'Waiting',modelFamily:'ltx-2.5-fast',outputs:[]};
}

describe('signed render journal',()=>{
  it('accepts its own journal and refuses tampered state',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-journal-'));
    const journal=new JobJournal(randomBytes(32));
    await journal.write(root,job());
    expect((await journal.readAll(root)).map(j=>j.id)).toEqual(['job-1']);

    const path=join(root,'.cineforge','jobs','job-1.json');
    const envelope=JSON.parse(await readFile(path,'utf8'));
    envelope.job.status='running';
    await writeFile(path,JSON.stringify(envelope),'utf8');
    expect(await journal.readAll(root)).toEqual([]);
  });

  it('cannot be recovered by a different installation key',async()=>{
    const root=await mkdtemp(join(tmpdir(),'cineforge-journal-key-'));
    const first=new JobJournal(randomBytes(32));
    await first.write(root,job());
    const second=new JobJournal(randomBytes(32));
    expect(await second.readAll(root)).toEqual([]);
  });
});
