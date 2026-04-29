import { ClientConfig } from '../utils/types'

const DAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

export function isWithinWorkingHours(config: ClientConfig): boolean {
  // Get current time in client's timezone
  const now = new Date()
  const clientTime = new Date(
    now.toLocaleString('en-US', { timeZone: config.timezone })
  )

  const dayName = clientTime.toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: config.timezone,
  })

  // Check day
  if (!config.working_days.includes(dayName)) return false

  // Check time window
  const [startH, startM] = config.working_hours_start.split(':').map(Number)
  const [endH, endM] = config.working_hours_end.split(':').map(Number)
  const currentMinutes = clientTime.getHours() * 60 + clientTime.getMinutes()
  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM

  return currentMinutes >= startMinutes && currentMinutes < endMinutes
}

// Returns how many ms until the next working window opens
export function msUntilNextWorkingWindow(config: ClientConfig): number {
  const now = new Date()
  let candidate = new Date(now)

  // Try up to 14 days ahead
  for (let i = 0; i < 14 * 24 * 60; i++) {
    candidate = new Date(candidate.getTime() + 60_000) // +1 minute
    const clientTime = new Date(
      candidate.toLocaleString('en-US', { timeZone: config.timezone })
    )
    const dayName = clientTime.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: config.timezone,
    })
    if (!config.working_days.includes(dayName)) continue
    const [startH, startM] = config.working_hours_start.split(':').map(Number)
    const startMinutes = startH * 60 + startM
    const currentMinutes = clientTime.getHours() * 60 + clientTime.getMinutes()
    if (currentMinutes === startMinutes) {
      return candidate.getTime() - now.getTime()
    }
  }
  return 24 * 60 * 60 * 1000 // fallback: 24h
}
