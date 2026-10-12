# In-App Onboarding Process & Writable Surfaces for Everyday Non-CLI Users

### The Core Mental Model: How It Should Carry for an Everyday Non-CLI User

• The Metaphor: It must feel like issuing a corporate card (like Brex or Ramp) for an AI employee, backed by programmable escrow.  
• The Emotional Tone: Quiet, institutional, and reassuring. No crypto slang, no cartoon mascots, no intimidating technical jargon.  
• The Cognitive Abstraction:  
    • The user never sees raw private keys, hex hashes, EIP-712 structs, or Solana PDA derivation seeds.  
    • Failures are never code stack traces. They are plain-English guardrail events:  
    e.g. “Blocked: Agent attempted to spend $45, exceeding your $20 single-task limit. Zero money moved.”  
    • Mathematical netting is not presented as an abstract graph algorithm; it is presented as a financial savings metric:  
    e.g. “Netting Engine active: Saved $140 in unnecessary transfers and fees today.”  
• Progressive Disclosure: The surface remains clean and intuitive (sliders, toggles, badges), while the underlying cryptographic proofs (calldata, signatures, receipts) remain accessible inside an expandable "Audit Details" drawer for compliance.  

---

### 2. The Step-by-Step Onboarding Process (Under 3 Minutes)

```
[ STEP 1: ONE-CLICK SIGN IN ]
  • Passkey, Google SSO (embedded smart wallet), or MetaMask / Phantom.
               │
               ▼
[ STEP 2: TREASURY DEPOSIT ]
  • Deposit collateral (e.g. 500 USDC) via card on-ramp or crypto wallet.
               │
               ▼
[ STEP 3: CREATE COMMERCIAL SPACE ]
  • Name the budget container (e.g. "Market Research & Growth").
  • Allocate a budget slice (e.g. $250 USDC).
               │
               ▼
[ STEP 4: ISSUE AGENT SPEND MANDATE ]
  • Set limits: $20/task max, $250 total ceiling, 30-day expiry.
  • Select/Type allowed capabilities (e.g. "research", "seo-audit").
               │
               ▼
[ STEP 5: VERIFY & CONNECT ]
  • 30-Second Simulator: Test an overspend attack (blocked) and valid job (settled).
  • 1-Click Copy: Agent MCP URL / Python snippet for Claude, Cursor, or ElizaOS.
```

---

### 3. What Should Be Exposed (Visible Telemetry & Real-Time Monitoring)

The non-CLI user needs continuous visibility over their money and their agents without being overwhelmed:

1. The Positional Capital Gauge:  
    • A clean visual progress bar showing exact funds distribution:  
        • Available: Money ready to be deployed ($250.00).  
        • Active in Escrow: Money locked while jobs are actively in progress ($45.00).  
        • Settled: Money finalized and paid out ($205.00).  
    • Status stamp: ✓ Reconciled to the atomic unit on Base & Solana.  
2. The "Agent Spend Card" Summary:  
    • Visual digital card showing:  
        • Cardholder: ResearchBot-01  
        • Budget Space: Market Research & Growth  
        • Remaining Headroom: $185.00 of $250.00 ceiling remaining  
        • Single-Task Cap: $20.00 max  
        • Status: Active  

3. Plain-English Activity Feed (Real-Time SSE):  
    • Actionable event log:  
        • "10 mins ago: Agent locked $15.00 in escrow with Provider Alpha (Task: seo-audit)."  
        • "8 mins ago: Deliverable submitted and verified. $15.00 released."  
        • "Receipt #4921 generated on Base Sepolia."  

4. Automated Refund Countdown:  
    • For active jobs, a visible reassurance timer:  
    "Auto-Refund Guarantee: If the counterparty does not deliver within 45 mins, funds return automatically."  
5. Netting Savings Counter:  
    • Live metric: "Multilateral Netting compressed $210 in gross agent trades into $60 net residuals. Saved 71% in capital velocity and gas."  
6. 1-Click Accounting Receipts:  
    • Printable/downloadable invoice with task description, deliverable proof hash, and direct Basescan / Solana Explorer verification links.  

---

### 4. What Should Be Writable (User Inputs, Sliders, and Controls)

