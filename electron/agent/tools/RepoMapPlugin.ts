import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'node:module'

// typescript usa internamente globali CJS (__filename) incompatibili con il bundle
// ESM del main process: caricato a runtime, come già si fa per node-pty in main.ts.
const require = createRequire(import.meta.url)
const ts = require('typescript') as typeof import('typescript')

export const RepoMapToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'get_repo_map',
    description: "Restituisce una mappa compatta del progetto estratta via AST (TypeScript Compiler API), non testo grezzo: per ogni file .ts/.tsx/.js/.jsx elenca i simboli esportati (funzioni, classi, interfacce, type) E da quali altri file locali dipende (import relativi) — un 'diagramma logico' semplificato delle relazioni tra i file, utile per capire l'architettura e i layer di comunicazione prima di modificare qualcosa. Usa questo tool PRIMA di leggere file interi per farti un'idea della struttura con molti meno token, poi leggi/modifica solo i file rilevanti con 'read_file'/'patch_file'/'search_codebase'.",
    parameters: {
      type: 'object',
      properties: {
        subPath: { type: 'string', description: "Sottocartella opzionale su cui limitare la mappa (relativa alla root del progetto). Se omesso, copre l'intero progetto." }
      }
    }
  }
}

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', '.code-ide-backups', 'release'])
const SUPPORTED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx'])
const MAX_FILES = 300
const MAX_OUTPUT_CHARS = 12000

function isExported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  const modifiers = ts.getModifiers(node)
  return !!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
}

function extractSignatures(filePath: string, sourceText: string): { signatures: string[]; localImports: string[] } {
  const scriptKind = filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind)
  const signatures: string[] = []
  // Solo import relativi (./ o ../): i moduli npm esterni non fanno parte del
  // "diagramma logico" del progetto, aggiungerli sarebbe solo rumore.
  const localImports: string[] = []

  const paramsText = (params: ts.NodeArray<ts.ParameterDeclaration>) =>
    params.map(p => p.getText(sourceFile).replace(/\s+/g, ' ')).join(', ')

  ts.forEachChild(sourceFile, node => {
    try {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text
        if (spec.startsWith('.')) localImports.push(spec)
      } else if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
        const ret = node.type ? `: ${node.type.getText(sourceFile)}` : ''
        signatures.push(`function ${node.name.text}(${paramsText(node.parameters)})${ret}`)
      } else if (ts.isClassDeclaration(node) && node.name && isExported(node)) {
        signatures.push(`class ${node.name.text}`)
        node.members.forEach(m => {
          if (ts.isMethodDeclaration(m) && m.name) {
            const ret = m.type ? `: ${m.type.getText(sourceFile)}` : ''
            signatures.push(`  .${m.name.getText(sourceFile)}(${paramsText(m.parameters)})${ret}`)
          }
        })
      } else if (ts.isInterfaceDeclaration(node) && isExported(node)) {
        signatures.push(`interface ${node.name.text}`)
      } else if (ts.isTypeAliasDeclaration(node) && isExported(node)) {
        signatures.push(`type ${node.name.text}`)
      } else if (ts.isVariableStatement(node) && isExported(node)) {
        node.declarationList.declarations.forEach(decl => {
          if (ts.isIdentifier(decl.name)) {
            const isFn = decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
            signatures.push(`const ${decl.name.text}${isFn ? '(...)' : ''}`)
          }
        })
      } else if (ts.isExportAssignment(node)) {
        signatures.push(`export default ${node.expression.getText(sourceFile).slice(0, 60)}`)
      }
    } catch {
      // Un singolo nodo malformato non deve far fallire l'intera mappa.
    }
  })

  return { signatures, localImports }
}

function collectFiles(subDir: string, out: string[]) {
  if (out.length >= MAX_FILES) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(subDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        collectFiles(path.join(subDir, entry.name), out)
      }
    } else if (SUPPORTED_EXT.has(path.extname(entry.name))) {
      out.push(path.join(subDir, entry.name))
    }
  }
}

export async function executeGetRepoMap(args: { subPath?: string }, cwd: string): Promise<string> {
  try {
    const startDir = args.subPath ? path.join(cwd, args.subPath) : cwd
    if (!fs.existsSync(startDir)) {
      return `❌ Percorso non trovato: ${startDir}`
    }

    const files: string[] = []
    collectFiles(startDir, files)

    if (files.length === 0) {
      return 'Nessun file .ts/.tsx/.js/.jsx trovato in questo percorso.'
    }

    let result = ''
    let truncatedFiles = false
    for (const file of files) {
      if (result.length >= MAX_OUTPUT_CHARS) { truncatedFiles = true; break }
      let content: string
      try {
        content = fs.readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      const { signatures, localImports } = extractSignatures(file, content)
      if (signatures.length === 0 && localImports.length === 0) continue

      const relPath = path.relative(cwd, file)
      const depsLine = localImports.length > 0 ? `dipende da: ${localImports.join(', ')}\n` : ''
      result += `\n--- ${relPath} ---\n${depsLine}${signatures.join('\n')}\n`
    }

    if (result.length > MAX_OUTPUT_CHARS) {
      result = result.slice(0, MAX_OUTPUT_CHARS) + '\n... (mappa troncata, progetto molto grande)'
    } else if (truncatedFiles || files.length >= MAX_FILES) {
      result += `\n... (${MAX_FILES}+ file trovati, mappa limitata ai primi; usa 'subPath' per una sottocartella specifica)`
    }

    return `🗺️ Repo map (${files.length} file analizzati):\n${result || '(nessun simbolo esportato trovato)'}`
  } catch (error: any) {
    return `❌ Errore nella generazione della repo map: ${error.message}`
  }
}
