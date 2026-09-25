import type { PropsWithChildren } from 'react';
import { useAppStore, type ViewId } from '../store';

const NAV: Array<[ViewId, string, string]> = [
  ['studio', 'Studio', '⌘'], ['story', 'Story', '¶'], ['assets', 'Assets', '◇'],
  ['storyboard', 'Storyboard', '▦'], ['shots', 'Shots', '◉'], ['queue', 'Render Queue', '↯'],
  ['timeline', 'Timeline', '≋'], ['finishing', 'CapCut', '✦'], ['dashboard', 'System', '◫'], ['settings', 'Settings', '⚙']
];

export function Shell({ children }: PropsWithChildren) {
  const { project, activeView, setView, error, notice, setError, setNotice, queue } = useAppStore();
  const studioMode=activeView==='studio';
  const switchingBlocked = Boolean(queue.runningJobId || queue.jobs.some(j => ['queued','preparing','uploading','submitted','running','recovering','stalled','downloading'].includes(j.status)));
  const openProject = async () => { try { await useAppStore.getState().persist(); const opened = await window.cineforge.project.open(); if (opened) useAppStore.getState().setProject(opened); } catch(e) { setError(e instanceof Error ? e.message : String(e)); } };
  const newProject = async () => { try { await useAppStore.getState().persist(); const created = await window.cineforge.project.create('Untitled Film'); if (created) useAppStore.getState().setProject(created); } catch(e) { setError(e instanceof Error ? e.message : String(e)); } };
  return <div className={`app-shell ${studioMode?'studio-shell':''}`}>
    <aside className={`sidebar ${studioMode?'compact':''}`}>
      <div className="brand"><div className="brand-mark">CF</div><div><strong>CineForge</strong><span>LOCAL + CAPCUT FILM OS</span></div></div>
      <div className="project-chip"><span className="dot" />{project ? project.name : 'No project open'}</div>
      <nav>{NAV.map(([id, label, icon]) => <button key={id} title={studioMode?label:undefined} className={activeView === id ? 'active' : ''} onClick={() => setView(id)}><span>{icon}</span>{label}</button>)}</nav>
      <div className="sidebar-foot"><span>Local AI · paid wall: Codex + CapCut</span><small>WanGP · ComfyUI Lab · FFmpeg</small></div>
    </aside>
    <main className={`workspace ${activeView==='studio'?'studio-mode':''}`}>
      <header className="topbar">
        <div><span className="eyebrow">PROJECT</span><strong>{project?.story.title || project?.name || 'CineForge Local'}</strong></div>
        <div className="top-actions">
          <button className="ghost" disabled={switchingBlocked} onClick={openProject}>Open</button>
          <button className="primary" disabled={switchingBlocked} onClick={newProject}>New project</button>
        </div>
      </header>
      {(error || notice) && <div className={`banner ${error ? 'error' : 'notice'}`} onClick={() => { setError(undefined); setNotice(undefined); }}>{error || notice}<span>×</span></div>}
      <div className="content">{children}</div>
    </main>
  </div>;
}
