import { createRequire } from 'node:module'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { execSync } from 'child_process'

// typescript usa internamente globali CJS (__filename) incompatibili con il bundle
// ESM del main process: caricato a runtime, come già si fa per node-pty in main.ts.
const require = createRequire(import.meta.url)
const ts = require('typescript') as typeof import('typescript')

export const DiagnosticsToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'get_diagnostics',
    description: "Esegue una VERA analisi statica su un file del progetto, non deduzioni testuali basate sulla lettura del codice. Per .ts/.tsx/.js/.jsx: type-checking reale via il compilatore TypeScript (errori di tipo, import non risolti, proprietà inesistenti, ecc.). Per .py: 'mypy' se installato (type-checking reale), altrimenti solo un controllo sintattico (py_compile). Per .rs: 'cargo check' sul crate che contiene il file (se è dentro un progetto Cargo). Per .go: 'go vet'. Per gli altri linguaggi non è disponibile: usa 'run_terminal_command' con il linter/type-checker nativo. Usalo dopo 'edit_file'/'patch_file' per verificare di non aver introdotto errori, prima di considerare il task completato.",
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Percorso del file da controllare (.ts/.tsx/.js/.jsx, .py, .rs o .go), relativo alla root del progetto.' }
      },
      required: ['filePath']
    }
  }
}

const MAX_DIAGNOSTICS = 30

function findTsConfig(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'tsconfig.json')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function resolveCompilerOptions(cwd: string): ts.CompilerOptions {
  const tsconfigPath = findTsConfig(cwd)
  const fallback: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    skipLibCheck: true,
    noEmit: true
  }

  if (!tsconfigPath) return fallback

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (configFile.error) return fallback

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath))
  return { ...parsed.options, noEmit: true }
}

// Esegue un comando ESTERNO passando per la vera shell di login dell'utente
// (stesso fix già applicato al terminale integrato: os.userInfo().shell,
// non un hardcoded /bin/bash) invece di execSync col suo shell di default —
// un tool installato via un version manager (pyenv/rustup/nvm, che modifica
// il PATH solo dentro .zshrc/.bashrc) altrimenti risulterebbe "non trovato"
// anche se l'utente lo usa ogni giorno dal proprio terminale.
function runViaLoginShell(command: string, cwd: string, timeoutMs = 20000): { output: string, failed: boolean } {
  const shell = os.platform() === 'win32' ? undefined : (os.userInfo().shell || process.env.SHELL || '/bin/zsh')
  try {
    const output = execSync(command, { cwd, encoding: 'utf-8', timeout: timeoutMs, shell, stdio: ['ignore', 'pipe', 'pipe'] })
    return { output: output.trim(), failed: false }
  } catch (error: any) {
    // Un exit code diverso da zero è l'esito NORMALE di un linter che ha
    // trovato problemi (non un errore di esecuzione) — l'output utile è
    // comunque su stdout/stderr dell'eccezione, non va perso.
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim() || error.message
    return { output, failed: true }
  }
}

function commandExists(command: string, cwd: string): boolean {
  const probe = os.platform() === 'win32' ? `where ${command}` : `command -v ${command}`
  return !runViaLoginShell(probe, cwd, 5000).failed
}

function findAncestorFile(startDir: string, fileName: string): string | null {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, fileName)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function checkPython(targetPath: string, relativePath: string, cwd: string): Promise<string> {
  if (commandExists('mypy', cwd)) {
    const { output, failed } = runViaLoginShell(`mypy "${targetPath}" --no-error-summary --ignore-missing-imports`, cwd)
    if (!failed) return `✅ Nessun errore di tipo trovato in ${relativePath} (analisi mypy completa).`
    return `⚠️ Problemi trovati da mypy in ${relativePath}:\n${output}`
  }
  // mypy non installato: fallback a un controllo puramente sintattico
  // (py_compile è parte della standard library, sempre disponibile con
  // qualunque installazione Python) — meglio di niente, ma va detto
  // chiaramente che NON è type-checking reale.
  if (!commandExists('python3', cwd)) {
    return `⚠️ Né 'mypy' né 'python3' sono raggiungibili da questo ambiente — nessuna diagnostica disponibile per ${relativePath}. Installa Python 3 (e opzionalmente 'pip install mypy' per un type-checking reale).`
  }
  const { output, failed } = runViaLoginShell(`python3 -m py_compile "${targetPath}"`, cwd)
  if (!failed) return `✅ Nessun errore di sintassi in ${relativePath} (solo controllo sintattico — 'mypy' non è installato, quindi nessun type-checking reale è stato eseguito. Installa mypy per una diagnostica completa).`
  return `⚠️ Errore di sintassi in ${relativePath}:\n${output}`
}

