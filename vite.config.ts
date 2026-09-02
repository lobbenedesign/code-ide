import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              // Pacchetti nativi/CJS che rolldown non riesce a bundlare correttamente
              // (moduli .node, sintassi legacy come gli octal escape di qrcode-terminal):
              // li lasciamo come require() a runtime invece di inglobarli nel bundle.
              // ppu-paddle-ocr (OCR) trascina onnxruntime-node e @napi-rs/canvas,
              // entrambi con binari nativi .node — stesso identico problema, stessa
              // soluzione: require() a runtime invece che nel bundle Rollup. Un import
              // relativo interno al pacchetto (js-binding.js che richiede il
              // sotto-pacchetto nativo per-piattaforma @napi-rs/canvas-darwin-arm64)
              // arriva qui già risolto a PATH ASSOLUTO, non come specifier con nome —
              // 'startsWith' sullo specifier nudo non lo intercetta, serve un
              // controllo su 'includes' che funzioni anche su un path assoluto.
              external: (id) =>
                ['node-pty', 'better-sqlite3', 'qrcode-terminal', 'node-telegram-bot-api', 'whatsapp-web.js', 'typescript', 'ppu-paddle-ocr', 'ppu-doclayout', 'onnxruntime-node'].includes(id)
                || id.includes('@napi-rs/canvas')
            }
          }
        }
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(import.meta.dirname, 'electron/preload.ts'),
      },
      // Ployfill the Electron and Node.js API for Renderer process.
      // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: {},
    }),
  ],
})
