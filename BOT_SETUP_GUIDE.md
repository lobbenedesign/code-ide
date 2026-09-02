# Configurazione Bot Remoti (Code-IDE)

Con Code-IDE puoi gestire il tuo progetto e il tuo agente locale anche quando non sei davanti al computer, chattando direttamente con il tuo IDE tramite **Telegram** o **WhatsApp**.

---

## 🤖 1. Configurazione Bot Telegram

Telegram è il metodo più veloce e leggero per controllare Code-IDE da remoto.

### Step 1: Crea il Bot
1. Apri Telegram e cerca **@BotFather** (ha la spunta blu).
2. Avvia la chat e digita `/newbot`.
3. Scegli un nome per il tuo bot (es. `Il Mio Code-IDE`).
4. Scegli uno username univoco che termini con `bot` (es. `giuseppe_code_ide_bot`).
5. BotFather ti fornirà un **Token di Accesso** (una lunga stringa di testo). Copialo.

### Step 2: Collega il Bot all'IDE
1. Copia il token ottenuto.
2. Crea un file `.env` nella cartella `code-ide` (se non esiste) e inserisci:
   ```env
   TELEGRAM_BOT_TOKEN=il_tuo_token_qui
   ```
3. Avvia Code-IDE. Il bot ora è in ascolto sul tuo Mac.

### Step 3: Sicurezza (Chat ID)
Di default, il bot rifiuterà di eseguire i comandi per ragioni di sicurezza.
1. Cerca il tuo bot su Telegram e scrivigli un messaggio qualsiasi.
2. Sulla console integrata dell'IDE, vedrai un log simile a: `Richiesta non autorizzata dal Chat ID: 123456789`.
3. Copia quel numero e aggiungilo al tuo `.env`:
   ```env
   TELEGRAM_ALLOWED_CHAT_ID=123456789
   ```
4. Riavvia l'IDE. Ora il bot risponderà solo ed esclusivamente a te.

---

## 🟢 2. Configurazione Bot WhatsApp

WhatsApp usa una libreria (`whatsapp-web.js`) che simula WhatsApp Web. L'IDE si comporterà come un dispositivo collegato.

### Step 1: Collegamento
1. Crea (o modifica) il file `.env` nella cartella `code-ide` e aggiungi:
   ```env
   ENABLE_WHATSAPP=true
   ```
   Il bot WhatsApp è disattivato di default (per non aprire un'istanza Puppeteer inutile ad ogni avvio) e si attiva solo con questo flag.
2. Al primo avvio dell'IDE con `ENABLE_WHATSAPP=true`, il terminale interno stamperà un **QR Code**.
3. Apri WhatsApp sul tuo telefono.
4. Vai su **Impostazioni > Dispositivi Collegati > Collega un dispositivo**.
5. Inquadra il QR Code sul terminale del tuo Mac.

### Step 2: Sicurezza
Come per Telegram, il sistema accetterà comandi solo se sa chi sei. 
Appena invierai un messaggio al tuo stesso numero (usando la funzione "Invia un messaggio a te stesso" di WhatsApp), l'IDE vedrà il messaggio e ti abiliterà, ignorando le altre chat.

---

## 💬 3. Come Usare i Bot

Una volta configurati, puoi usare questi comandi da Telegram/WhatsApp:

*   `/status` o `/progetto` 👉 Ti dirà qual è la cartella attualmente aperta nell'IDE.
*   `/output` 👉 Ti manderà le ultime righe del terminale interno per controllare i processi.
*   *Qualsiasi altro testo* (es. "Analizza il file App.tsx" o "Scrivi un login Python") 👉 Verrà interpretato dall'Agente (Qwen/Ollama/Gemini) che leggerà l'intero progetto in background sul tuo Mac e ti risponderà sul cellulare con il codice!
