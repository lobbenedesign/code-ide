import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// electron/agent/memory.ts calcola MEMORY_DB_PATH da process.env.HOME come
// COSTANTE DI MODULO — va impostato PRIMA dell'import e il modulo va
// ricaricato (vi.resetModules) per ogni test, altrimenti tutti i test
// condividerebbero lo stesso ~/.code-ide-memory.db reale dell'utente.
describe('memory: save/get/forget', () => {
  let tmpHome: string
  let memoryModule: typeof import('../electron/agent/memory')

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ide-memory-test-'))
    vi.resetModules()
    vi.stubEnv('HOME', tmpHome)
    memoryModule = await import('../electron/agent/memory')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('forget_memory (deleteMemory) removes a saved memory and it no longer appears in getProjectMemories', () => {
    const { saveMemory, getProjectMemories, deleteMemory } = memoryModule
    saveMemory('/project/a', 'stile_css', 'usa Tailwind')
    saveMemory('/project/a', 'stack', 'React + TS')

    expect(getProjectMemories('/project/a').map(m => m.key).sort()).toEqual(['stack', 'stile_css'])

    const removed = deleteMemory('/project/a', 'stile_css')
    expect(removed).toBe(true)

    const remaining = getProjectMemories('/project/a')
    expect(remaining.map(m => m.key)).toEqual(['stack'])
  })

  it('deleteMemory returns false (not an error) when the key does not exist', () => {
    const { deleteMemory } = memoryModule
    expect(deleteMemory('/project/a', 'non_esiste')).toBe(false)
  })

  it('memories are scoped per project: deleting in one project does not affect another', () => {
    const { saveMemory, getProjectMemories, deleteMemory } = memoryModule
    saveMemory('/project/a', 'stack', 'React')
    saveMemory('/project/b', 'stack', 'Vue')

    deleteMemory('/project/a', 'stack')

    expect(getProjectMemories('/project/a')).toEqual([])
    expect(getProjectMemories('/project/b')).toEqual([{ key: 'stack', value: 'Vue' }])
  })
})
