import { requireAuth } from '@/lib/session'
import { checkAuthorization } from '@/lib/mcp-oauth'
import OAuthConsent from '@/components/OAuthConsent'

// The OAuth authorization endpoint MCP clients send the user to (ADR-043): a
// signed-out user goes through the normal ERP login (any method) and comes
// back here, then approves or denies the app. Go validates the request.
export default async function OAuthAuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params: Record<string, string> = {}
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === 'string') params[k] = v
  await requireAuth(`/oauth/authorize?${new URLSearchParams(params)}`)
  return <OAuthConsent check={await checkAuthorization(params)} params={params} />
}
