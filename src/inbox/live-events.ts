import type { Response } from 'express'

type InboxEvent = {
  type: 'connected' | 'message_created' | 'status_updated' | 'conversation_updated'
  contactId?: string
  clientId?: string
  timestamp: string
}

type Subscriber = {
  id: number
  res: Response
  heartbeat: NodeJS.Timeout
}

const subscribers = new Map<number, Subscriber>()
let nextSubscriberId = 1

export function subscribeInboxEvents(res: Response): () => void {
  const id = nextSubscriberId++
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`)
  }, 25_000)

  subscribers.set(id, { id, res, heartbeat })
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`)

  return () => {
    const sub = subscribers.get(id)
    if (!sub) return
    clearInterval(sub.heartbeat)
    subscribers.delete(id)
  }
}

export function publishInboxEvent(event: InboxEvent) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const sub of subscribers.values()) {
    sub.res.write(payload)
  }
}
