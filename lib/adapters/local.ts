import type { MarketplaceAdapter, PaymentAdapter, ProviderCandidate, SettlementAdapter } from "./types";
import { UnconfiguredAdapterError, type EvidenceRequest } from "./types";
import type { EvidenceBundle } from "@/lib/evm/evidence";
import type { Chain } from "@/lib/domain/types";

export class LocalMarketplaceAdapter implements MarketplaceAdapter {
  readonly name="local-marketplace";
  async discover(criteria:{capability:string;maxPrice?:number}):Promise<ProviderCandidate[]>{return [{externalId:"local:provider:research-01",source:"local",name:"Reference Research Provider",capabilities:[criteria.capability],price:{asset:"USDC",amount:12},settlementNetworks:["solana"],paymentMethods:["x402"],reputationRefs:["local:reputation:01"]}]}
  async getAgent(id:string){return (await this.discover({capability:"market_research"})).find(x=>x.externalId===id)??null}
  async createJob(input:{providerId:string;objective:string;agreementId:string}){return {externalJobId:`local-job-${input.agreementId}`,state:"submitted"}}
  async getJob(){return {state:"completed",artifactRefs:["local://artifact/report.json"]}}
  async cancelJob(){return}
}

export class LocalPaymentAdapter implements PaymentAdapter {
  readonly name="local-payment";
  async createBoundedSession(input:{reservationId:string}){return {sessionId:`session-${input.reservationId}`}}
  async charge(input:{sessionId:string;amount:{asset:string;amount:number};resource:string}){return {paymentRef:`local-payment-${input.sessionId}-${input.amount.amount}`,evidenceLevel:"LOCAL_PASS" as const}}
  async close(){return}
}

export class UnconfiguredSettlementAdapter implements SettlementAdapter {
  constructor(readonly chain:Chain){}
  async validateTarget(){return}
  async settle():Promise<never>{throw new UnconfiguredAdapterError(`${this.chain} settlement`)}
  async verify(){return {confirmed:false}}
  /** PRD 21.4 getEvidence. Nothing was ever settled, so nothing can be evidenced. */
  async getEvidence(_req:EvidenceRequest):Promise<EvidenceBundle|null>{return null}
}
