import { exec, spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'

const execAsync = promisify(exec)

// Blocklist di sicurezza (ispirata a omnios-pilot): l'harness può eseguire comandi
// in piena autonomia, anche innescato da un messaggio Telegram/WhatsApp senza
// conferma umana — questi pattern sono rifiutati SEMPRE, indipendentemente dal
// contesto, perché sono distruttivi/irreversibili e non c'è mai un buon motivo
// per farli eseguire a un agente non supervisionato.
// Target di 'rm' considerati sempre distruttivi indipendentemente dalla cwd
// (path assoluti/home/wildcard root) — un path relativo come 'build/' o
// 'node_modules' NON è mai in questa lista, per evitare falsi positivi su usi
// legittimissimi di 'rm -rf' durante lo sviluppo.
const DANGEROUS_RM_TARGETS = new Set(['/', '~', '~/', '$HOME', '${HOME}', '/*', '~/*'])

const SIMPLE_DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: 'formattazione di un filesystem (mkfs)' },
  { pattern: /\bdd\s+.*of=\/dev\//i, reason: 'scrittura diretta su un device a blocchi (dd of=/dev/...)' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: /\bdiskutil\s+(erase|reformat|zeroDisk)/i, reason: 'cancellazione/riformattazione disco (diskutil)' },
  { pattern: />\s*\/dev\/sd[a-z]\b/i, reason: 'scrittura diretta su un device a blocchi' },
  // sudo: un agente non supervisionato (anche innescato da Telegram/WhatsApp senza
  // conferma umana) non ha mai un buon motivo per elevare i propri privilegi —
  // qualsiasi comando che ne ha davvero bisogno va eseguito manualmente dall'utente.
  // Richiede che 'sudo' sia un token a sé stante (comando eseguito), non una
  // sottostringa di un nome più lungo come il pacchetto npm 'sudo-prompt'.
  { pattern: /(^|[\s;&|(])sudo(\s|$)/i, reason: 'tentativo di escalation di privilegi (sudo)' },
]

function findDangerousRmTarget(command: string): string | null {
  // Tokenizzazione semplice per spazi: sufficiente per individuare i casi reali
  // (comandi con quoting complesso non sono il bersaglio di questo controllo).
  const tokens = command.trim().split(/\s+/)
  const rmIdx = tokens.findIndex(t => t === 'rm' || t.endsWith('/rm'))
  if (rmIdx === -1) return null

  const rest = tokens.slice(rmIdx + 1)
  const flagTokens = rest.filter(t => t.startsWith('-'))
  // Un singolo flag combinato (-rf, -fr, -Rf...) o due flag separati (-r -f, --recursive --force, ecc.)
  const isCombinedFlag = (t: string) => /^-[a-z]*[rR][a-z]*f[a-z]*$/.test(t) || /^-[a-z]*f[a-z]*[rR][a-z]*$/.test(t)
  const hasRecursive = flagTokens.some(t => isCombinedFlag(t) || t === '-r' || t === '-R' || t === '--recursive')
  const hasForce = flagTokens.some(t => isCombinedFlag(t) || t === '-f' || t === '--force')
  if (!hasRecursive || !hasForce) return null

  const targets = rest.filter(t => !t.startsWith('-'))
  const dangerousTarget = targets.find(t => DANGEROUS_RM_TARGETS.has(t.replace(/['"]/g, '')))
  return dangerousTarget ? `rm ricorsivo/forzato su '${dangerousTarget}'` : null
}

function findDangerousMatch(command: string): string | null {
  const rmTarget = findDangerousRmTarget(command)
  if (rmTarget) return rmTarget

  for (const { pattern, reason } of SIMPLE_DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return reason
  }
  return null
}

export const TerminalToolDefinition = {
  type: "function",
  function: {
    name: "run_terminal_command",
    description: "Esegue un comando shell nel terminale dell'utente e ne restituisce l'output, ATTENDENDO che finisca (max 30s). Usalo per comandi che terminano da soli: installare dipendenze (npm install), eseguire test, compilare. NON usarlo per processi che restano in esecuzione (dev server, watcher, ecc.) — per quelli usa 'run_background_command', altrimenti questo tool scadrà sempre dopo 30s riportando un fallimento anche se il processo in realtà funziona.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Il comando bash o cmd da eseguire."
        }
      },
      required: ["command"]
    }
  }
}

// Il comando dell'agente gira su un processo separato (child_process.exec, non il
// pty interattivo collegato al terminale visibile) per poter catturare in modo
// pulito stdout/stderr/exit-code come risultato del tool. Per farlo comunque
// VEDERE nel terminale reale (non solo nella chat), lo "echiamo" per iscritto
// nel pannello xterm tramite l'evento 'terminal.agentEcho', distinto visivamente
// da un prompt colorato — non è instradato come input della sessione interattiva.
function echoToTerminal(mainWindow: BrowserWindow | null | undefined, text: string) {
  mainWindow?.webContents.send('terminal.agentEcho', text)
}

export async function executeTerminalCommand(args: any, cwd: string, mainWindow?: BrowserWindow | null): Promise<string> {
  if (process.env.AGENT_TERMINAL_DISABLED === 'true') {
    return "🚫 Esecuzione comandi da parte dell'agente disabilitata (AGENT_TERMINAL_DISABLED=true nel .env). Rimuovi la variabile per riabilitarla."
  }

  const dangerReason = findDangerousMatch(args.command)
  if (dangerReason) {
    echoToTerminal(mainWindow, `\r\n\x1b[41m\x1b[97m 🤖 AGENTE (bloccato) \x1b[0m \x1b[91m${args.command}\x1b[0m\r\n`)
    return `🚫 Comando bloccato per sicurezza: rilevato pattern distruttivo/irreversibile (${dangerReason}). L'agente non esegue mai questo tipo di comando in autonomia, nemmeno se richiesto esplicitamente — va eseguito manualmente dall'utente se davvero necessario.`
  }

  echoToTerminal(mainWindow, `\r\n\x1b[44m\x1b[97m 🤖 AGENTE \x1b[0m \x1b[96m${args.command}\x1b[0m\r\n`)

  try {
    const { stdout, stderr } = await execAsync(args.command, { cwd, timeout: 30000 })

    echoToTerminal(mainWindow, (stdout || stderr || '').split('\n').join('\r\n'))

    if (stderr && stderr.trim().length > 0 && stdout.trim().length === 0) {
      return `⚠️ Comando eseguito con avvisi/errori nello stderr:\n${stderr.substring(0, 2000)}`
    }

    return `✅ Comando eseguito con successo. Output:\n${stdout.substring(0, 2000)}`
  } catch (error: any) {
    echoToTerminal(mainWindow, `\x1b[91m${(error.stderr || error.message || '').split('\n').join('\r\n')}\x1b[0m`)
    return `❌ Comando fallito (Exit Code ${error.code}):\n${error.message}\nStderr:\n${error.stderr?.substring(0, 1000)}`
  }
}

// --- Processi in background: run_terminal_command con timeout fisso di 30s
// falliva sempre su qualunque processo long-running (dev server, watcher, ecc.)
// perché non termina mai da solo — bloccava l'intero loop dell'agente in attesa
// di qualcosa che non sarebbe mai arrivato. Questi tool spawnano un processo
// DISTACCATO dal ciclo di vita della singola chiamata, con un jobId che
// l'agente può interrogare/fermare in iterazioni successive.

interface BackgroundJob {
  id: string
  command: string
  cwd: string
  process: ChildProcess
  output: string
  status: 'running' | 'exited'
  exitCode: number | null
  startedAt: number
}

const MAX_JOB_OUTPUT_CHARS = 8000
const backgroundJobs = new Map<string, BackgroundJob>()

function appendJobOutput(job: BackgroundJob, chunk: string) {
  const next = job.output + chunk
  job.output = next.length > MAX_JOB_OUTPUT_CHARS ? next.slice(next.length - MAX_JOB_OUTPUT_CHARS) : next
}

export const RunBackgroundCommandToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'run_background_command',
    description: "Avvia un comando shell IN BACKGROUND senza attendere che finisca — usalo per processi long-running che restano in esecuzione (dev server, watch mode, server locali). Ritorna subito un 'jobId'. Usa 'check_background_command' per leggerne l'output più tardi e 'stop_background_command' per fermarlo quando hai finito di verificarlo (i processi in background NON si fermano da soli quando il task finisce).",
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Il comando bash da eseguire in background.' }
      },
      required: ['command']
    }
  }
}

