"use client";
import { useState } from "react";
import { AlertTriangle, Play, ShieldCheck } from "lucide-react";
import { failureScenarios, type FailureScenario } from "@/lib/kernel/failure-lab";
import { Badge } from "./ui";

export function FailureLabClient(){
  const [results,setResults]=useState<Record<string,string>>({});
  const run=(key:FailureScenario)=>{setResults(r=>({...r,[key]:failureScenarios[key].reasonCode}))};
  return <div className="panel"><div className="panelHead"><div className="panelTitle">Adversarial scenarios</div><div className="panelMeta">safe local simulation</div></div>{(Object.entries(failureScenarios) as [FailureScenario,(typeof failureScenarios)[FailureScenario]][]).map(([key,s])=><div className="failureCard" key={key}><div className="failureIcon"><AlertTriangle/></div><div><strong>{s.title}</strong><p>{s.expected}</p>{results[key]&&<div style={{marginTop:6}}><Badge value="FAILED"/> <span className="mono" style={{fontSize:9,marginLeft:5}}>{results[key]}</span></div>}</div><button className="btnGhost" onClick={()=>run(key)}><Play size={12} style={{verticalAlign:"-2px",marginRight:5}}/>Run</button></div>)}</div>
}
