# Cognitive Agent Skills & Developer Tooling

> *"Agents need both deterministic APIs and cognitive playbooks to coordinate effectively."*  
> — [`skills/README.md`](../../skills/README.md) · [`scripts/doctor.ts`](../../scripts/doctor.ts)

Mitra provides a complete developer and runtime toolkit: **Cognitive Agent Skills** that guide LLM reasoning, and **Developer CLI Tools** that enable instant local testing, multi-agent simulation, and system verification.

---

## 1. The 5 Cognitive Agent Skills

Skills are modular, role-specific operational playbooks located in [`skills/`](../../skills/). They define how autonomous agents approach tasks, handle refusals, and structure outputs:

| Skill | Role | Key Operational Directives |
|---|---|---|
| **`mitra-core`** | Foundation / All | Cryptographic signing rules, EIP-712 domain schemas, and the complete Refusal Code decision matrix. Loaded before any signed operation. |
| **`mitra-buyer`** | Client Agent | How to read briefs, check headroom, request authorization (`ALLOW`), create and fund bilateral agreements, and track deliverables. |
| **`mitra-provider`** | Service Provider | How to poll `mitra_get_inbox`, acknowledge funded work (`startExecution`), compute artifact hashes, and submit deliverables before deadlines. |
| **`mitra-evaluator`** | Independent Judge | How to fetch submitted deliverables, independently compute hashes, test acceptance criteria, and sign `accept` or `reject`. |
| **`mitra-treasury`** | Risk Operator | How to monitor burn rates, track space headroom, audit open obligations, and draft mandate adjustments for principal approval. |

All 5 skills are registered directly on the MCP server and discoverable via `prompts/list`.

---

## 2. The `mitra doctor` Health Check

`npm run doctor` provides an honest, two-second diagnostic report of the entire local and remote infrastructure:

```bash
npm run doctor
```

### Sample Output:
```
✓ solana:devnet      rpc ok (slot 334192014)
✓ base:sepolia       rpc ok (block 19482910)
✓ base:mainnet       rpc ok (block 22091842)
✓ api:3005           ready (routes active)
✓ mcp:3006           ready (22 tools served)
⚠ tempo:moderato     rpc unconfigured (fail-closed)
```

The doctor command **never outputs a synthetic "OK"**. Every check reports live chain head block numbers or slot heights returned directly by external RPCs.

---

## 3. Unified Stack Supervisor (`scripts/stack.ts`)

Manage the entire local daemon stack with robust PID attribution:

```bash
# Start all daemons in the background
npm run stack:up

# Check process status and uptime
npm run stack:status

# Stop all supervised processes
npm run stack:down
```

### Kernel Start-Tick Attribution (`(pid, startTime)`):
To prevent accidental termination of unrelated processes if an OS recycles a PID, `stack.ts` verifies field 22 of `/proc/<pid>/stat` (clock ticks since system boot). A process is only signaled if both its PID and its kernel start time match the recorded session manifest.

---

## 4. Continuous Autonomous Multi-Agent Loop

Test real multi-agent coordination locally with three autonomous agents running over live HTTP inbox polling:

```bash
# Run 2 full cycles of the autonomous buyer-provider-evaluator loop
npm run agents:run -- --cycles 2
```

### Loop Mechanics:
1. `agent_buyer_live` polls inbox, requests authorization, opens an agreement, and funds escrow.
2. `agent_provider_live` detects the funded agreement in its inbox, starts execution, and submits a hashed deliverable.
3. `agent_evaluator_live` verifies the deliverable against acceptance criteria and signs acceptance.
4. Capital clears toward settlement, and all outcomes are verified back from the live API.

---

## Next Steps

- Access the machine-readable [LLMs Index (`/llms.txt`)](../llms.txt).
- Review the [Colosseum Submission Details](../SUBMISSION.md).
