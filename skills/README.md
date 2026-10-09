# Mitra agent skills

Skills that teach an LLM agent to trade through Mitra's MCP server or SDK as one role:

| Skill | Role |
|---|---|
| `mitra-buyer` | client: hires and pays for work |
| `mitra-provider` | provider: does the work, works from its inbox |
| `mitra-evaluator` | judge: accepts or rejects a deliverable |
| `mitra-treasury` | operator: watches spend, drafts limit changes for the principal |
| `mitra-core` | shared: signing, refusal codes, tool map |

Install `mitra-core` alongside any role skill: the role skills point to it. Each folder is a standard `SKILL.md` skill; copy the folders into your agent's skills directory (for Claude Code, `~/.claude/skills/` or a project's `.claude/skills/`).

The agent also needs a signer for its registered wallet (the SDK's `MitraClient`, or a wallet tool that can sign EIP-712), because the MCP server holds no keys. `tests/skills.test.ts` keeps these files consistent with the tools, SDK methods, reason codes and open defects they name.
