import { NextResponse } from "next/server";
export async function GET(){return NextResponse.json({service:"mitra",version:"0.1.0",state:"LOCAL_PASS",liveChainClaims:false,timestamp:new Date().toISOString()})}
