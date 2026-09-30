"use client";
import { useState } from "react";
import { X } from "lucide-react";
import type { RunEvent } from "@/lib/domain/types";
import { KV } from "./ui";

export function RunTimeline({ events }: { events: RunEvent[] }) {
  const [selected,setSelected]=useState<RunEvent|null>(null);
  return <>
    <div className="timeline">{events.map(e=><div className="event" key={e.eventId} onClick={()=>setSelected(e)}><div className="eventTime">{new Date(e.at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:e.at.includes(":00Z")?undefined:"2-digit"})}</div><span className={`eventDot ${e.status}`}/><div className="eventBody"><strong>{e.title}</strong><p>{e.description}</p></div></div>)}</div>
    {selected&&<><div className="drawerBackdrop" onClick={()=>setSelected(null)}/><aside className="drawer"><div className="drawerHead"><div><div className="eyebrow">{selected.kind}</div><h2>{selected.title}</h2></div><button className="iconBtn" onClick={()=>setSelected(null)}><X/></button></div><div className="drawerBody"><p className="sub" style={{marginTop:0}}>{selected.description}</p><div className="divider"/><KV label="Event ID"><span className="mono">{selected.eventId}</span></KV><KV label="Object"><span className="mono">{selected.objectRef??"—"}</span></KV><KV label="Receipt"><span className="mono">{selected.receiptId??"—"}</span></KV><KV label="Timestamp"><span className="mono">{selected.at}</span></KV><div className="divider"/><div className="eyebrow">Canonical metadata</div>{Object.entries(selected.metadata).map(([k,v])=><KV key={k} label={k}><span className={typeof v==="number"?"mono":""}>{String(v)}</span></KV>)}</div></aside></>}
  </>;
}
