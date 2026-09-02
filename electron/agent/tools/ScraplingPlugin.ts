import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const execAsync = promisify(exec)

export const ScraplingToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'fetch_webpage',
    description: "Scarica il contenuto REALE di una pagina web specifica (documentazione ufficiale, un file README su GitHub, una domanda su Stack Overflow) usando Scrapling, che gestisce anche pagine protette da Cloudflare/anti-bot. A differenza di 'web_search' (che restituisce una risposta sintetizzata da Perplexity), questo tool legge il contenuto grezzo di UNA pagina che conosci già l'URL. Richiede 'scrapling' installato sul sistema (pip install \"scrapling[fetchers]\" && scrapling install).",
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: "L'URL completo della pagina da scaricare." },
        stealthy: { type: 'boolean', description: 'Imposta a true solo se il sito è protetto da anti-bot/Cloudflare e un fetch normale fallisce (più lento, usa un browser reale).', default: false }
      },
      required: ['url']
    }
  }
}

async function isScraplingInstalled(): Promise<boolean> {
  try {
    await execAsync('scrapling --version')
    return true
  } catch {
    return false
  }
}

export async function executeFetchWebpage(args: { url: string; stealthy?: boolean }): Promise<string> {
  if (!(await isScraplingInstalled())) {
    return "Errore: 'scrapling' non è installato su questo sistema. Per abilitare questo tool, l'utente deve eseguire manualmente: pip install \"scrapling[fetchers]\" && scrapling install (scarica anche i browser necessari). Non tentare di installarlo automaticamente."
  }

  const outFile = path.join(os.tmpdir(), `scrapling-${Date.now()}.md`)
  const subcommand = args.stealthy ? 'stealthy-fetch' : 'fetch'
  const stealthFlag = args.stealthy ? ' --solve-cloudflare' : ''
  const command = `scrapling extract ${subcommand} "${args.url}" "${outFile}"${stealthFlag}`

  try {
    await execAsync(command, { timeout: 60000 })
    if (!fs.existsSync(outFile)) {
      return `❌ Scrapling non ha prodotto output per ${args.url}. Se il sito è protetto da anti-bot, riprova con stealthy: true.`
    }
    const content = fs.readFileSync(outFile, 'utf-8')
    fs.unlinkSync(outFile)
    const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n\n... (contenuto troncato, pagina più lunga)' : content
    return `📄 Contenuto di ${args.url}:\n\n${truncated}`
  } catch (error: any) {
    return `❌ Errore durante il fetch di ${args.url}: ${error.message}. Se è un sito protetto da anti-bot, riprova con stealthy: true.`
  }
}
