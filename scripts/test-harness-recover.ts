function tryRecoverToolCallFromText(content: string, availableTools: any[]): { id: string, function: { name: string, arguments: any } } | null {
  if (!content) return null
  const jsonBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  const targetStr = jsonBlockMatch ? jsonBlockMatch[1] : content
  const match = targetStr.match(/\{[\s\S]*"name"\s*:\s*"([^"]+)"[\s\S]*\}/)
  if (!match) return null

  const toolNames = new Set(availableTools.map(t => t.function.name))
  if (!toolNames.has(match[1])) return null

  try {
    const parsed = JSON.parse(match[0])
    if (!parsed.name || !toolNames.has(parsed.name)) return null
    const args = parsed.arguments ?? parsed.parameters ?? parsed.params ?? {}
    return { id: `recovered-${Date.now()}`, function: { name: parsed.name, arguments: args } }
  } catch {
    return null
  }
}

const mockTools = [
  { function: { name: 'edit_file', description: 'Edits a file' } },
  { function: { name: 'run_terminal_command', description: 'Runs command' } }
]

// Test 1: Standard markdown json fence with arguments
const test1 = 'Certamente! Ecco la chiamata per modificare il file:\n```json\n{\n  "name": "edit_file",\n  "arguments": {\n    "filePath": "index.ts",\n    "content": "hello"\n  }\n}\n```'
const res1 = tryRecoverToolCallFromText(test1, mockTools)
console.log('Test 1 (markdown json):', res1?.function?.name === 'edit_file' && res1?.function?.arguments?.filePath === 'index.ts' ? 'PASSED ✅' : 'FAILED ❌')

// Test 2: Standard parameters instead of arguments
const test2 = '{\n  "name": "run_terminal_command",\n  "parameters": {\n    "command": "ls"\n  }\n}'
const res2 = tryRecoverToolCallFromText(test2, mockTools)
console.log('Test 2 (parameters field):', res2?.function?.name === 'run_terminal_command' && res2?.function?.arguments?.command === 'ls' ? 'PASSED ✅' : 'FAILED ❌')

// Test 3: Normal text without tool calls
const test3 = 'Questa è solo una normale risposta di testo senza tool.'
const res3 = tryRecoverToolCallFromText(test3, mockTools)
console.log('Test 3 (no tools):', res3 === null ? 'PASSED ✅' : 'FAILED ❌')
