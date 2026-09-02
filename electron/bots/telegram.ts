import type TelegramBot from 'node-telegram-bot-api'
import { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'

// Caricato a runtime (come node-pty in main.ts): il default-export CJS di questo
// pacchetto non viene riconosciuto correttamente dal bundler di produzione (rolldown)
// quando importato staticamente.
const require = createRequire(import.meta.url)
const TelegramBotCtor = require('node-telegram-bot-api')

let bot: TelegramBot | null = null

export function initTelegramBot(mainWindow: BrowserWindow) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID

  if (!token) {
    console.log('Telegram Bot Token non trovato. Bot disabilitato.')
    return
  }

  try {
    bot = new TelegramBotCtor(token, { polling: true })
    console.log('✅ Telegram Bot in ascolto...')

    bot.on('message', (msg) => {
      const chatId = msg.chat.id.toString()

      // Sicurezza: default-deny. Senza TELEGRAM_ALLOWED_CHAT_ID configurato il bot
      // rifiuta TUTTI i messaggi (anche se il token è valido) — non deve mai restare
      // aperto a chiunque scriva, dato che risponde col contenuto dell'intero progetto.
      if (!allowedChatId || chatId !== allowedChatId) {
        console.warn(`Richiesta non autorizzata dal Chat ID: ${chatId}${!allowedChatId ? ' (TELEGRAM_ALLOWED_CHAT_ID non configurato)' : ''}`)
        bot?.sendMessage(chatId, `Non sei autorizzato. Il tuo Chat ID è: ${chatId}`)
        return
      }

      if (msg.text) {
        // Invia il messaggio al frontend via IPC
        mainWindow.webContents.send('bot-message', {
          source: 'telegram',
          chatId: chatId,
          text: msg.text
        })
      }
    })

    // Senza questi listener, un errore di polling (rete instabile, token
    // revocato, 409 per un'altra istanza già in polling con lo stesso token)
    // viene inghiottito silenziosamente dalla libreria: il bot smette di
    // rispondere e non c'è alcuna traccia visibile del perché. Li logghiamo
    // chiaramente e li segnaliamo al renderer per eventuale visibilità in UI.
    bot.on('polling_error', (error) => {
      console.error('❌ Telegram polling_error:', error.message || error)
      mainWindow.webContents.send('bot-status', { source: 'telegram', status: 'error', message: error.message || String(error) })
    })
    bot.on('error', (error) => {
      console.error('❌ Telegram bot error:', error.message || error)
      mainWindow.webContents.send('bot-status', { source: 'telegram', status: 'error', message: error.message || String(error) })
    })
  } catch (error) {
    console.error('Errore inizializzazione Telegram Bot:', error)
  }
}

export function sendTelegramMessage(chatId: string, text: string) {
  if (bot) {
    bot.sendMessage(chatId, text).catch(e => console.error('Errore invio msg Telegram:', e))
  }
}
