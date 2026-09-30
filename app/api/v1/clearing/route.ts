import { NextResponse } from "next/server";
import { obligations } from "@/lib/store/seed";
import { netObligations } from "@/lib/kernel/clearing";
export async function GET(){return NextResponse.json({data:netObligations(obligations),evidenceLevel:"LOCAL_PASS",warning:"Local deterministic calculator; not decentralized clearing."})}
