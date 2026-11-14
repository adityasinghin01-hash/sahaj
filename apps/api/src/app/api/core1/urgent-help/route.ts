import { NextResponse } from 'next/server';
import {
  createProductionUrgentHelpDeps,
  executeUrgentHelpCommand,
} from '@/lib/core1/urgent-help-service';
import { Core1CommandError } from '@/lib/core1/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const result = await executeUrgentHelpCommand(request, createProductionUrgentHelpDeps());
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    if (error instanceof Core1CommandError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: 'internal_command_error' }, { status: 500 });
  }
}
