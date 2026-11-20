import { relayOAuthMetadata } from '@/lib/oauth-metadata'

export const dynamic = 'force-dynamic'

// RFC 9728 metadata for the MCP endpoint (ADR-043), at the root and at the
// resource-suffixed URL (/.well-known/oauth-protected-resource/api/v1/mcp).
export function GET(): Promise<Response> {
  return relayOAuthMetadata('protected-resource')
}
