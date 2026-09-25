import type { PropsWithChildren, ReactNode } from 'react';
export function Page({title,subtitle,actions,children}:PropsWithChildren<{title:string;subtitle?:string;actions?:ReactNode}>){return <section className="page"><div className="page-head"><div><h1>{title}</h1>{subtitle&&<p>{subtitle}</p>}</div>{actions&&<div className="page-actions">{actions}</div>}</div>{children}</section>;}
export function Card({title,kicker,actions,children,className=''}:PropsWithChildren<{title?:string;kicker?:string;actions?:ReactNode;className?:string}>){return <div className={`card ${className}`}><div className="card-head">{(title||kicker)&&<div>{kicker&&<span className="eyebrow">{kicker}</span>}{title&&<h3>{title}</h3>}</div>}{actions}</div>{children}</div>;}
export function Empty({children}:PropsWithChildren){return <div className="empty">{children}</div>;}
export function Pill({children}:PropsWithChildren){return <span className="pill">{children}</span>;}
