import * as fs from 'node:fs'
import * as path from 'node:path'

// Carica definizioni Markdown+frontmatter da <progetto>/.code-ide/agents/ (sub-agenti
// riusabili, come .claude/agents/*.md) e .code-ide/commands/ (comandi slash, come
// .claude/commands/*.md) — prima di questo, l'UNICO modo di ottenere un sub-agente
// era 'invoke_subagent' interamente ad-hoc (ruolo/task passati inline dal modello
// ogni volta), senza alcuna persona riusabile salvabile tra sessioni.

export interface MarkdownDefinition {
  name: string
  description: string
  body: string
}

function parseFrontmatterMarkdown(raw: string, fallbackName: string): MarkdownDefinition {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  let description = ''
  let body = raw

  if (match) {
    const frontmatter = match[1]
    body = match[2]
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
    if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '')
  }

  return { name: fallbackName, description: description || '(nessuna descrizione)', body: body.trim() }
}

function loadDefinitions(dir: string): MarkdownDefinition[] {
  if (!fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8')
        return parseFrontmatterMarkdown(raw, f.replace(/\.md$/, ''))
      })
  } catch {
    return []
  }
}

export function loadAgentDefinitions(cwd: string): MarkdownDefinition[] {
  return loadDefinitions(path.join(cwd, '.code-ide', 'agents'))
}

export function loadCommandDefinitions(cwd: string): MarkdownDefinition[] {
  return loadDefinitions(path.join(cwd, '.code-ide', 'commands'))
}

export function findAgentDefinition(cwd: string, name: string): MarkdownDefinition | null {
  return loadAgentDefinitions(cwd).find(a => a.name === name) || null
}

export function findCommandDefinition(cwd: string, name: string): MarkdownDefinition | null {
  return loadCommandDefinitions(cwd).find(c => c.name === name) || null
}

/** Espande {{args}} nel corpo del comando con il testo passato dopo il nome del comando. */
export function expandCommandTemplate(template: string, args: string): string {
  return template.includes('{{args}}') ? template.replace(/\{\{args\}\}/g, args) : `${template}\n\n${args}`.trim()
}
