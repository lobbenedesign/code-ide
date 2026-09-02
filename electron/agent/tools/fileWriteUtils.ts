import * as fs from 'fs'
import * as path from 'path'

// Diff riga-per-riga con LCS (DP O(n*m)): sufficiente per file di dimensioni tipiche.
// Su file molto grandi salta la diff precisa e riporta solo il delta di righe, per
// evitare costi O(n*m) eccessivi.
const MAX_LINES_FOR_PRECISE_DIFF = 3000

export function summarizeDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  if (oldLines.length > MAX_LINES_FOR_PRECISE_DIFF || newLines.length > MAX_LINES_FOR_PRECISE_DIFF) {
    const delta = newLines.length - oldLines.length
    return `~${Math.abs(delta)} righe ${delta >= 0 ? 'in più' : 'in meno'} (file grande, diff precisa saltata)`
  }

  const n = oldLines.length, m = newLines.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  let added = 0, removed = 0, i = 0, j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { removed++; i++ }
    else { added++; j++ }
  }
  removed += n - i
  added += m - j

  if (added === 0 && removed === 0) return 'nessuna modifica di contenuto'
  return `+${added} righe, -${removed} righe`
}

const BACKUP_DIR_NAME = '.code-ide-backups'

/** Backup automatico best-effort prima di sovrascrivere un file esistente. */
export function backupFile(cwd: string, relOrAbsFilePath: string, oldContent: string) {
  try {
    const backupRoot = path.join(cwd, BACKUP_DIR_NAME)
    const relPath = path.isAbsolute(relOrAbsFilePath) ? path.basename(relOrAbsFilePath) : relOrAbsFilePath
    const backupPath = path.join(backupRoot, `${relPath}.${Date.now()}.bak`)
    fs.mkdirSync(path.dirname(backupPath), { recursive: true })
    fs.writeFileSync(backupPath, oldContent, 'utf-8')
  } catch {
    // Il backup è una rete di sicurezza best-effort: non deve mai bloccare il salvataggio reale.
  }
}

export function resolveTargetPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
}
