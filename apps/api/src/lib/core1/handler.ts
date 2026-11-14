/**
 * Common HTTP request handler pipeline for Core 1 route endpoints.
 */

import { NextResponse } from 'next/server';
import { serviceDatabase } from '../database';
import { executeCore1Command } from './service';
import { createSupabaseCore1Repository } from './repository';
import { Core1CommandError } from './errors';
import type { CommandType, Core1ServicePorts, AuthPort } from './types';

export function createDefaultAuthPort(): AuthPort {
  const client = serviceDatabase();
  return {
    getUser: async (token: string) => {
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user) {
        throw new Core1CommandError('unauthorized_invalid_bearer_token', 401);
      }
      return data.user;
    },
  };
}

export function createDefaultCore1Ports(): Core1ServicePorts {
  const client = serviceDatabase();
  return {
    auth: createDefaultAuthPort(),
    repo: createSupabaseCore1Repository(client),
    encryptionKeyHex: process.env.WEBHOOK_ENCRYPTION_KEY,
  };
}

export async function handleCore1ApiRoute(
  request: Request,
  portsOverride?: Core1ServicePorts,
  commandOverride?: CommandType
): Promise<Response> {
  try {
    const ports = portsOverride ?? createDefaultCore1Ports();
    const result = await executeCore1Command(request, ports, commandOverride);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof Core1CommandError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: 'internal_command_error' }, { status: 500 });
  }
}