export const CheckBackgroundCommandToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'check_background_command',
    description: "Controlla lo stato e legge l'output più recente di un processo avviato con 'run_background_command'. Se jobId è omesso, elenca tutti i job attivi/terminati di questa sessione.",
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'ID del job da controllare (restituito da run_background_command). Omettilo per vedere tutti i job.' }
      }
    }
  }
}

export const StopBackgroundCommandToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'stop_background_command',
    description: "Termina (SIGTERM, poi SIGKILL se non risponde) un processo avviato con 'run_background_command'. Usalo sempre quando hai finito di testare un dev server/processo che hai avviato tu, altrimenti resterebbe in esecuzione indefinitamente sulla macchina dell'utente.",
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'ID del job da fermare.' }
      },
      required: ['jobId']
    }
  }
}

export async function executeRunBackgroundCommand(args: { command: string }, cwd: string, mainWindow?: BrowserWindow | null): Promise<string> {
  if (process.env.AGENT_TERMINAL_DISABLED === 'true') {
    return "🚫 Esecuzione comandi da parte dell'agente disabilitata (AGENT_TERMINAL_DISABLED=true nel .env)."
  }

  const dangerReason = findDangerousMatch(args.command)
  if (dangerReason) {
    return `🚫 Comando bloccato per sicurezza: rilevato pattern distruttivo/irreversibile (${dangerReason}).`
  }

  const jobId = randomUUID().slice(0, 8)
  echoToTerminal(mainWindow, `\r\n\x1b[45m\x1b[97m 🤖 AGENTE (background:${jobId}) \x1b[0m \x1b[96m${args.command}\x1b[0m\r\n`)

  // shell:true per supportare pipe/redirect come negli altri tool; detached:false
  // perché lo vogliamo comunque terminare quando l'app chiude, non sopravvivergli.
  const child = spawn(args.command, { cwd, shell: true })

  const job: BackgroundJob = { id: jobId, command: args.command, cwd, process: child, output: '', status: 'running', exitCode: null, startedAt: Date.now() }
  backgroundJobs.set(jobId, job)

  child.stdout?.on('data', (data) => { appendJobOutput(job, data.toString()); echoToTerminal(mainWindow, data.toString().split('\n').join('\r\n')) })
  child.stderr?.on('data', (data) => { appendJobOutput(job, data.toString()); echoToTerminal(mainWindow, `\x1b[91m${data.toString().split('\n').join('\r\n')}\x1b[0m`) })
  child.on('exit', (code) => { job.status = 'exited'; job.exitCode = code })
  child.on('error', (err) => { job.status = 'exited'; appendJobOutput(job, `\n[errore di spawn: ${err.message}]`) })

  return `🚀 Processo avviato in background con jobId '${jobId}'. Usa check_background_command con questo jobId per leggerne l'output, stop_background_command per fermarlo.`
}

