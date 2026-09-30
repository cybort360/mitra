import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { titleCase } from "@/lib/domain/format";

export function Badge({ value }: { value: string }) {
  const normalized = value.toUpperCase();
  let cls = "bNeutral";
  if (["ACTIVE","ALLOW","ACCEPTED","CONFIRMED","SETTLED","RECOVERED","HEALTHY","SUCCESS","LOCAL_PASS","TESTNET_PASS","LIVE_PUBLIC_PASS","PRODUCTION_PASS"].includes(normalized)) cls="bGreen";
  else if (["RUNNING","OPEN","FUNDED","EXECUTING","SUBMITTED","CLEARING","SETTLING","REGISTERED"].includes(normalized)) cls="bBlue";
  else if (["RECOVERING","WAITING","REVIEW","RECOVERY_PENDING","CHALLENGE","DEGRADED"].includes(normalized)) cls="bAmber";
  else if (["FAILED","DENY","REJECTED","DISPUTED","DEFAULTED","REVOKED","BLOCKED","CONTAINED"].includes(normalized)) cls="bRed";
  else if (["DESIGN_ONLY","NOT_CONFIGURED"].includes(normalized)) cls="bViolet";
  return <span className={`badge ${cls}`}>{titleCase(value)}</span>;
}

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: string; subtitle?: string; actions?: ReactNode }) {
  return <div className="pageHead"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{subtitle && <p className="sub">{subtitle}</p>}</div>{actions && <div className="actions">{actions}</div>}</div>;
}

export function Metric({ label, value, foot, progress }: { label: string; value: string; foot?: string; progress?: number }) {
  return <div className="metric"><div className="metricLabel">{label}</div><div className="metricValue">{value}</div>{foot && <div className="metricFoot">{foot}</div>}{typeof progress === "number" && <div className="bar"><span style={{width:`${Math.max(0,Math.min(100,progress))}%`}} /></div>}</div>;
}

export function Panel({ title, meta, children, className="" }: { title?: ReactNode; meta?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{title && <div className="panelHead"><div className="panelTitle">{title}</div>{meta && <div className="panelMeta">{meta}</div>}</div>}{children}</section>;
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) { return <Link href={href} className="backLink"><ArrowLeft/> {children}</Link>; }

export function KV({ label, children }: { label: string; children: ReactNode }) { return <div className="kv"><label>{label}</label><div>{children}</div></div>; }
