// Mock minimo del modulo 'electron' per i test Vitest: fuori dal binario
// Electron reale, 'electron' come pacchetto npm si risolve a una stringa
// (il path dell'eseguibile), non all'API — checkpointStore.ts e altri
// servizi che importano { app } da 'electron' andrebbero in crash appena
// chiamano app.getPath(...). Questo mock copre solo ciò che i test usano
// davvero, niente di più.
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const app = {
  getPath(name: string): string {
    const dir = path.join(os.tmpdir(), 'code-ide-vitest', name)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  },
  isQuitting: false
}
