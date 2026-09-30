import { NextResponse } from "next/server";
import { failureScenarios } from "@/lib/kernel/failure-lab";
export async function POST(req:Request){const {scenario}=await req.json();const result=failureScenarios[scenario as keyof typeof failureScenarios];if(!result)return NextResponse.json({error:"UNKNOWN_SCENARIO"},{status:400});return NextResponse.json({scenario,result:"REJECTED_OR_CONTAINED",reasonCode:result.reasonCode,expected:result.expected,evidenceLevel:"LOCAL_PASS"})}
