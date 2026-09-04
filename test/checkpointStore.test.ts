import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  beginCheckpoint, snapshotFileIfNeeded, snapshotFolderIfNeeded,
  finalizeCheckpoint, revertCheckpoint
} from '../electron/services/checkpointStore'

// D-02 dell'audit: revertCheckpoint() è l'unica cosa tra un run dell'agente
// andato male e la perdita del lavoro dell'utente — questa suite copre i
// tre casi che l'harness usa davvero: file modificato, file nuovo (mai
// esistito prima), e un'intera cartella cancellata.

describe('checkpointStore', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'))
  })

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('restores a modified file to its original content', () => {
    const filePath = path.join(projectRoot, 'a.ts')
    fs.writeFileSync(filePath, 'original content')

    const runId = 'run-1'
    beginCheckpoint(runId, 'test task')
    snapshotFileIfNeeded(projectRoot, runId, 'a.ts')
    fs.writeFileSync(filePath, 'modified by agent')
    finalizeCheckpoint(projectRoot, runId)

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('modified by agent')

    const { restoredFiles } = revertCheckpoint(projectRoot, runId)
    expect(restoredFiles).toContain('a.ts')
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original content')
  })

  it('deletes a file that did not exist before the run', () => {
    const filePath = path.join(projectRoot, 'new-file.ts')
    const runId = 'run-2'
    beginCheckpoint(runId, 'test task')
    snapshotFileIfNeeded(projectRoot, runId, 'new-file.ts') // primo tocco: il file non esiste ancora
    fs.writeFileSync(filePath, 'created by agent')
    finalizeCheckpoint(projectRoot, runId)

    expect(fs.existsSync(filePath)).toBe(true)
    revertCheckpoint(projectRoot, runId)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('only captures the FIRST touch of a file in a run (subsequent edits are not re-snapshotted)', () => {
    const filePath = path.join(projectRoot, 'a.ts')
    fs.writeFileSync(filePath, 'v1')
    const runId = 'run-3'
    beginCheckpoint(runId, 'test task')
    snapshotFileIfNeeded(projectRoot, runId, 'a.ts')
    fs.writeFileSync(filePath, 'v2')
    snapshotFileIfNeeded(projectRoot, runId, 'a.ts') // secondo tocco: non deve sovrascrivere lo snapshot con 'v2'
    fs.writeFileSync(filePath, 'v3')
    finalizeCheckpoint(projectRoot, runId)

    revertCheckpoint(projectRoot, runId)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('v1')
  })

  it('restores every text file inside a deleted folder (delete_folder coverage)', () => {
    const folderPath = path.join(projectRoot, 'sub')
    fs.mkdirSync(folderPath, { recursive: true })
    fs.writeFileSync(path.join(folderPath, 'x.ts'), 'x content')
    fs.mkdirSync(path.join(folderPath, 'nested'))
    fs.writeFileSync(path.join(folderPath, 'nested', 'y.ts'), 'y content')

    const runId = 'run-4'
    beginCheckpoint(runId, 'delete folder')
    snapshotFolderIfNeeded(projectRoot, runId, 'sub')
    fs.rmSync(folderPath, { recursive: true, force: true })
    finalizeCheckpoint(projectRoot, runId)

    expect(fs.existsSync(folderPath)).toBe(false)
    const { restoredFiles } = revertCheckpoint(projectRoot, runId)
    expect(restoredFiles.sort()).toEqual(['sub/nested/y.ts', 'sub/x.ts'].sort())
    expect(fs.readFileSync(path.join(folderPath, 'x.ts'), 'utf-8')).toBe('x content')
    expect(fs.readFileSync(path.join(folderPath, 'nested', 'y.ts'), 'utf-8')).toBe('y content')
  })

  it('skips binary files inside a deleted folder instead of corrupting them on restore', () => {
    const folderPath = path.join(projectRoot, 'assets')
    fs.mkdirSync(folderPath, { recursive: true })
    const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0xfe])
    fs.writeFileSync(path.join(folderPath, 'img.png'), binaryContent)
    fs.writeFileSync(path.join(folderPath, 'note.txt'), 'plain text')

    const runId = 'run-5'
    beginCheckpoint(runId, 'delete folder with binary')
    snapshotFolderIfNeeded(projectRoot, runId, 'assets')
    fs.rmSync(folderPath, { recursive: true, force: true })
    finalizeCheckpoint(projectRoot, runId)

    const { restoredFiles } = revertCheckpoint(projectRoot, runId)
    // Solo il file di testo torna: il binario è stato scartato allo snapshot,
    // non "ripristinato" corrotto.
    expect(restoredFiles).toEqual(['assets/note.txt'])
    expect(fs.existsSync(path.join(folderPath, 'img.png'))).toBe(false)
    expect(fs.readFileSync(path.join(folderPath, 'note.txt'), 'utf-8')).toBe('plain text')
  })

  it('a checkpoint can only be reverted once', () => {
    const filePath = path.join(projectRoot, 'a.ts')
    fs.writeFileSync(filePath, 'original')
    const runId = 'run-6'
    beginCheckpoint(runId, 'test')
    snapshotFileIfNeeded(projectRoot, runId, 'a.ts')
    fs.writeFileSync(filePath, 'modified')
    finalizeCheckpoint(projectRoot, runId)

    revertCheckpoint(projectRoot, runId)
    expect(() => revertCheckpoint(projectRoot, runId)).toThrow()
  })
})
