import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface HookDefinition {
  type: string;
  command: string;
  async?: boolean;
  timeout?: number;
}

export interface HookMatcher {
  matcher: string;
  hooks: HookDefinition[];
  description: string;
  id: string;
}

export interface EccHooksConfig {
  hooks: {
    PreToolUse?: HookMatcher[];
    PostToolUse?: HookMatcher[];
    PostToolUseFailure?: HookMatcher[];
    SessionStart?: HookMatcher[];
    SessionEnd?: HookMatcher[];
    Stop?: HookMatcher[];
  };
}

export class EccHookEngine {
  private config: EccHooksConfig | null = null;
  private projectRoot: string;

  /** projectRoot: la cwd del progetto correntemente aperto — gli hook si cercano
   *  in <projectRoot>/.code-ide/hooks.json e i comandi girano con quella cwd. */
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.loadHooks();
  }

  private loadHooks() {
    try {
      const hooksPath = path.join(this.projectRoot, '.code-ide', 'hooks.json');
      if (fs.existsSync(hooksPath)) {
        const data = fs.readFileSync(hooksPath, 'utf8');
        this.config = JSON.parse(data);
        console.log(`[EccHookEngine] Loaded hooks from ${hooksPath}`);
      }
      // Nessun hooks.json è la norma (progetto senza hook configurati): non è un
      // errore, quindi niente warning rumoroso ad ogni singolo task dell'agente.
    } catch (e) {
      console.error(`[EccHookEngine] Error loading hooks:`, e);
    }
  }

  private matchTool(matcher: string, toolName: string): boolean {
    if (matcher === '*') return true;
    const parts = matcher.split('|');
    return parts.includes(toolName);
  }

  public async dispatch(
    eventName: keyof EccHooksConfig['hooks'],
    toolName: string = '*',
    context: any = {}
  ): Promise<void> {
    if (!this.config?.hooks[eventName]) return;

    const matchers = this.config.hooks[eventName]!;
    
    for (const matcherDef of matchers) {
      if (this.matchTool(matcherDef.matcher, toolName)) {
        console.log(`[EccHookEngine] Triggering hook ${matcherDef.id} for event ${eventName}`);
        
        for (const hook of matcherDef.hooks) {
          if (hook.type === 'command' && hook.command) {
            try {
              const env = {
                ...process.env,
                CODE_IDE_PROJECT_ROOT: this.projectRoot,
                ECC_CONTEXT: JSON.stringify(context)
              };

              if (hook.async) {
                // Fire and forget
                exec(hook.command, { env, cwd: this.projectRoot, timeout: (hook.timeout || 30) * 1000 }, (error, stdout, stderr) => {
                  if (error) {
                    console.error(`[EccHookEngine] Async hook ${matcherDef.id} failed:`, error);
                  }
                  if (stdout) console.log(`[EccHookEngine] Async hook ${matcherDef.id} stdout:`, stdout);
                  if (stderr) console.error(`[EccHookEngine] Async hook ${matcherDef.id} stderr:`, stderr);
                });
              } else {
                // Synchronous execution (wait for completion)
                console.log(`[EccHookEngine] Running sync hook: ${hook.command}`);
                const { stdout, stderr } = await execAsync(hook.command, {
                  env,
                  cwd: this.projectRoot,
                  timeout: (hook.timeout || 30) * 1000
                });
                if (stdout) console.log(`[EccHookEngine] Hook ${matcherDef.id} stdout:`, stdout);
                if (stderr) console.error(`[EccHookEngine] Hook ${matcherDef.id} stderr:`, stderr);
              }
            } catch (err: any) {
              console.error(`[EccHookEngine] Sync hook ${matcherDef.id} error:`, err.message);
              // In PreToolUse, a failure might mean we should block execution, but we'll log for now
              // to prevent the IDE from completely crashing if a hook is broken.
            }
          }
        }
      }
    }
  }
}
