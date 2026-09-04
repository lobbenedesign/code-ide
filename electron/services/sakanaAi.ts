import { BrowserWindow, session, app } from 'electron'

let sakanaWindow: BrowserWindow | null = null
let isPageReady = false
let pendingInit: Promise<void> | null = null

const SAKANA_PARTITION = 'persist:sakana'

export interface SakanaModel {
  id: string
  label: string
  description: string
  requiresAuth: boolean
}

export const SAKANA_MODELS: SakanaModel[] = [
  {
    id: 'sakana-namazu',
    label: 'Sakana: Namazu',
    description: 'Modello flagship per ragionamento e comprensione semantica profonda',
    requiresAuth: false
  },
  {
    id: 'fugu',
    label: 'Sakana: Fugu (Intelligenza Collettiva)',
    description: 'Modello evolutivo a intelligenza collettiva (richiede login)',
    requiresAuth: true
  }
]

export function getSakanaWindow(): BrowserWindow {
  if (!sakanaWindow || sakanaWindow.isDestroyed()) {
    isPageReady = false
    const ses = session.fromPartition(SAKANA_PARTITION)

    ses.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    sakanaWindow = new BrowserWindow({
      show: false,
      width: 820,
      height: 720,
      title: 'Sakana AI Session Bridge',
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    sakanaWindow.loadURL('https://chat.sakana.ai')

    sakanaWindow.webContents.on('did-finish-load', () => {
      isPageReady = true
    })

    sakanaWindow.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault()
        sakanaWindow?.hide()
      }
    })
  }
  return sakanaWindow
}

async function ensureSakanaReady(): Promise<BrowserWindow> {
  const win = getSakanaWindow()
  if (isPageReady) return win

  if (!pendingInit) {
    pendingInit = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        pendingInit = null
        resolve()
      }, 15000)

      win.webContents.once('did-finish-load', () => {
        clearTimeout(timeout)
        isPageReady = true
        pendingInit = null
        resolve()
      })
    })
  }

  await pendingInit
  return win
}

/**
 * Verifica se la sessione corrente su Sakana AI è autenticata
 */
export async function checkSakanaAuth(): Promise<boolean> {
  try {
    const ses = session.fromPartition(SAKANA_PARTITION)
    const cookies = await ses.cookies.get({ domain: 'chat.sakana.ai' })
    // Cerca cookie tipici di sessione (Firebase auth, session cookie, o token utente)
    const hasSessionCookie = cookies.some(c => 
      c.name.includes('session') || c.name.includes('token') || c.name.includes('auth') || c.name.includes('user')
    )

    if (hasSessionCookie) return true

    // Verifica nel DOM o tramite API /api/rate-limit/status
    const win = await ensureSakanaReady()
    const isLoggedIn = await win.webContents.executeJavaScript(`
      (() => {
        try {
          const userStr = window.__next_f ? JSON.stringify(window.__next_f) : '';
          if (userStr.includes('"user":{') || userStr.includes('"user":{"id"')) return true;
          // Se non c'è il pulsante ログイン (Login), l'utente è loggato
          const buttons = Array.from(document.querySelectorAll('button'));
          const hasLoginBtn = buttons.some(b => b.innerText.includes('ログイン') || b.innerText.includes('Log in'));
          return !hasLoginBtn && buttons.length > 3;
        } catch {
          return false;
        }
      })()
    `).catch(() => false)

    return !!isLoggedIn
  } catch {
    return false
  }
}

/**
 * Apre la finestra di login interattiva per l'utente, e la chiude non appena il login ha successo
 */
export async function openSakanaLogin(): Promise<boolean> {
  const win = getSakanaWindow()
  win.show()
  win.focus()
  win.setTitle('Accedi a Sakana AI (La finestra si chiuderà da sola ad accesso completato)')

  return new Promise<boolean>((resolve) => {
    let resolved = false
    const checkInterval = setInterval(async () => {
      if (resolved) return
      const isAuthed = await checkSakanaAuth()
      if (isAuthed) {
        resolved = true
        clearInterval(checkInterval)
        win.hide()
        resolve(true)
      }
    }, 1500)

    // Se l'utente chiude manualmente la finestra prima del login
    win.once('hide', () => {
      if (!resolved) {
        resolved = true
        clearInterval(checkInterval)
        resolve(false)
      }
    })
  })
}

export interface SakanaChatOptions {
  model: string
  messages: Array<{ role: string, content: string | any[] }>
  tools?: any[]
  onChunk?: (token: string) => void
}

function preparePrompt(messages: Array<{ role: string, content: string | any[] }>, tools?: any[]): string {
  let prompt = ''

  if (tools && tools.length > 0) {
    const toolListStr = tools.map(t => {
      const fn = t.function || t
      return `- ${fn.name}: ${fn.description || ''}\n  Parameters: ${JSON.stringify(fn.parameters || {})}`
    }).join('\n')

    prompt += `[ISTRUZIONI DI SISTEMA PER GLI STRUMENTI]\nHai a disposizione i seguenti strumenti per eseguire il task:\n${toolListStr}\n\n` +
      `Quando decidi di invocare uno strumento, rispondi ESCLUSIVAMENTE con un blocco JSON in questo formato:\n` +
      `\`\`\`json\n{\n  "name": "nome_strumento",\n  "arguments": { ... }\n}\n\`\`\`\n` +
      `Se non devi usare strumenti, rispondi direttamente all'utente.\n[FINE ISTRUZIONI]\n\n`
  }

  for (const m of messages) {
    const roleTag = m.role === 'user' ? 'Utente' : m.role === 'assistant' ? 'Assistente' : 'Sistema'
    const textContent = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((c: any) => c.text || JSON.stringify(c)).join(' ')
        : String(m.content || '')
    
    prompt += `${roleTag}: ${textContent}\n\n`
  }

  return prompt.trim()
}