async function checkRust(targetPath: string, relativePath: string, cwd: string): Promise<string> {
  if (!commandExists('cargo', cwd)) {
    return `⚠️ 'cargo' non è raggiungibile da questo ambiente — installa Rust (rustup.rs) per la diagnostica su file .rs.`
  }
  const cargoToml = findAncestorFile(path.dirname(targetPath), 'Cargo.toml')
  if (!cargoToml) {
    return `⚠️ ${relativePath} non sembra far parte di un progetto Cargo (nessun Cargo.toml trovato risalendo le cartelle) — 'cargo check' richiede un crate valido.`
  }
  const crateDir = path.dirname(cargoToml)
  // cargo check analizza l'INTERO crate, non un singolo file (Rust non ha un
  // modo di type-checkare un file isolato fuori dal suo contesto di moduli) —
  // dichiarato nella risposta per non far credere che sia limitato al file richiesto.
  const { output, failed } = runViaLoginShell('cargo check --message-format=short', crateDir, 60000)
  if (!failed) return `✅ Nessun errore trovato da 'cargo check' nel crate che contiene ${relativePath} (l'intero crate è stato analizzato, non solo questo file).`
  return `⚠️ Problemi trovati da 'cargo check' nel crate che contiene ${relativePath} (l'intero crate è stato analizzato, non solo questo file):\n${output}`
}

async function checkGo(targetPath: string, relativePath: string, cwd: string): Promise<string> {
  if (!commandExists('go', cwd)) {
    return `⚠️ 'go' non è raggiungibile da questo ambiente — installa Go (go.dev) per la diagnostica su file .go.`
  }
  const { output, failed } = runViaLoginShell(`go vet "${targetPath}"`, path.dirname(targetPath), 30000)
  if (!failed) return `✅ Nessun errore trovato da 'go vet' in ${relativePath}.`
  return `⚠️ Problemi trovati da 'go vet' in ${relativePath}:\n${output}`
}

export async function executeGetDiagnostics(args: { filePath: string }, cwd: string): Promise<string> {
  const targetPath = path.isAbsolute(args.filePath) ? args.filePath : path.join(cwd, args.filePath)

  if (!fs.existsSync(targetPath)) {
    return `❌ File non trovato: ${args.filePath}`
  }

  if (/\.py$/i.test(targetPath)) return checkPython(targetPath, args.filePath, cwd)
  if (/\.rs$/i.test(targetPath)) return checkRust(targetPath, args.filePath, cwd)
  if (/\.go$/i.test(targetPath)) return checkGo(targetPath, args.filePath, cwd)
  if (!/\.(ts|tsx|js|jsx)$/i.test(targetPath)) {
    return `⚠️ 'get_diagnostics' copre .ts/.tsx/.js/.jsx (TypeScript Compiler API), .py (mypy/py_compile), .rs (cargo check) e .go (go vet). Per altri linguaggi non è disponibile una vera diagnostica in questo IDE — usa 'run_terminal_command' con il linter/type-checker nativo di quel linguaggio se disponibile.`
  }

  try {
    const compilerOptions = resolveCompilerOptions(cwd)
    const program = ts.createProgram([targetPath], compilerOptions)
    const sourceFile = program.getSourceFile(targetPath)

    if (!sourceFile) {
      return `❌ Impossibile analizzare ${args.filePath} (percorso non valido o escluso dal tsconfig.json).`
    }

    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile)
    ]

    if (diagnostics.length === 0) {
      return `✅ Nessun errore di tipo trovato in ${args.filePath} (analisi TypeScript completa).`
    }

    const formatted = diagnostics.slice(0, MAX_DIAGNOSTICS).map(d => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, '\n')
      const severity = d.category === ts.DiagnosticCategory.Error ? 'ERRORE' : d.category === ts.DiagnosticCategory.Warning ? 'AVVISO' : 'INFO'
      if (d.file && d.start !== undefined) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
        return `${severity} ${args.filePath}:${line + 1}:${character + 1} - ${message}`
      }
      return `${severity} - ${message}`
    }).join('\n')

    const truncNote = diagnostics.length > MAX_DIAGNOSTICS ? `\n... (${diagnostics.length - MAX_DIAGNOSTICS} altri problemi non mostrati)` : ''
    return `⚠️ ${diagnostics.length} problema/i di tipo trovato/i in ${args.filePath}:\n${formatted}${truncNote}`
  } catch (error: any) {
    return `❌ Errore durante l'analisi di tipo: ${error.message}`
  }
}
