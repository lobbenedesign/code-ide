import { createRequire } from 'node:module'
import * as path from 'path'
import * as fs from 'fs'

// typescript usa internamente globali CJS (__filename) incompatibili con il bundle
// ESM del main process: caricato a runtime, come già si fa per node-pty in main.ts.
const require = createRequire(import.meta.url)
const ts = require('typescript') as typeof import('typescript')

export const DiagnosticsToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'get_diagnostics',
    description: "Esegue una VERA analisi di tipo (type-checking, come farebbe un language server) su un file .ts/.tsx/.js/.jsx del progetto usando il compilatore TypeScript — errori di tipo reali, import non risolti, proprietà inesistenti, ecc., non deduzioni testuali basate sulla lettura del codice. Copre solo TypeScript/JavaScript, non altri linguaggi. Usalo dopo 'edit_file'/'patch_file' per verificare di non aver introdotto errori di tipo, prima di considerare il task completato.",
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Percorso del file .ts/.tsx/.js/.jsx da controllare, relativo alla root del progetto.' }
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

export async function executeGetDiagnostics(args: { filePath: string }, cwd: string): Promise<string> {
  const targetPath = path.isAbsolute(args.filePath) ? args.filePath : path.join(cwd, args.filePath)

  if (!fs.existsSync(targetPath)) {
    return `❌ File non trovato: ${args.filePath}`
  }
  if (!/\.(ts|tsx|js|jsx)$/i.test(targetPath)) {
    return `⚠️ 'get_diagnostics' copre solo file TypeScript/JavaScript (.ts/.tsx/.js/.jsx). Per altri linguaggi (Python, Rust, ecc.) non è disponibile una vera diagnostica di tipo in questo IDE — usa 'run_terminal_command' con il linter/type-checker nativo di quel linguaggio se disponibile (es. mypy, cargo check).`
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
