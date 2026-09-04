export interface DebugLogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'net' | 'success'
  category: string
  message: string
  details?: any
}

type LogListener = (log: DebugLogEntry) => void

const listeners: Set<LogListener> = new Set()
const logHistory: DebugLogEntry[] = []
const MAX_HISTORY = 500

export function subscribeDebugLogs(listener: LogListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getDebugLogHistory(): DebugLogEntry[] {
  return [...logHistory]
}

export function clearDebugLogHistory() {
  logHistory.length = 0
}

export function addDebugLog(
  level: 'info' | 'warn' | 'error' | 'net' | 'success',
  category: string,
  message: string,
  details?: any
) {
  const entry: DebugLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toLocaleTimeString(),
    level,
    category,
    message,
    details
  }

  logHistory.push(entry)
  if (logHistory.length > MAX_HISTORY) {
    logHistory.shift()
  }

  listeners.forEach(fn => {
    try {
      fn(entry)
    } catch (e) {
      console.error('Error in debug log listener:', e)
    }
  })
}

// Inizializza l'ascolto IPC dal processo principale
if (typeof window !== 'undefined' && (window as any).ipcRenderer) {
  (window as any).ipcRenderer.on('app-debug-log', (_event: any, log: DebugLogEntry) => {
    if (log && log.message) {
      logHistory.push(log)
      if (logHistory.length > MAX_HISTORY) {
        logHistory.shift()
      }
      listeners.forEach(fn => {
        try {
          fn(log)
        } catch (e) {
          console.error('Error in debug log listener:', e)
        }
      })
    }
  })
}