/**
 * Esegue la chiamata al protocollo nativo di Sakana AI (bootstrap conversazione + stream)
 */
export async function callSakanaChat(options: SakanaChatOptions): Promise<{ content: string }> {
  const rawModel = options.model.replace(/^sakana:/, '') || 'sakana-namazu'
  const isFugu = rawModel.includes('fugu')

  // Se richiede login e non è autenticato, apriamo la finestra e attendiamo
  if (isFugu) {
    const authed = await checkSakanaAuth()
    if (!authed) {
      const loginOk = await openSakanaLogin()
      if (!loginOk) {
        throw new Error('Accesso a Sakana AI annullato o non completato. È richiesto il login per utilizzare Fugu.')
      }
    }
  }

  const win = await ensureSakanaReady()
  const fullPrompt = preparePrompt(options.messages, options.tools)

  // Esegui la chiamata nel contesto autenticato del browser Electron
  const startResult = await win.webContents.executeJavaScript(`
    (async () => {
      window.__sakanaDelta = '';
      window.__sakanaFull = '';
      window.__sakanaDone = false;
      window.__sakanaError = null;

      try {
        // 1. Bootstrap della conversazione
        const bootRes = await fetch('/api/conversation', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            inputs: ${JSON.stringify(fullPrompt)},
            enableThinking: false,
            toneMode: 'default',
            webSearchEnabled: false,
            model: ${JSON.stringify(rawModel)}
          })
        });

        if (!bootRes.ok) {
          const errData = await bootRes.json().catch(() => ({}));
          return { error: errData.message || 'Errore bootstrap conversazione (' + bootRes.status + ')' };
        }

        const boot = await bootRes.json();
        const conversationId = boot.conversationId;
        const systemMessageId = boot.systemMessageId || ('sys-' + Date.now());

        if (!conversationId) {
          return { error: 'ID conversazione non restituito da Sakana AI' };
        }

        // 2. Invio del messaggio e avvio stream
        const formData = new FormData();
        formData.append('data', JSON.stringify({
          inputs: ${JSON.stringify(fullPrompt)},
          id: systemMessageId,
          is_retry: false,
          is_continue: false,
          enableThinking: false,
          toneMode: 'default',
          webSearchEnabled: false,
          model: ${JSON.stringify(rawModel)}
        }));

        // Esegui in background senza bloccare la risposta iniziale
        (async () => {
          try {
            const streamRes = await fetch('/api/conversation/' + conversationId, {
              method: 'POST',
              credentials: 'include',
              body: formData
            });

            if (!streamRes.ok) {
              window.__sakanaError = 'Errore stream Sakana (' + streamRes.status + ')';
              window.__sakanaDone = true;
              return;
            }

            const reader = streamRes.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // I chunk di Sakana possono essere data: o testo SSE standard
                if (trimmed.startsWith('data:')) {
                  const payload = trimmed.slice(5).trim();
                  if (payload === '[DONE]') {
                    window.__sakanaDone = true;
                    continue;
                  }
                  try {
                    const parsed = JSON.parse(payload);
                    const token = parsed.text || parsed.content || parsed.message || '';
                    if (token) {
                      window.__sakanaFull += token;
                      window.__sakanaDelta += token;
                    }
                  } catch {
                    window.__sakanaFull += payload;
                    window.__sakanaDelta += payload;
                  }
                } else {
                  window.__sakanaFull += trimmed + '\\n';
                  window.__sakanaDelta += trimmed + '\\n';
                }
              }
            }
          } catch (streamErr) {
            window.__sakanaError = String(streamErr.message || streamErr);
          } finally {
            window.__sakanaDone = true;
          }
        })();

        return { success: true };
      } catch (err) {
        return { error: String(err.message || err) };
      }
    })()
  `)

  if (startResult.error) {
    throw new Error(`Sakana AI: ${startResult.error}`)
  }

  // 3. Monitora lo streaming
  let lastLength = 0
  const maxWaitMs = 120000
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, 250))

    const poll = await win.webContents.executeJavaScript(`
      (() => {
        const full = window.__sakanaFull || '';
        const delta = window.__sakanaDelta || '';
        window.__sakanaDelta = '';
        return {
          full,
          delta,
          isDone: !!window.__sakanaDone,
          error: window.__sakanaError
        };
      })()
    `)

    if (poll.error) {
      throw new Error(`Sakana AI Stream Error: ${poll.error}`)
    }

    if (poll.delta && options.onChunk) {
      options.onChunk(poll.delta)
    }

    lastLength = poll.full.length

    if (poll.isDone && lastLength > 0) {
      return { content: poll.full.trim() }
    }
  }

  const finalResponse = await win.webContents.executeJavaScript(`window.__sakanaFull || ''`)
  if (!finalResponse.trim()) {
    throw new Error('Sakana AI: Nessuna risposta ricevuta entro il timeout.')
  }

  return { content: finalResponse.trim() }
}
