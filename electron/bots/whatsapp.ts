import type { Client as WhatsAppClient } from 'whatsapp-web.js'
import { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'

// whatsapp-web.js e qrcode-terminal trascinano dipendenze CJS pesanti/legacy
// (sintassi octal-escape, moduli opzionali come @aws-sdk/client-s3) che il
// bundler di produzione (rolldown) non riesce a gestire in un import statico:
// li carichiamo a runtime con require(), come già si fa per node-pty in main.ts.
const require = createRequire(import.meta.url)

let client: WhatsAppClient | null = null
let verifiedPhone: string | null = null // Security: solo il primo numero che scrive verrà accettato se non configurato

export function initWhatsAppBot(mainWindow: BrowserWindow) {
  if (process.env.ENABLE_WHATSAPP !== 'true') {
    return
  }

  const { Client, LocalAuth } = require('whatsapp-web.js')
  const qrcode = require('qrcode-terminal')

  try {
    client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    })

    client.on('qr', (qr) => {
      console.log('📱 WhatsApp QR Code - Scansiona con il telefono per collegare Code-IDE:')
      qrcode.generate(qr, { small: true })
      // Potremmo inviare il QR code anche alla UI volendo
    })

    client.on('ready', () => {
      console.log('✅ WhatsApp Bot Collegato e pronto!')
      mainWindow.webContents.send('bot-status', { source: 'whatsapp', status: 'ready' })
    })

    // whatsapp-web.js invalida spesso la sessione locale (logout dal telefono,
    // aggiornamento di WhatsApp Web, sessione scaduta): senza questi listener
    // il bot resta silenziosamente offline con zero segnale visibile, e
    // 'sendWhatsAppMessage' continuerebbe comunque a provare a inviare a un
    // client ormai morto.
    client.on('disconnected', (reason) => {
      console.error('❌ WhatsApp disconnesso:', reason)
      mainWindow.webContents.send('bot-status', { source: 'whatsapp', status: 'disconnected', message: String(reason) })
      client = null
    })
    client.on('auth_failure', (message) => {
      console.error('❌ WhatsApp autenticazione fallita:', message)
      mainWindow.webContents.send('bot-status', { source: 'whatsapp', status: 'error', message: String(message) })
      client = null
    })

    client.on('message', async (msg) => {
      // Sicurezza basilare: lega l'IDE al primo numero che riceve
      if (!verifiedPhone) {
         if (msg.from.endsWith('@c.us')) {
           verifiedPhone = msg.from
           console.log(`WhatsApp vincolato al numero: ${verifiedPhone}`)
           msg.reply('Code-IDE è ora sincronizzato in modo sicuro con questo numero.')
         }
      } else if (msg.from !== verifiedPhone) {
         return // Ignora messaggi da altre persone o gruppi
      }

      if (msg.body) {
        mainWindow.webContents.send('bot-message', {
          source: 'whatsapp',
          chatId: msg.from,
          text: msg.body
        })
      }
    })

    client.initialize()
  } catch (e) {
    console.error('Errore WhatsApp Web JS:', e)
  }
}

export function sendWhatsAppMessage(chatId: string, text: string) {
  if (client) {
    client.sendMessage(chatId, text).catch(e => console.error('Errore invio msg WhatsApp:', e))
  }
}
