import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const TestPluginToolDefinition = {
  type: 'function',
  function: {
    name: 'run_and_verify_tests',
    description: 'Runs project unit tests and ensures they pass before continuing. Use this to perform Test-Driven Development (TDD). Automatically runs npm test or equivalent based on package.json.',
    parameters: {
      type: 'object',
      properties: {
        testCommand: {
          type: 'string',
          description: 'The test command to run, e.g., "npm test" or "npx vitest run". Defaults to "npm test"'
        }
      }
    }
  }
}

export async function executeTestVerify(args: { testCommand?: string }, cwd: string): Promise<string> {
  const command = args.testCommand || 'npm test'
  
  try {
    const { stdout } = await execAsync(command, { cwd })
    return `TESTS PASSED ✅\n\nOutput:\n${stdout}`
  } catch (error: any) {
    return `TESTS FAILED ❌\n\nOutput:\n${error.stdout}\n\nError:\n${error.stderr}\n\nPer favore, analizza l'errore e aggiusta il codice finchè i test non passano.`
  }
}
