import { execFile } from 'child_process'
import { promisify } from 'util'
import * as dotenv from 'dotenv'

dotenv.config()

const execFileAsync = promisify(execFile)

// 'git add .' stage TUTTO ciò che è nella working tree, incluso qualsiasi file
// non ancora ignorato da .gitignore — se lì dentro c'è un .env, una chiave
// privata o un file di credenziali dimenticato, verrebbe committato e pushato
// su GitHub (anche pubblico) senza che nessuno lo veda arrivare, dato che
// questo tool può essere invocato in piena autonomia (anche da un messaggio
// Telegram/WhatsApp senza conferma umana). Blocchiamo il publish se uno di
// questi pattern compare tra i file che verrebbero effettivamente aggiunti.
const SECRET_FILENAME_PATTERNS = [
  /(^|\/)\.env(\..+)?$/i,
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.keystore$/i, /\.jks$/i,
  /(^|\/)id_rsa(\.\w+)?$/i, /(^|\/)id_ed25519(\.\w+)?$/i,
  /credentials\.json$/i, /service[-_]?account.*\.json$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml)$/i
]

async function findSecretLikeFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd })
  const files = stdout.split('\n')
    .map(line => line.slice(3).trim()) // rimuove il codice di stato a 2 caratteri + spazio
    .filter(Boolean)
  return files.filter(f => SECRET_FILENAME_PATTERNS.some(p => p.test(f)))
}

export const GitHubToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'publish_to_github',
    description: "Pubblica il progetto corrente creando un nuovo repository remoto su GitHub ed eseguendo il push del codice. Usa questo tool quando l'utente ti chiede di pubblicare, caricare o pushare l'intero progetto su GitHub.",
    parameters: {
      type: 'object',
      properties: {
        repoName: {
          type: 'string',
          description: 'Il nome del repository da creare su GitHub (es. mio-progetto)'
        },
        isPrivate: {
          type: 'boolean',
          description: 'Imposta a true per creare un repository privato, false per uno pubblico (default: true)',
          default: true
        }
      },
      required: ['repoName']
    }
  }
}

export async function executeGitHubPublish(cwd: string, repoName: string, isPrivate: boolean = true): Promise<string> {
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    return 'Errore: Variabile d\'ambiente GITHUB_TOKEN non trovata. Per favore chiedi all\'utente di aggiungerla nel file .env nella root del progetto per poter pubblicare su GitHub.'
  }

  try {
    // 1. Controlla se c'è un repository git locale
    let isGitRepo = false
    try {
      await execFileAsync('git', ['status'], { cwd })
      isGitRepo = true
    } catch {
      // Non è un repository git, inizializziamolo
    }

    if (isGitRepo) {
      const secretFiles = await findSecretLikeFiles(cwd)
      if (secretFiles.length > 0) {
        return `🚫 Pubblicazione bloccata per sicurezza: tra i file non committati ci sono file dall'aspetto sensibile che 'git add .' pubblicherebbe su GitHub senza controllo:\n${secretFiles.map(f => `  - ${f}`).join('\n')}\n\nAggiungili a .gitignore (o rimuovili dalla working tree) prima di riprovare a pubblicare.`
      }
    }

    if (!isGitRepo) {
      await execFileAsync('git', ['init'], { cwd })
      await execFileAsync('git', ['add', '.'], { cwd })
      try {
        await execFileAsync('git', ['commit', '-m', 'Initial commit from Code-IDE'], { cwd })
      } catch (e: any) {
        if (!e.message.includes('nothing to commit')) {
          throw e
        }
      }
    } else {
      // È già un repo, facciamo comunque una add e commit di sicurezza per l'ultimo stato
      await execFileAsync('git', ['add', '.'], { cwd })
      try {
        await execFileAsync('git', ['commit', '-m', 'Update prima del push su GitHub via Code-IDE'], { cwd })
      } catch (_e: any) {
        // Ignora se non c'è nulla da committare
      }
    }

    // 2. Crea il repository remoto usando le REST API di GitHub
    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: repoName,
        private: isPrivate
      })
    })

    if (!res.ok) {
      const err = await res.json()
      // Se il repo esiste già, possiamo provare a continuare o fallire
      if (err.errors && err.errors[0]?.message === 'name already exists on this account') {
        // Proviamo a ottenere l'URL remoto per fare comunque il push
        const userRes = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': `token ${token}` }
        })
        const user = await userRes.json()
        const cloneUrl = `https://${token}@github.com/${user.login}/${repoName}.git`
        return await pushToRemote(cwd, cloneUrl)
      }
      return `Errore durante la creazione del repository su GitHub: ${JSON.stringify(err)}`
    }

    const data = await res.json()
    const cloneUrlWithToken = data.clone_url.replace('https://', `https://${token}@`)

    // 3. Esegue push
    return await pushToRemote(cwd, cloneUrlWithToken)

  } catch (error: any) {
    return `Errore irreversibile durante la pubblicazione su GitHub: ${error.message}`
  }
}

async function pushToRemote(cwd: string, remoteUrl: string): Promise<string> {
  try {
    // Configura il remote (se esiste già, aggiornalo o gestisci l'errore)
    try {
      await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], { cwd })
    } catch {
      await execFileAsync('git', ['remote', 'set-url', 'origin', remoteUrl], { cwd })
    }

    // Assicuriamoci di essere sul branch main
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd })

    // Esegue il push
    await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd })

    // Non ritorniamo l'URL col token in chiaro
    const safeUrl = remoteUrl.replace(/:[^@]+@/, '@')
    return `Progetto pubblicato con successo! URL del repository remoto: ${safeUrl}`
  } catch (error: any) {
    return `Errore durante il push verso origin: ${error.message}`
  }
}
