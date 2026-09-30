"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Activity, Archive, BadgeCheck, Bot, Boxes, CircleDollarSign, Command, FileCheck2, FlaskConical, Gauge, Layers3, Menu, Network, ReceiptText, Search, Settings, ShieldCheck, SlidersHorizontal, Vault, Workflow, X } from "lucide-react";
import { runs } from "@/lib/store/seed";

const nav = [
  ["/overview","Overview",Gauge], ["/runs","Runs",Workflow], ["/vaults","Vaults",Vault], ["/agents","Agents",Bot], ["/policies","Policies",ShieldCheck], ["/commerce","Commerce",Archive],
  ["/obligations","Obligations",CircleDollarSign], ["/recovery","Recovery",Activity], ["/clearing","Clearing",Layers3], ["/settlements","Settlements",ReceiptText],
  ["/integrations","Integrations",Network], ["/evidence","Evidence",FileCheck2], ["/failure-lab","Failure Lab",FlaskConical], ["/settings","Settings",Settings],
] as const;

const searchItems = [
  ...nav.map(([href,label,Icon])=>({href,label,meta:"Console page",Icon})),
  ...runs.map(r=>({href:`/runs/${r.runId}`,label:r.title,meta:`${r.runId} · ${r.status}`,Icon:Workflow})),
  {href:"/vaults/vault_sol_primary",label:"Primary research treasury",meta:"vault_sol_primary",Icon:Vault},
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname(); const router=useRouter(); const [searchOpen,setSearchOpen]=useState(false); const [q,setQ]=useState("");
  useEffect(()=>{const fn=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();setSearchOpen(true)}if(e.key==="Escape")setSearchOpen(false)};window.addEventListener("keydown",fn);return()=>window.removeEventListener("keydown",fn)},[]);
  const results=useMemo(()=>searchItems.filter(x=>(x.label+" "+x.meta).toLowerCase().includes(q.toLowerCase())).slice(0,10),[q]);
  const crumb=pathname.split("/").filter(Boolean).map(s=>s.replaceAll("_"," ")).join(" / ")||"overview";
  return <div className="shell">
    <aside className="sidebar"><div className="brandRow"><Link href="/overview" className="brand">mitra<span className="brandDot">.</span></Link><span className="env">LOCAL</span></div>
      <nav className="nav"><div className="navLabel">Operate</div>{nav.slice(0,6).map(([href,label,Icon])=><Link key={href} href={href} className={`navItem ${pathname.startsWith(href)?"active":""}`}><Icon/>{label}{label==="Runs"&&<span className="navCount">{runs.length}</span>}</Link>)}<div className="navLabel">Financial state</div>{nav.slice(6,10).map(([href,label,Icon])=><Link key={href} href={href} className={`navItem ${pathname.startsWith(href)?"active":""}`}><Icon/>{label}</Link>)}<div className="navLabel">Protocol</div>{nav.slice(10).map(([href,label,Icon])=><Link key={href} href={href} className={`navItem ${pathname.startsWith(href)?"active":""}`}><Icon/>{label}</Link>)}</nav>
      <div className="sidebarBottom"><div className="health"><span className="healthDot"/><div><strong>Local kernel healthy</strong><small>No live chain credentials</small></div></div><button className="workspace"><span className="workspaceAvatar">M</span><span><strong>Mitra Labs</strong><small>Protocol workspace</small></span><SlidersHorizontal size={13}/></button></div>
    </aside>
    <main className="main"><header className="topbar"><div className="crumb">Console / {crumb}</div><div className="topActions"><button className="searchBtn" onClick={()=>setSearchOpen(true)}><Search/><span>Search</span><kbd>⌘K</kbd></button><button className="iconBtn" title="Protocol status"><Activity/></button><Link className="btn" href="/runs">New run</Link></div></header><div className="content">{children}</div></main>
    <nav className="mobileNav">{nav.slice(0,5).map(([href,label,Icon])=><Link key={href} href={href}><Icon/><span>{label}</span></Link>)}</nav>
    {searchOpen&&<div className="searchOverlay" onMouseDown={(e: React.MouseEvent<HTMLDivElement>)=>{if(e.target===e.currentTarget)setSearchOpen(false)}}><div className="searchCard"><div className="searchInput"><Search size={16}/><input autoFocus placeholder="Search runs, vaults, agents, receipts…" value={q} onChange={(e: React.ChangeEvent<HTMLInputElement>)=>setQ(e.target.value)}/><button className="iconBtn" onClick={()=>setSearchOpen(false)}><X/></button></div><div className="searchResults">{results.map(({href,label,meta,Icon})=><button key={href+label} className="searchResult" onClick={()=>{setSearchOpen(false);router.push(href)}}><Icon/><span><strong>{label}</strong><small>{meta}</small></span></button>)}</div></div></div>}
  </div>
}
