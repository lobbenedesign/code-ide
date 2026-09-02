export interface Skill {
  id: string;
  name: string;
  description: string;
  trigger_keywords: string[];
  system_prompt_injection: string;
  active: boolean;
}

export class SkillManager {
  private skills: Map<string, Skill>;

  constructor() {
    this.skills = new Map();
  }

  // Carica le skill fisicamente dalla cartella src/skills DELL'APP (non del
  // progetto eventualmente aperto nell'explorer): usa get-app-root, affidabile
  // sia in dev che in build pacchettizzata (process.cwd() lo era solo per
  // coincidenza in dev).
  public async init(_projectRootPath: string) {
    try {
      // @ts-ignore
      const appRootRes = await window.ipcRenderer.invoke('get-app-root')
      const appRoot = appRootRes?.success ? appRootRes.data : ''

      // @ts-ignore
      const result = await window.ipcRenderer.invoke('read-dir', appRoot + '/src/skills')
      if (result && result.success) {
        for (const file of result.data) {
          if (!file.name.endsWith('.json')) continue

          // @ts-ignore
          const fileRes = await window.ipcRenderer.invoke('read-file', file.path)
          if (!fileRes.success) continue

          try {
            const raw = JSON.parse(fileRes.data)
            const id = file.name.replace(/\.json$/, '')
            this.skills.set(id, {
              id,
              name: raw.name || id,
              description: raw.description || '',
              trigger_keywords: Array.isArray(raw.trigger_keywords) ? raw.trigger_keywords : [],
              system_prompt_injection: raw.system_prompt_injection || '',
              active: false
            })
          } catch (parseErr) {
            console.error(`Skill malformata (JSON non valido): ${file.name}`, parseErr)
          }
        }
      }
    } catch (e) {
      console.error('Errore nel caricamento reale delle skill:', e)
    }
  }

  /**
   * Attiva le skill i cui trigger_keywords compaiono nel messaggio dell'utente
   * e/o nel contesto del file attualmente aperto (percorso + contenuto).
   * Il matching è case-insensitive e a costo trascurabile: nessuna chiamata
   * esterna, nessun embedding, adatto a una libreria di skill di questa scala.
   */
  public analyzeContext(userMessage: string, currentFilePath: string, fileContent: string) {
    const haystack = `${userMessage}\n${currentFilePath}\n${fileContent}`.toLowerCase()

    for (const skill of this.skills.values()) {
      skill.active = skill.trigger_keywords.some(kw => haystack.includes(kw.toLowerCase()))
    }
  }

  public activateSkill(id: string) {
    const skill = this.skills.get(id);
    if (skill) {
      skill.active = true;
    }
  }

  public deactivateSkill(id: string) {
    const skill = this.skills.get(id);
    if (skill) {
      skill.active = false;
    }
  }

  public getActiveSkills(): Skill[] {
    return Array.from(this.skills.values()).filter(s => s.active);
  }

  public getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  public generateSystemPromptInject(): string {
    const activeSkills = this.getActiveSkills();
    if (activeSkills.length === 0) return "";

    let prompt = "=========================================\n";
    prompt += "ACTIVE SKILLS (FOLLOW THESE STRICTLY):\n";
    activeSkills.forEach(skill => {
      prompt += skill.system_prompt_injection;
    });
    prompt += "=========================================\n";

    return prompt;
  }
}

// Export a singleton instance for global use in the IDE frontend
export const skillManager = new SkillManager();
