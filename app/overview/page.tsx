import Link from "next/link";
import { PageHeader, Metric, Panel, Badge } from "@/components/ui";
import { getStore } from "@/lib/store/provider";
import { DataSource } from "@/components/data-source";
import { LiveEvents } from "@/components/live-events";
// Clearing epochs have no store yet; the "Current epoch" figure is a reference fixture and is labelled.
import { clearingEpochs } from "@/lib/store/seed";
import { compactMoney, money } from "@/lib/domain/format";

export const dynamic = "force-dynamic";
export default async function Overview(){
  const { repo, backend } = await getStore();
  const [runs, vaults, obligations] = await Promise.all([repo.listRuns(), repo.listVaults(), repo.listObligations()]);
  const total=vaults.reduce((s,v)=>s+v.total,0), available=vaults.reduce((s,v)=>s+v.available,0), reserved=vaults.reduce((s,v)=>s+v.reserved,0);
  const active=runs.filter(r=>!["SETTLED","CONTAINED","FAILED"].includes(r.status));
  return <><PageHeader eyebrow="Economic control plane" title="Overview" subtitle="One operational view across agent authority, bounded capital, commerce, recovery, clearing and settlement." actions={<Link href="/failure-lab" className="btnGhost">Open failure lab</Link>}/><DataSource backend={backend}/>
    <div className="grid4"><Metric label="Controlled capital" value={compactMoney(total)} foot={`Across ${vaults.length} vault boundaries`}/><Metric label="Available to spend" value={compactMoney(available)} foot={total?`${((available/total)*100).toFixed(1)}% of controlled capital`:"No vaults in the store"} progress={total?(available/total)*100:0}/><Metric label="Reserved" value={compactMoney(reserved)} foot="Unavailable to concurrent intents"/><Metric label="Active economic runs" value={String(active.length)} foot={`${runs.filter(r=>r.status==="RECOVERING").length} currently recovering`}/></div>
    <div className="grid2"><Panel title="Active economic runs" meta="intent → settlement"><div className="tableWrap"><table className="table"><thead><tr><th>Run</th><th>Agent</th><th>Capital</th><th>Stage</th><th>Status</th></tr></thead><tbody>{runs.map(r=><tr key={r.runId}><td><Link href={`/runs/${r.runId}`} className="entity"><span className="entityIcon">R</span><span className="entityMeta"><strong>{r.title}</strong><small className="mono">{r.runId}</small></span></Link></td><td className="mono">{r.agentId.replace("agent_","")}</td><td className="mono">{money(r.reserved)}</td><td>{r.currentStage}</td><td><Badge value={r.status}/></td></tr>)}</tbody></table></div></Panel>
      <Panel title="Capital state" meta="authoritative vault view"><div className="panelBody"><div className="stack"><div className="statLine"><span>Total</span><strong className="mono">{money(total)}</strong></div><div className="statLine"><span>Available</span><strong className="mono positive">{money(available)}</strong></div><div className="statLine"><span>Reserved</span><strong className="mono">{money(reserved)}</strong></div><div className="statLine"><span>Escrowed</span><strong className="mono">{money(vaults.reduce((s,v)=>s+v.escrowed,0))}</strong></div><div className="statLine"><span>Settling</span><strong className="mono">{money(vaults.reduce((s,v)=>s+v.settling,0))}</strong></div></div><div className="divider"/><div className="notice">Available capital is the spendable number. Total balance is never presented as equivalent to authorization.</div></div></Panel></div>
    <div className="grid2Equal"><Panel title="Live economic activity" meta="streamed from the event log"><LiveEvents limit={12}/></Panel><Panel title="Clearing & exposure" meta="net before settlement"><div className="panelBody"><div className="grid3"><div><div className="metricLabel">Payables</div><div className="metricValue" style={{fontSize:19}}>{money(obligations.filter(o=>!["SETTLED"].includes(o.status)).reduce((s,o)=>s+o.amount.amount,0))}</div></div><div><div className="metricLabel">Current epoch (fixture)</div><div className="metricValue mono" style={{fontSize:17}}>{clearingEpochs[0].epochId}</div></div><div><div className="metricLabel">Projected residual</div><div className="metricValue" style={{fontSize:19}}>{money(clearingEpochs[0].netResidual)}</div></div></div><div className="divider"/><Link href="/clearing" className="btnGhost" style={{display:"inline-flex",alignItems:"center"}}>Inspect clearing →</Link></div></Panel></div>
  </>;
}
