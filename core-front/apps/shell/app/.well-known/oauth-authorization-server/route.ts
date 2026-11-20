import { relayOAuthMetadata } from '@/lib/oauth-metadata'

export const dynamic = 'force-dynamic'

// RFC 8414 metadata for MCP clients (ADR-043), served by Go.
export function GET(): Promise<Response> {
  return relayOAuthMetadata('authorization-server')
}
