import { useState, useEffect, useRef } from 'react'
import {
  subscribeDebugLogs,
  getDebugLogHistory,
  clearDebugLogHistory,
  type DebugLogEntry
} from './services/debugLogger'

export default function DebugLogs() {
  const [logs, setLogs] = useState<DebugLogEntry[]>(() => getDebugLogHistory())
  const [filterLevel, setFilterLevel] = useState<'all' | 'info' | 'net' | 'warn' | 'error'>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const logsEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsubscribe = subscribeDebugLogs((newLog) => {
      setLogs(prev => [...prev, newLog])
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoScroll])

  const filteredLogs = logs.filter(log => {
    if (filterLevel !== 'all') {
      if (filterLevel === 'net' && log.level !== 'net') return false
      if (filterLevel === 'warn' && log.level !== 'warn') return false
      if (filterLevel === 'error' && log.level !== 'error') return false
      if (filterLevel === 'info' && log.level !== 'info' && log.level !== 'success') return false
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase()
      const matchMsg = log.message.toLowerCase().includes(q)
      const matchCat = log.category.toLowerCase().includes(q)
      return matchMsg || matchCat
    }
    return true
  })

  const handleCopyAll = async () => {
    const text = filteredLogs.map(l => `[${l.timestamp}] [${l.category}] [${l.level.toUpperCase()}]: ${l.message}`).join('\n')
    await navigator.clipboard.writeText(text || 'Nessun log disponibile.')
    setCopiedAll(true)
    setTimeout(() => setCopiedAll(false), 2000)
  }

  const handleCopySingle = async (log: DebugLogEntry) => {
    const text = `[${log.timestamp}] [${log.category}] [${log.level.toUpperCase()}]: ${log.message}`
    await navigator.clipboard.writeText(text)
    setCopiedId(log.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const handleClear = () => {
    clearDebugLogHistory()
    setLogs([])
  }

  const getCategoryColor = (category: string) => {
    const cat = category.toLowerCase()
    if (cat.includes('duck')) return 'bg-orange-900/40 text-orange-300 border-orange-700/50'
    if (cat.includes('sakana')) return 'bg-teal-900/40 text-teal-300 border-teal-700/50'
    if (cat.includes('net') || cat.includes('rete')) return 'bg-cyan-900/40 text-cyan-300 border-cyan-700/50'
    if (cat.includes('agent') || cat.includes('tool')) return 'bg-green-900/40 text-green-300 border-green-700/50'
    if (cat.includes('ollama') || cat.includes('local')) return 'bg-purple-900/40 text-purple-300 border-purple-700/50'
    return 'bg-blue-900/40 text-blue-300 border-blue-700/50'
  }

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-red-400 bg-red-950/30'
      case 'warn': return 'text-amber-400 bg-amber-950/20'
      case 'net': return 'text-cyan-300'
      case 'success': return 'text-emerald-400'
      default: return 'text-gray-300'
    }
  }

  const getLevelIcon = (level: string) => {
    switch (level) {
      case 'error': return '❌'
      case 'warn': return '⚠️'
      case 'net': return '🌐'
      case 'success': return '✅'
      default: return 'ℹ️'
    }
  }

  return (
    <div className="h-full flex flex-col bg-[#141414] text-xs font-mono text-gray-300 select-text overflow-hidden">
      {/* Toolbar secondaria dei log */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1e1e1e] border-b border-[#2d2d2d] gap-2 shrink-0">
        {/* Filtri */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-gray-400 text-[11px] mr-1">Filtro:</span>
          {(['all', 'info', 'net', 'warn', 'error'] as const).map(f => {
            const labels = { all: 'Tutti', info: 'Info', net: 'Rete', warn: 'Warning', error: 'Errori' }
            const active = filterLevel === f
            return (
              <button
                key={f}
                onClick={() => setFilterLevel(f)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  active 
                    ? 'bg-blue-600 text-white shadow-sm' 
                    : 'bg-[#2a2a2a] text-gray-400 hover:bg-[#333] hover:text-gray-200'
                }`}
              >
                {labels[f]}
              </button>
            )
          })}
          
          <input
            type="text"
            placeholder="Cerca nei log..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="ml-2 px-2 py-0.5 bg-[#141414] border border-[#333] rounded text-gray-200 placeholder-gray-500 text-[11px] outline-none focus:border-blue-500 w-36"
          />
        </div>

        {/* Azioni Toolbar */}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded bg-[#2a2a2a] border-gray-600 text-blue-600 focus:ring-0"
            />
            Auto-scroll
          </label>

          {/* Pulsante Copia Tutto */}
          <button
            onClick={handleCopyAll}
            title="Copia tutti i log visibili negli appunti"
            className={`flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-medium border transition-all ${
              copiedAll 
                ? 'bg-emerald-900/50 border-emerald-500 text-emerald-300' 
                : 'bg-[#2a2a2a] border-[#3a3a3a] text-gray-200 hover:bg-[#333] hover:border-gray-500'
            }`}
          >
            {copiedAll ? (
              <>
                <span>✓</span>
                <span>Copiato!</span>
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                <span>Copia Log</span>
              </>
            )}
          </button>

          {/* Pulsante Pulisci */}
          <button
            onClick={handleClear}
            title="Svuota i log attuali"
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-[#2a2a2a] border border-[#3a3a3a] text-gray-400 hover:text-red-400 hover:bg-[#333] hover:border-red-800 transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            <span>Pulisci</span>
          </button>
        </div>
      </div>

      {/* Lista Log Scrollabile */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 py-8 space-y-2">
            <svg className="w-8 h-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            <p className="text-xs">Nessun log registrato finora.</p>
            <p className="text-[11px] text-gray-600">
              Le azioni del software (chiamate Duck.ai, Sakana AI, Ollama, risposte di rete, challenge) appariranno qui in tempo reale.
            </p>
          </div>
        ) : (
          filteredLogs.map(log => {
            const isCopied = copiedId === log.id
            return (
              <div
                key={log.id}
                className={`group flex items-start gap-2 px-2 py-1 rounded transition-colors border border-transparent hover:border-[#333] hover:bg-[#1a1a1a] ${getLevelColor(log.level)}`}
              >
                {/* Orario */}
                <span className="text-gray-500 text-[11px] shrink-0 select-none pt-0.5">
                  {log.timestamp}
                </span>

                {/* Icona Livello */}
                <span className="shrink-0 select-none pt-0.5 text-xs">
                  {getLevelIcon(log.level)}
                </span>

                {/* Badge Categoria */}
                <span className={`px-1.5 py-0.2 rounded border text-[10px] font-semibold shrink-0 uppercase tracking-wider select-none ${getCategoryColor(log.category)}`}>
                  {log.category}
                </span>

                {/* Testo del messaggio */}
                <span className="flex-1 whitespace-pre-wrap break-all leading-relaxed">
                  {log.message}
                </span>

                {/* Tasto Copia Singola Riga on Hover */}
                <button
                  onClick={() => handleCopySingle(log)}
                  title="Copia questa riga"
                  className={`opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded shrink-0 ${
                    isCopied 
                      ? 'text-emerald-400 bg-emerald-950/50' 
                      : 'text-gray-500 hover:text-gray-200 hover:bg-[#2a2a2a]'
                  }`}
                >
                  {isCopied ? (
                    <span className="text-[10px] font-bold">✓</span>
                  ) : (
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  )}
                </button>
              </div>
            )
          })
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  )
}
