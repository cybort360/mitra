import { Badge, PageHeader } from "@/components/ui";
import { getStore } from "@/lib/store/provider";
import { DataSource } from "@/components/data-source";
export const dynamic = "force-dynamic";
export default async function Integrations(){
  const { repo, backend } = await getStore();
  const integrations = await repo.listIntegrations();
  return <><PageHeader eyebrow="One economic model, many rails" title="Integrations" subtitle="Adapters connect marketplaces, protocols, payment transports and chains without leaking their semantics into the canonical Mitra core."/><DataSource backend={backend}/><div className="cardGrid">{integrations.map(i=><div className="card" key={i.integrationId}><div className="cardTop"><h3>{i.name}</h3><Badge value={i.evidenceLevel}/></div><p>{i.description}</p><div className="stack"><div className="statLine"><span>Category</span><strong>{i.category}</strong></div><div className="statLine"><span>Network</span><strong>{i.network}</strong></div><div className="statLine"><span>Version</span><strong className="mono">{i.version}</strong></div><div className="statLine"><span>Runtime</span><Badge value={i.status}/></div>{i.knownLimitation&&<div className="notice">{i.knownLimitation}</div>}</div></div>)}</div></>}
