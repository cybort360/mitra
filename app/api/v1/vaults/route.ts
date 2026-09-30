import { NextResponse } from "next/server";
import { vaults } from "@/lib/store/seed";
import { reconcileVault } from "@/lib/kernel/vault";
export async function GET(){return NextResponse.json({data:vaults.map(v=>({...v,reconciliation:reconcileVault(v)})),count:vaults.length})}
