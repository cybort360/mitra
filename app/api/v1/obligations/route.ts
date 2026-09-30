import { NextResponse } from "next/server";
import { obligations } from "@/lib/store/seed";
export async function GET(){return NextResponse.json({data:obligations,count:obligations.length})}
