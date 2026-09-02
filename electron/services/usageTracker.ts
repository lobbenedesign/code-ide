import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Tracciamo TOKEN e NUMERO DI CHIAMATE per modello, non un costo in $: i prezzi
// dei provider (OpenRouter, Together, ecc.) cambiano nel tempo e per modello, e
// tenerli sincronizzati qui sarebbe una fonte di dati sbagliati spacciati per
// precisi — meglio un numero onesto (token/chiamate reali) che una cifra di
// spesa stimata male. Persistito in userData: sopravvive al riavvio dell'app,
// a differenza di prima quando non esisteva alcun tracking.
function getUsageFilePath(): string {
  return path.join(app.getPath('userData'), 'usage.json')
}

export interface ModelUsage {
  calls: number
  promptTokens: number
  completionTokens: number
}

export interface UsageData {
  since: number
  byModel: Record<string, ModelUsage>
}

function loadUsage(): UsageData {
  const filePath = getUsageFilePath()
  if (!fs.existsSync(filePath)) {
    return { since: Date.now(), byModel: {} }
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return { since: Date.now(), byModel: {} }
  }
}

function saveUsage(data: UsageData): void {
  fs.writeFileSync(getUsageFilePath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function recordUsage(model: string, promptTokens: number, completionTokens: number): void {
  const data = loadUsage()
  const entry = data.byModel[model] || { calls: 0, promptTokens: 0, completionTokens: 0 }
  entry.calls += 1
  entry.promptTokens += Math.max(0, promptTokens || 0)
  entry.completionTokens += Math.max(0, completionTokens || 0)
  data.byModel[model] = entry
  saveUsage(data)
}

export function getUsage(): UsageData {
  return loadUsage()
}

export function resetUsage(): void {
  saveUsage({ since: Date.now(), byModel: {} })
}