The human principal retains absolute authority over spending limits and emergency controls:

1. Treasury Collateral Inputs:  
    • Network selector toggle: [ Base Sepolia ] · [ Solana Devnet ] · [ Tempo ].  
    • Deposit and withdrawal amount input fields (e.g. [ 500.00 USDC ]).  
2. Space Budget Modifiers:  
    • Space Name text field (e.g. "Procurement & Data").  
    • Budget allocation input or top-up slider.  
    • Allowed settlement chain checkboxes: [✓ Base] [✓ Solana] [ ] Tempo.  
3. Agent Mandate Controls:  
    • Single-Task Spend Cap Slider: e.g., Drag from $5 to $50.  
    • Total Monthly Ceiling Slider: e.g., Drag from $100 to $1,000.  
    • Expiration Calendar: Date picker (e.g., 30 days).  
    • Capability Inputs (Hybrid Pre-Set + Freeform Typing):  
        • Clickable pre-set chips: [✓ Web Research] [✓ Data Scraping].  
        • Freeform text input box: An open tag field where the user can type custom strings (e.g. seo-audit, api-call, translation) and hit Enter to lock them in.  
    • Privacy Switch: Toggle for "Keep spend rules confidential via Arcium MPC".  
4. The Master Emergency Panic Button (Global Header):  
    • A prominent switch: [ ⏸ Emergency Pause All Agents ]. One click immediately halts all autonomous spending across the organization without withdrawing funds.  
5. Agent Governance Actions:  
    • [ Reset Card / Bump Version ] Button: Instantly invalidates all pre-signed authorizations.  
    • [ Revoke Card ] Button: Cuts off the agent's spending power on-chain immediately.  
6. Dispute & Refund Interventions:  
    • [ Reject Deliverable ] Button: If submitted work is unacceptable, triggers the distributed saga compensation.  
    • [ Claim Timeout Refund ] Button: If a task is overdue, triggers the on-chain keeper refund, snapping 100% of escrowed funds back to the Available balance.  
7. Notification Integrations:  
    • An input field to paste a Slack or Discord Webhook URL for real-time mobile alerts whenever an agent spends or encounters an error.  

---

### 5. The "First Wow Moment" in the Process

To guarantee that an everyday user leaves the onboarding wizard with 100% trust, Step 5 features an Interactive In-App Sandbox Simulation:

1. Attack Simulation:  
    • User clicks [ Test Attack / Overspend ].  
    • A simulated rogue agent requests $60 (when the user set the limit to $20).  
    • The screen flashes a red refusal banner:  
    BLOCKED: Exceeds Single-Spend Limit ($60.00 > $20.00). Zero funds left the vault.  
2. Valid Task Simulation:  
    • User clicks [ Test Valid Task ].  
    • A simulated agent requests $15 for a typed capability (e.g. seo-audit).  
    • The screen animates in blue:  
    Budget Checked ✓ → Policy Approved ✓ → Escrow Locked ✓ → Deliverable Verified ✓ → Settled with Receipt ✓.  

The user experiences the core guarantee firsthand: Their AI agent is now free to operate autonomously across the internet, but it is mathematically impossible for it to drain their treasury.  

---

### The Core Finding

• The Backend Is Fully Writable: The protocol already has 12 mutating API endpoints (POST /api/v1/spaces, POST /api/v1/mandates, POST /api/v1/admin/pause, POST /api/v1/webhooks, POST /api/v1/intents, plus on-chain deposit, withdraw, setFrozen, and revokeMandate).  
• The Frontend Is Currently 100% Read-Only: Every single page in app/ (app/vaults/page.tsx, app/agents/page.tsx, app/policies/page.tsx, app/commerce/page.tsx) is currently an observer table. There are zero forms, zero deposit buttons, zero mandate issuers, and zero interactive sliders. Furthermore, there is no /spaces page in the UI navigation at all—Spaces exist exclusively in the backend!  

