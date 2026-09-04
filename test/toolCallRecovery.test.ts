import { describe, it, expect } from 'vitest'
import { tryRecoverToolCallFromText } from '../src/services/llm'

// Copre il recupero di una tool-call scritta come TESTO invece che come vero
// function-call — bug osservato dal vivo con modelli locali (qwen2.5-coder)
// sia in Agent Mode (electron/agent/harness.ts, logica identica, tenuta
// sincronizzata a mano) sia in chat normale (questo file, src/services/llm.ts).
const mockTools = [
  { function: { name: 'edit_file', description: 'Edits a file' } },
  { function: { name: 'ocr_image', description: 'OCR an image' } },
  { function: { name: 'run_terminal_command', description: 'Runs a command' } }
]

describe('tryRecoverToolCallFromText', () => {
  it('recovers a tool call from a raw JSON blob in the message text', () => {
    const text = '{"name": "ocr_image", "arguments": {"imagePath": "shot.png"}}'
    const res = tryRecoverToolCallFromText(text, mockTools)
    expect(res?.function.name).toBe('ocr_image')
    expect(res?.function.arguments).toEqual({ imagePath: 'shot.png' })
  })

  it('recovers a tool call wrapped in a ```json markdown fence with surrounding prose', () => {
    const text = 'Certamente! Ecco la chiamata:\n```json\n{\n  "name": "edit_file",\n  "arguments": {\n    "filePath": "index.ts",\n    "content": "hello"\n  }\n}\n```\nFatto.'
    const res = tryRecoverToolCallFromText(text, mockTools)
    expect(res?.function.name).toBe('edit_file')
    expect(res?.function.arguments.filePath).toBe('index.ts')
  })

  it('falls back to "parameters" or "params" when the model used that key instead of "arguments"', () => {
    const withParameters = '{"name": "run_terminal_command", "parameters": {"command": "ls"}}'
    expect(tryRecoverToolCallFromText(withParameters, mockTools)?.function.arguments).toEqual({ command: 'ls' })

    const withParams = '{"name": "run_terminal_command", "params": {"command": "pwd"}}'
    expect(tryRecoverToolCallFromText(withParams, mockTools)?.function.arguments).toEqual({ command: 'pwd' })
  })

  it('returns null for plain text with no tool call', () => {
    const text = 'Questa è solo una normale risposta di testo senza tool.'
    expect(tryRecoverToolCallFromText(text, mockTools)).toBeNull()
  })

  it('returns null when the JSON names a tool that is not in the available list (refuses to guess)', () => {
    const text = '{"name": "delete_everything", "arguments": {}}'
    expect(tryRecoverToolCallFromText(text, mockTools)).toBeNull()
  })

  it('returns null for malformed JSON that merely resembles a tool call', () => {
    const text = 'I was thinking about calling "name": "edit_file" but not in valid JSON {broken'
    expect(tryRecoverToolCallFromText(text, mockTools)).toBeNull()
  })

  it('returns null for empty/undefined content', () => {
    expect(tryRecoverToolCallFromText('', mockTools)).toBeNull()
    expect(tryRecoverToolCallFromText(undefined, mockTools)).toBeNull()
  })

  it('defaults arguments to an empty object when the tool call has none', () => {
    const text = '{"name": "run_terminal_command"}'
    const res = tryRecoverToolCallFromText(text, mockTools)
    expect(res?.function.arguments).toEqual({})
  })
})
