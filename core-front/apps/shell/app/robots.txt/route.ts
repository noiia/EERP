import { relaySiteFile } from '@/website/site-file'

export const dynamic = 'force-dynamic'

export function GET(request: Request): Promise<Response> {
  return relaySiteFile(request, 'robots.txt')
}
