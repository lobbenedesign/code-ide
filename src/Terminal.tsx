import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  // Root del progetto attualmente aperto in ESPLORA RISORSE — la shell viene
  // avviata lì, non nella cartella di lancio del processo Electron (bug reale
  // corretto insieme a questo: 'terminal.spawn' prima ignorava del tutto cwd).
  cwd: string
}

export default function Terminal({ cwd }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  // La shell va avviata UNA SOLA VOLTA appena 'cwd' è noto (all'inizio può
  // essere '' per una frazione di secondo, prima che App.tsx risolva il
  // progetto di default) — non ad ogni cambio di progetto successivo, altrimenti
  // un comando/processo lungo in corso nel terminale verrebbe ucciso ogni
  // volta che l'utente apre una cartella diversa dalla sidebar.
  const spawnedRef = useRef(false)

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

    // Ridimensiona anche quando cambia solo il pannello terminale (es. drag di
    // uno split) senza che la finestra intera cambi dimensione — il solo
    // listener su 'resize' della finestra non si attivava in quel caso.
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(terminalRef.current)

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

    return () => {
      window.removeEventListener('resize', handleResize)
      resizeObserver.disconnect()
      removeIncomingData()
      removeAgentEcho()
      term.dispose()
    }
  }, [])

  // Avvia la shell solo quando 'cwd' è davvero noto, una volta sola.
  useEffect(() => {
    if (!cwd || spawnedRef.current || !xtermRef.current) return
    spawnedRef.current = true
    const term = xtermRef.current
    // @ts-ignore
    window.ipcRenderer.invoke('terminal.spawn', cwd).then(() => {
      // @ts-ignore
      window.ipcRenderer.send('terminal.resize', term.cols, term.rows)
    })
  }, [cwd])

  return (
    <div className="w-full h-full p-2 bg-[#1e1e1e] border-t border-[#333]">
      <div ref={terminalRef} className="w-full h-full overflow-hidden" />
    </div>
  )
}
