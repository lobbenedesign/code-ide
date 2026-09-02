import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export default function Terminal() {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!terminalRef.current) return

    // Initialize xterm.js
    const term = new XTerm({
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#ffffff',
      },
      fontFamily: "'Fira Code', 'JetBrains Mono', 'Courier New', monospace",
      fontSize: 13,
      cursorBlink: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalRef.current)
    fitAddon.fit()

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    // Handle resize
    const handleResize = () => {
      fitAddon.fit()
      // @ts-ignore
      window.ipcRenderer.send('terminal.resize', term.cols, term.rows)
    }
    window.addEventListener('resize', handleResize)

    // Send keystrokes to the backend
    term.onData((data) => {
      // @ts-ignore
      window.ipcRenderer.send('terminal.keystroke', data)
    })

    // Receive data from backend
    // @ts-ignore
    const removeIncomingData = window.ipcRenderer.on('terminal.incomingData', (_event, data: string) => {
      term.write(data)
    })

    // Echo dei comandi che l'agente esegue in autonomia (canale separato dal pty
    // interattivo: l'agente usa child_process.exec per un risultato pulito, ma
    // il testo viene comunque scritto qui così l'utente lo vede nel terminale reale).
    // @ts-ignore
    const removeAgentEcho = window.ipcRenderer.on('terminal.agentEcho', (_event, text: string) => {
      term.write(text)
    })

    // Spawn the shell
    // @ts-ignore
    window.ipcRenderer.invoke('terminal.spawn').then(() => {
      // @ts-ignore
      window.ipcRenderer.send('terminal.resize', term.cols, term.rows)
    })

    return () => {
      window.removeEventListener('resize', handleResize)
      removeIncomingData()
      removeAgentEcho()
      term.dispose()
    }
  }, [])

  return (
    <div className="w-full h-full p-2 bg-[#1e1e1e] border-t border-[#333]">
      <div ref={terminalRef} className="w-full h-full overflow-hidden" />
    </div>
  )
}
