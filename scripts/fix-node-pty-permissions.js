// npm (a differenza di altri package manager) a volte non preserva il bit di
// esecuzione del binario 'spawn-helper' che node-pty usa su macOS/Linux per
// allocare il pty — il risultato è un crash silenzioso ("posix_spawnp failed")
// al primo avvio del terminale integrato, apparentemente casuale perché dipende
// da come/quando i moduli sono stati installati. Questo script (postinstall)
// garantisce che il bit +x sia sempre presente, su qualunque macchina.
import { chmodSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const prebuildDirs = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']

for (const dir of prebuildDirs) {
  const helperPath = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', dir, 'spawn-helper')
  if (existsSync(helperPath)) {
    try {
      chmodSync(helperPath, 0o755)
      console.log(`[fix-node-pty-permissions] +x applicato a ${dir}/spawn-helper`)
    } catch (err) {
      console.warn(`[fix-node-pty-permissions] Impossibile impostare +x su ${dir}/spawn-helper:`, err.message)
    }
  }
}
