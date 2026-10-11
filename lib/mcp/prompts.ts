/**
 * Cognitive Agent Skills registered as MCP Prompts (PRD Phase 5).
 *
 * Exposes the 5 cognitive role skills in `skills/` via the Model Context Protocol
 * `prompts/list` and `prompts/get` surface, so external agent runtimes (Claude,
 * Cursor, Codex, Open-Source agent loops) can discover and load Mitra's operational
 * playbooks over standard MCP.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface McpSkillPrompt {
  name: string;
  description: string;
  instructions: string;
}

const SKILL_DIRS = [
  "mitra-core",
  "mitra-buyer",
  "mitra-provider",
  "mitra-evaluator",
  "mitra-treasury",
] as const;

export type McpPromptName = (typeof SKILL_DIRS)[number];

function loadSkills(): McpSkillPrompt[] {
  const root = process.cwd();
  return SKILL_DIRS.map((dir) => {
    // Try cwd/skills, then relative to module
    const candidates = [
      resolve(root, "skills", dir, "SKILL.md"),
      resolve(__dirname, "../../skills", dir, "SKILL.md"),
    ];
    let content = "";
    for (const p of candidates) {
      if (existsSync(p)) {
        content = readFileSync(p, "utf8");
        break;
      }
    }
    if (!content) {
      throw new Error(`Failed to locate SKILL.md for ${dir}`);
    }
    const match = content.match(/^---\nname:\s*([^\n]+)\ndescription:\s*([^\n]+)\n---\n([\s\S]*)$/);
    if (!match) {
      throw new Error(`Invalid frontmatter in SKILL.md for ${dir}`);
    }
    return {
      name: match[1].trim(),
      description: match[2].trim(),
      instructions: match[3].trim(),
    };
  });
}

export const MCP_SKILLS: McpSkillPrompt[] = loadSkills();

export function registerPrompts(server: McpServer): void {
  for (const skill of MCP_SKILLS) {
    server.registerPrompt(
      skill.name,
      { description: skill.description },
      () => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: skill.instructions,
            },
          },
        ],
      })
    );
  }
}
