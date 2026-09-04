import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  },
  resolve: {
    alias: {
      // Vedi test/mocks/electron.ts: fuori dal binario Electron reale non
      // c'è nessuna { app } da importare, i servizi che la usano andrebbero
      // altrimenti in crash al primo app.getPath(...).
      electron: path.resolve(import.meta.dirname, 'test/mocks/electron.ts')
    }
  }
})