export async function executeCheckBackgroundCommand(args: { jobId?: string }): Promise<string> {
  if (!args.jobId) {
    if (backgroundJobs.size === 0) return '(nessun job in background in questa sessione)'
    return Array.from(backgroundJobs.values()).map(j =>
      `${j.id}: ${j.status === 'running' ? '🟢 in esecuzione' : `⚪ terminato (exit ${j.exitCode})`} — ${j.command}`
    ).join('\n')
  }

  const job = backgroundJobs.get(args.jobId)
  if (!job) return `❌ Nessun job con id '${args.jobId}'.`

  const statusLine = job.status === 'running' ? '🟢 in esecuzione' : `⚪ terminato (exit code ${job.exitCode})`
  return `Job ${job.id} (${job.command}) — ${statusLine}\nOutput recente:\n${job.output || '(nessun output ancora)'}`
}

export async function executeStopBackgroundCommand(args: { jobId: string }): Promise<string> {
  const job = backgroundJobs.get(args.jobId)
  if (!job) return `❌ Nessun job con id '${args.jobId}'.`
  if (job.status === 'exited') return `Il job ${job.id} era già terminato (exit code ${job.exitCode}).`

  job.process.kill('SIGTERM')
  // SIGKILL di sicurezza se il processo ignora SIGTERM (comune con alcuni dev
  // server/wrapper npm che non propagano il segnale ai figli).
  setTimeout(() => { if (job.status === 'running') job.process.kill('SIGKILL') }, 3000)

  return `🛑 Segnale di terminazione inviato al job ${job.id}.`
}