To turn Mitra into an application an everyday non-CLI user can actually use, here are the exact writable surfaces that must be exposed in the UI, screen by screen:  

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                             WRITABLE SURFACES REQUIRED IN-APP                                    │
├──────────────────────┬───────────────────────────────┬───────────────────────────────────────────┤
│ Screen               │ Current State in Code         │ Writable Surfaces Needed for Non-CLI User │
├──────────────────────┼───────────────────────────────┼───────────────────────────────────────────┤
│ 1. Header / Shell    │ Static breadcrumbs            │ • [ ⏸ Emergency Pause ] panic switch      │
│ 2. Vaults (/vaults)  │ Read-only table of vaults     │ • [ + Deposit Collateral ] modal          │
│                      │                               │ • [ Withdraw Collateral ] modal           │
│                      │                               │ • [ Freeze Vault ] toggle                 │
│ 3. Spaces (/spaces)  │ Missing from frontend UI!     │ • [ + Create Commercial Space ] form      │
│                      │                               │ • [ Top-Up Budget ] slider                │
│                      │                               │ • Custom Capability tag typing input      │
│ 4. Policies (/policies) Read-only table of mandates  │ • [ + Issue Agent Spend Card ] modal      │
│                      │                               │ • Single-task cap & ceiling sliders       │
│                      │                               │ • [ Bump Version ] & [ Revoke ] buttons   │
│ 5. Settings (/settings) Read-only debug info         │ • [ + Add Slack / Discord Alert ] form    │
│ 6. Commerce (/commerce) Read-only agreement table    │ • [ + Post Commercial RFQ ] task form     │
│                      │                               │ • [ Reject Deliverable ] dispute button   │
│                      │                               │ • [ Claim Timeout Refund ] keeper button  │
└──────────────────────┴───────────────────────────────┴───────────────────────────────────────────┘
```

---

### 1. Screen: Global Header Shell (components/app-shell.tsx)

The Emergency Safeguard Surface

• Currently in Code: Renders page title, breadcrumb, and navigation links.  
• The Writable Surface Needed:  
    • [ ⏸ Emergency Pause ] Toggle Switch: Positioned in the global header next to the network status pill.  
• What the Non-CLI User Does:  
    • One click prompts: "Pause all autonomous agent spending?"  
    • Requires an audit note: e.g. "Investigating unexpected API activity."  
• Wired Protocol Call: POST /api/v1/admin/pause with payload:  
  `{ "paused": true, "scopes": ["agreements", "funding", "execution"], "reason": "..." }`  
• User Effect: Instantly freezes all value routes across the protocol without withdrawing capital.  

---

### 2. Screen: Treasury Vaults (app/vaults/page.tsx)

The Collateral Funding Surface

• Currently in Code: An 8-line server component reading repo.listVaults() into `<table className="table">`.  
• The Writable Surfaces Needed:  
    1. [ + Deposit Collateral ] Modal:  
        • Inputs:  
            • Network dropdown: [ Base Sepolia (USDC) ] · [ Solana Devnet (Lamports) ] · [ Tempo (PathUSD) ].  
            • Amount input field: e.g. 500.00.  
            • Deposit button: Triggers standard wallet signature (MetaMask, Phantom, or embedded passkey).  
        • Wired Protocol Call: On-chain MitraVault.sol.deposit(token, amount) on Base / Tempo, or Anchor instruction on Solana.  
    2. [ Withdraw Collateral ] Modal:  
        • Inputs: Amount field, destination address.  
        • Wired Protocol Call: On-chain MitraVault.sol.withdraw(token, amount, to).  
    3. [ Emergency Freeze Vault ] Switch on each Vault row:  
        • Wired Protocol Call: On-chain setFrozen(token, true).  

---

### 3. Screen: Commercial Spaces (app/spaces/page.tsx — Must Be Added)

The Departmental Budget Firewall Surface

• Currently in Code: Handled in backend app/api/v1/spaces/route.ts, but completely absent from the frontend UI!  
• The Writable Surfaces Needed:  
    1. [ + Create Commercial Space ] Form:  
        • Space Name: Text input (e.g. "Market Intelligence & Research").  
        • Budget Allocation: Number input or slider (e.g. $250.00 USDC allocated from the Vault).  
        • Permitted Settlement Networks: Toggle pills: [✓ Base Sepolia] [✓ Solana Devnet] [ ] Tempo.  
        • Capability Input (Hybrid Pre-Set + Freeform Typing):  
            • Pre-set category chips: [✓ Web Research] [✓ Data Scraping].  
            • The Freeform Tag Input Box: An open input field where the user can type custom strings (e.g. seo-audit, twitter-analysis, code-review) and press Enter to badge them into allowedCapabilities.  
        • Admitted Agent Selector: Dropdown of registered agent keys.  
    2. Wired Protocol Call: POST /api/v1/spaces with payload:  
      ```json
      {
        "spaceId": "space_market_intelligence",
        "owner": "0x7823...",
        "budget": { "asset": "USDC", "amount": 250.0 },
        "allowedCapabilities": ["research", "data-scraping", "seo-audit"],
        "settlementChains": ["base", "solana"],
        "participants": ["0x7823...", "agent_buyer_live"]
      }
      ```

---

### 4. Screen: Policies & Mandates (app/policies/page.tsx)

The Agent Spend Card Issuance Surface

• Currently in Code: Displays a read-only table of active mandates and authorizations.  
• The Writable Surfaces Needed:  
    1. [ + Issue Agent Mandate ] / "New Spend Card" Modal:  
        • Agent Selector: Dropdown of registered agents (e.g. agent_buyer_live).  
        • Target Vault: Dropdown (e.g. Base Sepolia USDC Vault).  
        • Single-Task Spend Cap Slider: Slider with numeric input (e.g. $20.00 max per task).  
        • Total Monthly Ceiling Slider: Slider with numeric input (e.g. $250.00 max monthly spend).  
        • Expiry Date Picker: Calendar picker (e.g. 30 days).  
        • Arcium Privacy Toggle: Switch: "Evaluate spend rules privately via Arcium MPC".  
        • Wired Protocol Call: POST /api/v1/mandates (route.ts:50).  
    2. Mandate Table Row Actions:  
        • [ Bump Version / Reset Nonce ] Button: Bumps mandate version, instantly killing all outstanding pre-signed authorizations.  
        • [ Revoke Card ] Button: Immediately revokes the mandate on-chain via revokeMandate().  

---

### 5. Screen: Settings & Alerts (app/settings/page.tsx)

The Notification & Webhook Surface

• Currently in Code: Static environment displays.  
• The Writable Surfaces Needed:  
    1. [ + Add Alert Channel ] Form:  
        • Webhook URL: Text field for Slack Incoming Webhook, Discord Webhook, or PagerDuty URL.  
        • Event Subscriptions: Checkboxes:  
            • [✓] Escrow Locked (Task Started)  
            • [✓] Deliverable Settled (Money Paid)  
            • [✓] Overdue Task Refunded  
            • [✓] Security Alert (Attempted Overspend)  
        • Wired Protocol Call: POST /api/v1/webhooks with HMAC-SHA256 secret generation.  

---

### 6. Screen: Commerce & Recovery (app/commerce/page.tsx & /recovery)

The Human-in-the-Loop Intervention Surface

• Currently in Code: Read-only listing of agreements and sagas.  
• The Writable Surfaces Needed:  
    1. [ + Post Task Request ] (Manual RFQ Form):  
        • Inputs: Task Title, Price Cap (e.g. $45 USDC), Required Capability, Deadline.  
        • Wired Protocol Call: POST /api/v1/intents.  
    2. Agreement Inspector Drawer Actions:  
        • [ Reject Deliverable ] Button: Prompts for rejection reason; marks step failed and triggers automated saga compensation.  
        • [ Claim Timeout Refund ] Button: If an agent misses a deadline, this triggers the autonomous keeper sweep on-chain, refunding 100% of escrowed funds back to the user’s available balance.  

---

### Summary: What Connects This for Non-CLI Users

1. The Backend Is Ready: All 12 write handlers and validation schemas (zod) are already implemented and tested in app/api/v1/.  
2. The Missing Bridge: The frontend needs interactive UI wrappers (modals, forms, sliders, tag inputs, and panic buttons) so everyday non-developers can trigger these existing backend routes directly in the browser.  
3. The Result: A complete, self-serve Web3 clearinghouse console where an everyday founder can deposit funds, create a budget box, issue an agent card with typed capabilities, and retain 100% financial control.
