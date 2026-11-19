import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const channel = 'eerp-office-diagrams-v1'
interface Request {
  id: string
  sender: Window
  initial: unknown
  editing: boolean
}
export function isDiagramSender(
  event: MessageEvent,
  editor: HTMLIFrameElement | null,
): event is MessageEvent & { source: Window } {
  if (!editor || event.origin !== window.location.origin || !event.source) return false
  try {
    const source = event.source as Window
    // Same origin alone is insufficient: the sender must be the plugin frame
    // belonging to this particular editor, never another tab or Office dialog.
    return (
      source.frameElement?.ownerDocument === editor.contentDocument &&
      source.location.pathname.endsWith('/sdkjs-plugins/erp-diagrams/index.html')
    )
  } catch {
    return false
  }
}

export function useDiagramBridge(
  host: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  sessionKey: string,
) {
  const [request, setRequest] = useState<Request | null>(null)
  const current = useRef<Request | null>(null)
  const pending = useRef<{ resolve(): void; reject(e: Error): void } | null>(null)
  useEffect(() => {
    setRequest(null)
    if (!enabled) return
    const receive = (event: MessageEvent) => {
      const msg = event.data
      if (
        !msg ||
        msg.channel !== channel ||
        typeof msg.requestId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(msg.requestId) ||
        !isDiagramSender(event, host.current?.querySelector('iframe') ?? null)
      )
        return
      const req = current.current
      if (msg.type === 'open') {
        if (req) return
        current.current = {
          id: msg.requestId,
          sender: event.source,
          initial: msg.data,
          editing: msg.editing === true,
        }
        setRequest(current.current)
        event.source.postMessage(
          { channel, type: 'ready', requestId: msg.requestId },
          window.location.origin,
        )
      } else if (req && req.id === msg.requestId && req.sender === event.source) {
        if (msg.type === 'inserted' || msg.type === 'cancel') {
          if (msg.type === 'inserted') pending.current?.resolve()
          else pending.current?.reject(new Error('Cancelled'))
          current.current = null
          setRequest(null)
        }
      }
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      const req = current.current
      req?.sender.postMessage(
        { channel, type: 'cancel', requestId: req.id },
        window.location.origin,
      )
      current.current = null
      pending.current?.reject(new Error('Editor closed'))
    }
  }, [enabled, host, sessionKey])
  const close = useCallback(() => {
    const req = current.current
    req?.sender.postMessage({ channel, type: 'cancel', requestId: req.id }, window.location.origin)
    current.current = null
    pending.current?.reject(new Error('Cancelled'))
    setRequest(null)
  }, [])
  const insert = async (value: { image: string; width: number; height: number; data: string }) => {
    const req = current.current
    if (!enabled || !req || pending.current) throw new Error('Editor unavailable')
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Insertion timed out')), 30000)
        pending.current = {
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        }
        req.sender.postMessage(
          { channel, type: 'insert', requestId: req.id, ...value },
          window.location.origin,
        )
      })
    } finally {
      pending.current = null
    }
  }
  return { request, close, insert }
}
