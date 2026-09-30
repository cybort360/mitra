const state = {
  selectedEvent: null,
};

const runs = [
  { id: 'RUN-501', name: 'Research 100 crypto projects', agent: 'buyer-07', amount: '$50.00', state: 'recovering', provider: 'Virtuals', updated: '2m ago' },
  { id: 'RUN-498', name: 'Index market data', agent: 'data-03', amount: '$24.80', state: 'settling', provider: 'x402', updated: '5m ago' },
  { id: 'RUN-492', name: 'Evaluate yield routes', agent: 'buyer-02', amount: '$80.00', state: 'active', provider: 'Olas', updated: '11m ago' },
  { id: 'RUN-488', name: 'Extract governance proposals', agent: 'research-04', amount: '$16.00', state: 'clearing', provider: 'Agentverse', updated: '18m ago' },
  { id: 'RUN-481', name: 'Price volatility dataset', agent: 'data-01', amount: '$32.40', state: 'settled', provider: 'x402', updated: '31m ago' },
];

const activities = [
  { symbol: 'R', title: 'Reservation created', meta: 'RUN-501 · $12.40 USDC · Vault SOL-01', time: '2m' },
  { symbol: '!', title: 'Provider timeout', meta: 'RUN-501 · Virtuals provider agt_18f3', time: '4m' },
  { symbol: '↺', title: 'TALOS recovery started', meta: 'RUN-501 · route retry-reassign-v2', time: '4m' },
  { symbol: '≋', title: 'Clearing epoch finalized', meta: 'EPOCH-042 · 17 obligations · $1,842 gross', time: '7m' },
  { symbol: '✓', title: 'Settlement confirmed', meta: 'SET-913 · 7.20 USDC · Solana devnet', time: '8m' },
];

const timeline = [
  { id: 'evt-01', time: '10:01:04', tone: 'ok', title: 'Mandate V7 activated', meta: 'Principal approved bounded authority for buyer-07', tag: 'AUTHORITY', type: 'Mandate activated', description: 'A new versioned mandate became active for the initiating agent.', fields: { 'Mandate': 'MND-7F21', 'Agent': 'buyer-07', 'Budget': '$50.00 USDC', 'Max tx': '$15.00 USDC', 'Expires': '2026-09-30 18:00 WAT', 'Policy version': 'policy-v3.4' }, hash: '0x46a1…9e0d' },
  { id: 'evt-02', time: '10:02:12', tone: 'ok', title: 'Intent created', meta: 'Research 100 crypto projects · budget $50.00', tag: 'INTENT', type: 'Intent created', description: 'The agent proposed a commercial objective under Mandate V7.', fields: { 'Intent': 'INT-501', 'Objective': 'Research 100 crypto projects', 'Budget ceiling': '$50.00 USDC', 'Chain': 'Solana', 'Initiator': 'buyer-07' }, hash: '0x21bb…0ad1' },
  { id: 'evt-03', time: '10:03:45', tone: 'ok', title: 'Provider discovered', meta: 'Virtuals · research-agent-18 · quoted $12.00', tag: 'DISCOVERY', type: 'Provider discovered', description: 'Marketplace adapter normalized an external provider candidate.', fields: { 'Marketplace': 'Virtuals ACP', 'External agent': 'research-agent-18', 'Quote': '$12.00 USDC', 'Capability': 'market_research', 'Settlement': 'Solana' }, hash: '0x0d7e…af22' },
  { id: 'evt-04', time: '10:04:03', tone: 'ok', title: '$12.40 reservation created', meta: 'Available capital reduced before commitment', tag: 'VAULT', type: 'Spend reservation', description: 'Capital was reserved before the action could create a financial commitment.', fields: { 'Reservation': 'RSV-91C4', 'Vault': 'VLT-SOL-01', 'Amount': '$12.40 USDC', 'Available before': '$42,918.60', 'Available after': '$42,906.20', 'Expires': '10:19:03 WAT' }, hash: '0x6c91…3fe7' },
  { id: 'evt-05', time: '10:04:08', tone: 'ok', title: 'Policy returned ALLOW', meta: 'Action digest bound to mandate, vault and reservation', tag: 'POLICY', type: 'Authorization decision', description: 'The proposed action satisfied the current mandate and policy constraints.', fields: { 'Decision': 'ALLOW', 'Mandate': 'MND-7F21 v7', 'Vault': 'VLT-SOL-01', 'Reservation': 'RSV-91C4', 'Amount ceiling': '$12.40 USDC', 'Counterparty': 'research-agent-18' }, hash: '0x7380…b117' },
  { id: 'evt-06', time: '10:05:17', tone: 'ok', title: 'Agreement funded', meta: '$12.00 committed · $0.40 metering ceiling retained', tag: 'COMMERCE', type: 'Agreement funded', description: 'The commercial agreement moved from authorized to funded.', fields: { 'Agreement': 'AGR-77', 'Provider': 'research-agent-18', 'Escrow': '$12.00 USDC', 'Metering ceiling': '$0.40 USDC', 'Acceptance': 'schema + coverage + citations' }, hash: '0x5a44…7bd9' },
  { id: 'evt-07', time: '10:08:51', tone: 'blue', title: 'x402 payment settled', meta: '$0.40 paid for data resource session', tag: 'PAYMENT', type: 'Payment session', description: 'A bounded payment session consumed part of the authorized reservation.', fields: { 'Protocol': 'x402 V2', 'Amount': '$0.40 USDC', 'Resource': '/v1/market-data', 'Reservation': 'RSV-91C4', 'Status': 'SETTLED' }, hash: '0x1aee…f920' },
  { id: 'evt-08', time: '10:10:22', tone: 'bad', title: 'Provider timed out', meta: 'Execution deadline exceeded by 22s', tag: 'FAILURE', type: 'Execution failed', description: 'The primary provider did not complete within the bounded execution window.', fields: { 'Provider': 'research-agent-18', 'Agreement': 'AGR-77', 'Failure': 'PROVIDER_TIMEOUT', 'Deadline': '10:10:00 WAT', 'Observed': '10:10:22 WAT' }, hash: '0xb334…d8a1' },
  { id: 'evt-09', time: '10:10:23', tone: 'warn', title: 'TALOS recovery activated', meta: 'Committed route: retry once → reassign', tag: 'RECOVERY', type: 'Saga recovery', description: 'The failure transitioned into the pre-authorized recovery route.', fields: { 'Saga': 'SAGA-501', 'Route': 'retry-reassign-v2', 'Attempt': '1 / 2', 'Max recovery spend': '$1.50 USDC', 'Terminal states': 'RECOVERED · CONTAINED · ABORTED' }, hash: '0xd399…4c50' },
  { id: 'evt-10', time: '10:11:09', tone: 'warn', title: 'Backup provider assigned', meta: 'Olas · mech-research-09 · $11.20 quote', tag: 'RECOVERY', type: 'Provider reassigned', description: 'A backup provider matching the committed constraints was selected.', fields: { 'Provider': 'mech-research-09', 'Marketplace': 'Olas', 'Quote': '$11.20 USDC', 'Authority': 'inherited within recovery ceiling', 'Saga': 'SAGA-501' }, hash: '0x6e2c…0f19' },
  { id: 'evt-11', time: '10:16:40', tone: 'ok', title: 'Deliverable accepted', meta: 'Evaluator passed 9 / 9 deterministic checks', tag: 'VERIFY', type: 'Deliverable accepted', description: 'The recovery provider completed the work and met acceptance criteria.', fields: { 'Deliverable': 'DLV-8AA2', 'Evaluator': 'eval-02', 'Checks': '9 / 9', 'Provider': 'mech-research-09', 'Result': 'ACCEPT' }, hash: '0x774f…aa82' },
  { id: 'evt-12', time: '10:18:04', tone: 'ok', title: '$11.60 obligation recorded', meta: 'Provider $11.20 + service payment $0.40', tag: 'OBLIGATION', type: 'Obligation created', description: 'The accepted commercial outcome produced a settlement obligation.', fields: { 'Obligation': 'OBL-1842', 'Debtor': 'VLT-SOL-01', 'Creditor': 'mech-research-09', 'Amount': '$11.60 USDC', 'Status': 'DUE' }, hash: '0x234b…f110' },
  { id: 'evt-13', time: '10:20:31', tone: 'blue', title: 'Clearing epoch finalized', meta: 'EPOCH-042 · residual transfer $7.20', tag: 'CLEARING', type: 'Clearing finalized', description: 'Reciprocal obligations were netted and the residual settlement vector was finalized.', fields: { 'Epoch': 'EPOCH-042', 'Gross volume': '$1,842.40', 'Net movement': '$617.80', 'Run residual': '$7.20 USDC', 'Input obligations': '17', 'Excluded': '1 disputed' }, hash: '0xa5cd…c381' },
  { id: 'evt-14', time: '10:21:12', tone: 'ok', title: '$7.20 USDC settlement confirmed', meta: 'Solana devnet · final residual movement only', tag: 'SETTLEMENT', type: 'Settlement confirmed', description: 'The residual transfer was executed and linked to the finalized clearing result.', fields: { 'Settlement': 'SET-913', 'Amount': '$7.20 USDC', 'Chain': 'Solana devnet', 'Epoch': 'EPOCH-042', 'Obligation': 'OBL-1842', 'Status': 'SETTLED' }, hash: '4nW2j9b…3LkP' },
];

const searchItems = [
  { label: 'RUN-501 · Research 100 crypto projects', sub: 'Recovering · buyer-07', type: 'Run', route: '#run-501', icon: 'R' },
  { label: 'VLT-SOL-01 · Primary operating vault', sub: 'Solana · USDC', type: 'Vault', route: '#vault-sol-01', icon: 'V' },
  { label: 'buyer-07', sub: 'Buyer Agent · active', type: 'Agent', route: '#agents', icon: 'A' },
  { label: 'MND-7F21 · Mandate V7', sub: '$50 budget · $15 max tx', type: 'Policy', route: '#policies', icon: 'P' },
  { label: 'EPOCH-042', sub: '17 obligations · finalized', type: 'Clearing', route: '#clearing', icon: 'C' },
  { label: 'SET-913', sub: '7.20 USDC · Solana devnet', type: 'Receipt', route: '#settlements', icon: 'S' },
];

function money(v) { return v; }
function status(s) { return `<span class="status ${s}">${s}</span>`; }

function setBreadcrumb(label) { document.getElementById('breadcrumb').textContent = `Console / ${label}`; }
function setActiveNav(route) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.route === route));
}

function overviewView() {
  setBreadcrumb('Overview'); setActiveNav('overview');
  return `
    <div class="page-header">
      <div><div class="eyebrow">Economic control plane</div><h1>Overview</h1><p class="page-subtitle">Capital, authority and autonomous commerce in one operational view.</p></div>
      <div class="page-actions"><button class="secondary-button" data-action="export">Export evidence</button><button class="primary-button" data-route-link="run-501">Inspect live run</button></div>
    </div>

    <div class="metric-grid">
      <div class="metric"><div class="metric-label">Controlled capital</div><div class="metric-value">$142,800</div><div class="metric-foot">Across 4 active vaults</div></div>
      <div class="metric"><div class="metric-label">Available to agents</div><div class="metric-value">$91,240</div><div class="metric-foot">63.9% of controlled capital</div><div class="metric-bar"><span style="width:63.9%"></span></div></div>
      <div class="metric"><div class="metric-label">Reserved</div><div class="metric-value">$18,420</div><div class="metric-foot">26 active spend reservations</div></div>
      <div class="metric"><div class="metric-label">Net exposure</div><div class="metric-value">$8,714</div><div class="metric-foot">$31,280 gross obligations</div></div>
    </div>

    <div class="notice"><span>ⓘ</span><div><strong>Mitra separates controlled capital from spendable capital.</strong> Agents can only consume capital through a valid mandate, reservation and execution guard.</div></div>

    <div class="layout-two">
      <div class="panel">
        <div class="panel-head"><div><span class="panel-title">Active economic runs</span><span class="panel-subtitle">Intent → settlement</span></div><button class="panel-link" data-route-link="runs">View all</button></div>
        <table class="data-table"><thead><tr><th>Run</th><th>Agent</th><th>Budget</th><th>State</th><th>Updated</th></tr></thead><tbody>
        ${runs.map(r => `<tr class="clickable" data-route-link="${r.id === 'RUN-501' ? 'run-501' : 'runs'}"><td><div class="entity-cell"><span class="entity-icon">${r.id.slice(-3)}</span><span class="entity-meta"><strong>${r.name}</strong><small class="mono">${r.id} · ${r.provider}</small></span></div></td><td class="mono">${r.agent}</td><td class="mono">${r.amount}</td><td>${status(r.state)}</td><td>${r.updated}</td></tr>`).join('')}
        </tbody></table>
      </div>

      <div class="panel">
        <div class="panel-head"><div><span class="panel-title">Economic activity</span><span class="panel-subtitle">Canonical events</span></div><button class="panel-link" data-route-link="evidence">Evidence</button></div>
        <div class="activity-list">${activities.map(a => `<div class="activity-row"><div class="activity-symbol">${a.symbol}</div><div class="activity-body"><strong>${a.title}</strong><small>${a.meta}</small></div><span class="activity-time">${a.time}</span></div>`).join('')}</div>
      </div>
    </div>

    <div class="section-grid" style="margin-top:16px">
      <div class="mini-card"><div class="top"><h3>Vault health</h3>${status('active')}</div><p>No conservation or reconciliation exceptions.</p><div class="mini-card-value">4 / 4</div><div class="metric-foot">vaults reconciled</div></div>
      <div class="mini-card"><div class="top"><h3>Recovery</h3>${status('recovering')}</div><p>One run is executing a committed compensation route.</p><div class="mini-card-value">1</div><div class="metric-foot">active saga</div></div>
      <div class="mini-card"><div class="top"><h3>Clearing efficiency</h3>${status('active')}</div><p>Gross obligations reduced before settlement.</p><div class="mini-card-value">66.5%</div><div class="metric-foot">value movement avoided</div></div>
    </div>`;
}

function vaultView() {
  setBreadcrumb('Vaults / VLT-SOL-01'); setActiveNav('vaults');
  return `
    <div class="page-header">
      <div><div class="eyebrow mono">VLT-SOL-01 · SOLANA</div><h1>Primary operating vault</h1><p class="page-subtitle">Capital boundary for autonomous execution. Owner withdrawal authority is separate from agent spend authority.</p></div>
      <div class="page-actions"><button class="secondary-button" data-action="copy-vault">Copy vault ID</button><button class="primary-button" data-action="freeze">Emergency freeze</button></div>
    </div>

    <div class="summary-strip">
      <div class="summary-cell"><label>Principal</label><strong>mitra-labs</strong><small>owner authority</small></div>
      <div class="summary-cell"><label>Network</label><strong>Solana devnet</strong><small>USDC</small></div>
      <div class="summary-cell"><label>Active mandates</label><strong>7</strong><small>3 agents</small></div>
      <div class="summary-cell"><label>Emergency state</label><strong>Unfrozen</strong><small>no incident controls active</small></div>
    </div>

    <div class="detail-grid">
      <div>
        <div class="panel">
          <div class="panel-head"><div><span class="panel-title">Capital position</span><span class="panel-subtitle">Authoritative economic state</span></div><span class="mono" style="font-size:9px;color:var(--muted)">as of 17:24:09</span></div>
          <div class="capital-stack">
            <div class="capital-hero"><div><div class="amount-label">TOTAL CONTROLLED BALANCE</div><div class="amount">$68,420.00</div></div><div><div class="amount-label">ACTUALLY SPENDABLE</div><div class="amount" style="font-size:24px">$42,906.20</div></div></div>
            <div class="capital-parts" aria-label="Capital allocation"><span class="available" style="width:62.71%"></span><span class="reserved" style="width:11.72%"></span><span class="escrowed" style="width:15.49%"></span><span class="encumbered" style="width:6.28%"></span><span class="settling" style="width:3.8%"></span></div>
            <div class="capital-legend">
              <div class="capital-legend-item"><label><span class="legend-dot" style="background:#9fb8a5"></span>Available</label><strong>$42,906.20</strong></div>
              <div class="capital-legend-item"><label><span class="legend-dot" style="background:#d9bd83"></span>Reserved</label><strong>$8,018.40</strong></div>
              <div class="capital-legend-item"><label><span class="legend-dot" style="background:#9caec4"></span>Escrowed</label><strong>$10,597.60</strong></div>
              <div class="capital-legend-item"><label><span class="legend-dot" style="background:#c6b3ad"></span>Encumbered</label><strong>$4,297.80</strong></div>
              <div class="capital-legend-item"><label><span class="legend-dot" style="background:#b4b5ae"></span>Settling</label><strong>$2,600.00</strong></div>
            </div>
          </div>
        </div>

        <div class="panel" style="margin-top:16px">
          <div class="panel-head"><div><span class="panel-title">Active reservations</span><span class="panel-subtitle">Capital locked before commitment</span></div><button class="panel-link">26 total</button></div>
          <table class="data-table"><thead><tr><th>Reservation</th><th>Intent</th><th>Agent</th><th>Amount</th><th>Status</th></tr></thead><tbody>
            <tr class="clickable" data-route-link="run-501"><td class="mono">RSV-91C4</td><td>Research 100 crypto projects</td><td class="mono">buyer-07</td><td class="mono">$12.40</td><td>${status('reserved')}</td></tr>
            <tr><td class="mono">RSV-90FF</td><td>Index market data</td><td class="mono">data-03</td><td class="mono">$25.20</td><td>${status('reserved')}</td></tr>
            <tr><td class="mono">RSV-8EC2</td><td>Evaluate yield routes</td><td class="mono">buyer-02</td><td class="mono">$80.00</td><td>${status('active')}</td></tr>
          </tbody></table>
        </div>
      </div>

      <div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Authority boundary</span>${status('active')}</div>
          <div class="inspector-body">
            <div class="kv"><label>Vault controller</label><div class="mono">MitraVaultProgram</div></div>
            <div class="kv"><label>Principal withdrawal</label><div>Owner + recovery authority only</div></div>
            <div class="kv"><label>Agent execution</label><div>Mandate + reservation + guard</div></div>
            <div class="kv"><label>Allowed asset</label><div class="mono">USDC</div></div>
            <div class="kv"><label>Reservations</label><div>Mandatory for consequential spend</div></div>
            <div class="kv"><label>Reconciliation</label><div>${status('active')} <span style="margin-left:5px">0 exceptions</span></div></div>
          </div>
        </div>
        <div class="notice"><span>!</span><div><strong>Why this matters:</strong> a policy ALLOW does not move money. Execution must still consume the exact approved reservation through the vault guard.</div></div>
      </div>
    </div>`;
}

function runView() {
  setBreadcrumb('Runs / RUN-501'); setActiveNav('runs');
  const selected = timeline.find(e => e.id === state.selectedEvent);
  return `
    <div class="page-header">
      <div><div class="eyebrow mono">RUN-501 · RECOVERY PATH</div><h1>Research 100 crypto projects</h1><p class="page-subtitle">One autonomous economic interaction from intent through final settlement.</p></div>
      <div class="page-actions"><button class="secondary-button" data-action="copy-run">Copy run ID</button><button class="primary-button" data-action="pause-run">Pause run</button></div>
    </div>

    <div class="summary-strip">
      <div class="summary-cell"><label>Budget</label><strong>$50.00 USDC</strong><small>Mandate V7</small></div>
      <div class="summary-cell"><label>Reserved</label><strong>$12.40 USDC</strong><small>RSV-91C4</small></div>
      <div class="summary-cell"><label>Spendable after reserve</label><strong>$37.60 USDC</strong><small>run-local ceiling</small></div>
      <div class="summary-cell"><label>Run state</label><strong style="margin-bottom:5px">${status('recovering')}</strong><small>SAGA-501</small></div>
    </div>

    <div class="detail-grid">
      <div class="panel">
        <div class="panel-head"><div><span class="panel-title">Economic timeline</span><span class="panel-subtitle">canonical receipt-backed events</span></div><button class="panel-link" data-action="verify-chain">Verify chain</button></div>
        <div class="timeline">
          ${timeline.map(e => `<div class="timeline-event ${state.selectedEvent === e.id ? 'selected' : ''}" data-event-id="${e.id}"><div class="timeline-time">${e.time}</div><div class="timeline-node ${e.tone}"></div><div class="timeline-copy"><strong>${e.title}</strong><small>${e.meta}</small></div><span class="timeline-tag">${e.tag}</span></div>`).join('')}
        </div>
      </div>
      <div class="panel inspector" id="inspector">
        <div class="panel-head"><span class="panel-title">Event inspector</span>${selected ? `<span class="mono" style="font-size:9px;color:var(--muted)">${selected.time}</span>` : ''}</div>
        ${selected ? eventInspector(selected) : `<div class="inspector-empty"><div><span>⌁</span><strong>Select an event</strong><div style="font-size:10px;margin-top:4px">Inspect authority, economic state, receipts and evidence.</div></div></div>`}
      </div>
    </div>`;
}

function eventInspector(e) {
  return `<div class="inspector-body"><div class="inspector-type">${e.type}</div><div class="inspector-title">${e.title}</div><div class="inspector-desc">${e.description}</div>${Object.entries(e.fields).map(([k,v]) => `<div class="kv"><label>${k}</label><div>${v}</div></div>`).join('')}<div class="kv"><label>Receipt hash</label><div><span class="hash">${e.hash}</span></div></div><div style="display:flex;gap:7px;margin-top:14px"><button class="secondary-button" data-action="copy-receipt">Copy receipt</button><button class="secondary-button" data-action="open-evidence">Evidence</button></div></div>`;
}

function runsView() {
  setBreadcrumb('Runs'); setActiveNav('runs');
  return `<div class="page-header"><div><div class="eyebrow">Autonomous economic interactions</div><h1>Runs</h1><p class="page-subtitle">Track every intent from authorization and execution through recovery, clearing and settlement.</p></div><div class="page-actions"><button class="primary-button" data-action="new-run">New run</button></div></div><div class="panel"><div class="panel-head"><span class="panel-title">All runs</span><span class="mono" style="font-size:9px;color:var(--muted)">8 active · 214 total</span></div><table class="data-table"><thead><tr><th>Run</th><th>Agent</th><th>Provider</th><th>Budget</th><th>State</th><th>Updated</th></tr></thead><tbody>${runs.map(r => `<tr class="clickable" data-route-link="${r.id==='RUN-501'?'run-501':'runs'}"><td><div class="entity-cell"><span class="entity-icon">${r.id.slice(-3)}</span><span class="entity-meta"><strong>${r.name}</strong><small class="mono">${r.id}</small></span></div></td><td class="mono">${r.agent}</td><td>${r.provider}</td><td class="mono">${r.amount}</td><td>${status(r.state)}</td><td>${r.updated}</td></tr>`).join('')}</tbody></table></div>`;
}

function vaultsView() {
  setBreadcrumb('Vaults'); setActiveNav('vaults');
  return `<div class="page-header"><div><div class="eyebrow">Capital boundaries</div><h1>Vaults</h1><p class="page-subtitle">Controlled balances, spendable balances, reservations and execution constraints.</p></div><div class="page-actions"><button class="primary-button" data-route-link="vault-sol-01">Inspect primary vault</button></div></div><div class="panel"><div class="panel-head"><span class="panel-title">Capital boundaries</span><span class="mono" style="font-size:9px;color:var(--muted)">$142,800 controlled</span></div><table class="data-table"><thead><tr><th>Vault</th><th>Chain</th><th>Total</th><th>Available</th><th>Reserved</th><th>Status</th></tr></thead><tbody><tr class="clickable" data-route-link="vault-sol-01"><td><div class="entity-cell"><span class="entity-icon">V1</span><span class="entity-meta"><strong>Primary operating vault</strong><small class="mono">VLT-SOL-01</small></span></div></td><td>Solana</td><td class="mono">$68,420</td><td class="mono">$42,906.20</td><td class="mono">$8,018.40</td><td>${status('active')}</td></tr><tr><td><div class="entity-cell"><span class="entity-icon">V2</span><span class="entity-meta"><strong>Base commerce vault</strong><small class="mono">VLT-BASE-02</small></span></div></td><td>Base</td><td class="mono">$41,380</td><td class="mono">$28,911</td><td class="mono">$6,400</td><td>${status('active')}</td></tr><tr><td><div class="entity-cell"><span class="entity-icon">V3</span><span class="entity-meta"><strong>Recovery reserve</strong><small class="mono">VLT-SOL-REC</small></span></div></td><td>Solana</td><td class="mono">$22,000</td><td class="mono">$15,200</td><td class="mono">$2,900</td><td>${status('active')}</td></tr></tbody></table></div>`;
}


function agentsView() {
  setBreadcrumb('Agents'); setActiveNav('agents');
  return `<div class="page-header"><div><div class="eyebrow">Economic actors</div><h1>Agents</h1><p class="page-subtitle">Identity, capabilities, authority references and economic exposure across connected agent ecosystems.</p></div><div class="page-actions"><button class="primary-button" data-action="register-agent">Register agent</button></div></div>
  <div class="section-grid">
    <div class="mini-card"><div class="top"><h3>Active agents</h3>${status('active')}</div><p>Agents with verified control and active economic authority.</p><div class="mini-card-value">12</div><div class="metric-foot">3 currently executing</div></div>
    <div class="mini-card"><div class="top"><h3>External identities</h3>${status('neutral')}</div><p>Virtuals, Olas, Agentverse and ERC-8004 references.</p><div class="mini-card-value">19</div><div class="metric-foot">all identifiers preserved</div></div>
    <div class="mini-card"><div class="top"><h3>Aggregate exposure</h3>${status('active')}</div><p>Current liabilities minus receivables across agents.</p><div class="mini-card-value">$8,714</div><div class="metric-foot">prefunded commerce only</div></div>
  </div>
  <div class="panel" style="margin-top:16px"><div class="panel-head"><span class="panel-title">Agent registry</span><span class="mono" style="font-size:9px;color:var(--muted)">normalized identities</span></div><table class="data-table"><thead><tr><th>Agent</th><th>Identity</th><th>Capabilities</th><th>Mandates</th><th>Exposure</th><th>Status</th></tr></thead><tbody>
  <tr><td><div class="entity-cell"><span class="entity-icon">B7</span><span class="entity-meta"><strong>Buyer Agent 07</strong><small class="mono">buyer-07</small></span></div></td><td>Native + ERC-8004</td><td>discovery · purchasing</td><td class="mono">3</td><td class="mono">$1,882</td><td>${status('active')}</td></tr>
  <tr><td><div class="entity-cell"><span class="entity-icon">R4</span><span class="entity-meta"><strong>Research Agent 04</strong><small class="mono">research-04</small></span></div></td><td>Virtuals ACP</td><td>market research</td><td class="mono">1</td><td class="mono">$420</td><td>${status('active')}</td></tr>
  <tr><td><div class="entity-cell"><span class="entity-icon">D3</span><span class="entity-meta"><strong>Data Agent 03</strong><small class="mono">data-03</small></span></div></td><td>Agentverse</td><td>data extraction</td><td class="mono">2</td><td class="mono">$2,144</td><td>${status('active')}</td></tr>
  <tr><td><div class="entity-cell"><span class="entity-icon">E2</span><span class="entity-meta"><strong>Evaluator Agent 02</strong><small class="mono">eval-02</small></span></div></td><td>Mitra native</td><td>deterministic evaluation</td><td class="mono">1</td><td class="mono">$0</td><td>${status('active')}</td></tr>
  </tbody></table></div>`;
}

function policiesView() {
  setBreadcrumb('Policies'); setActiveNav('policies');
  return `<div class="page-header"><div><div class="eyebrow">Delegated economic authority</div><h1>Policies</h1><p class="page-subtitle">Mandates define what agents may propose. Vault guards still determine whether exact instructions can consume capital.</p></div><div class="page-actions"><button class="primary-button" data-action="new-mandate">New mandate</button></div></div>
  <div class="metric-grid"><div class="metric"><div class="metric-label">Active mandates</div><div class="metric-value">18</div><div class="metric-foot">across 12 agents</div></div><div class="metric"><div class="metric-label">Policy denials · 24h</div><div class="metric-value">7</div><div class="metric-foot">all blocked before capital movement</div></div><div class="metric"><div class="metric-label">Revocations · 7d</div><div class="metric-value">2</div><div class="metric-foot">versioned and receipt-backed</div></div><div class="metric"><div class="metric-label">Replay rejections</div><div class="metric-value">14</div><div class="metric-foot">nonce / expiry enforcement</div></div></div>
  <div class="panel" style="margin-top:16px"><div class="panel-head"><span class="panel-title">Mandates</span><span class="panel-subtitle">bounded authority</span></div><table class="data-table"><thead><tr><th>Mandate</th><th>Agent</th><th>Budget</th><th>Max tx</th><th>Chains</th><th>Status</th></tr></thead><tbody>
  <tr><td><div class="entity-cell"><span class="entity-icon">V7</span><span class="entity-meta"><strong>Research purchasing</strong><small class="mono">MND-7F21 · policy-v3.4</small></span></div></td><td class="mono">buyer-07</td><td class="mono">$50.00</td><td class="mono">$15.00</td><td>Solana</td><td>${status('active')}</td></tr>
  <tr><td><div class="entity-cell"><span class="entity-icon">V4</span><span class="entity-meta"><strong>Market data access</strong><small class="mono">MND-2BC4 · policy-v2.9</small></span></div></td><td class="mono">data-03</td><td class="mono">$250.00</td><td class="mono">$25.00</td><td>Solana · Base</td><td>${status('active')}</td></tr>
  <tr><td><div class="entity-cell"><span class="entity-icon">V2</span><span class="entity-meta"><strong>Yield route evaluation</strong><small class="mono">MND-99A2 · policy-v1.6</small></span></div></td><td class="mono">buyer-02</td><td class="mono">$500.00</td><td class="mono">$100.00</td><td>Base</td><td>${status('active')}</td></tr>
  </tbody></table></div>`;
}

function obligationsView() {
  setBreadcrumb('Obligations'); setActiveNav('obligations');
  return `<div class="page-header"><div><div class="eyebrow">Economic ledger</div><h1>Obligations</h1><p class="page-subtitle">What is owed, to whom, under which agreement—and what can be netted before settlement.</p></div><div class="page-actions"><button class="secondary-button" data-action="export-ledger">Export ledger</button></div></div>
  <div class="metric-grid"><div class="metric"><div class="metric-label">Gross payables</div><div class="metric-value">$31,280</div><div class="metric-foot">47 obligations</div></div><div class="metric"><div class="metric-label">Receivables</div><div class="metric-value">$22,566</div><div class="metric-foot">39 obligations</div></div><div class="metric"><div class="metric-label">Net exposure</div><div class="metric-value">$8,714</div><div class="metric-foot">before next clearing epoch</div></div><div class="metric"><div class="metric-label">Disputed</div><div class="metric-value">$820</div><div class="metric-foot">excluded from finalization</div></div></div>
  <div class="panel" style="margin-top:16px"><div class="panel-head"><span class="panel-title">Obligation ledger</span><span class="mono" style="font-size:9px;color:var(--muted)">next epoch closes 17:30</span></div><table class="data-table"><thead><tr><th>Obligation</th><th>Debtor</th><th>Creditor</th><th>Amount</th><th>Agreement</th><th>Status</th></tr></thead><tbody>
  <tr><td class="mono">OBL-1842</td><td class="mono">VLT-SOL-01</td><td class="mono">mech-research-09</td><td class="mono">$11.60</td><td class="mono">AGR-77</td><td>${status('active')}</td></tr>
  <tr><td class="mono">OBL-1839</td><td class="mono">data-03</td><td class="mono">api-provider-8</td><td class="mono">$25.20</td><td class="mono">AGR-75</td><td>${status('active')}</td></tr>
  <tr><td class="mono">OBL-1831</td><td class="mono">provider-12</td><td class="mono">VLT-SOL-01</td><td class="mono">$8.40</td><td class="mono">AGR-72</td><td>${status('active')}</td></tr>
  <tr><td class="mono">OBL-1824</td><td class="mono">buyer-02</td><td class="mono">provider-3</td><td class="mono">$820.00</td><td class="mono">AGR-68</td><td>${status('failed')}</td></tr>
  </tbody></table></div>`;
}

function clearingView() {
  setBreadcrumb('Clearing'); setActiveNav('clearing');
  return `<div class="page-header"><div><div class="eyebrow">Netting & clearing</div><h1>Clearing</h1><p class="page-subtitle">Freeze an obligation set, compute deterministic net positions, challenge exclusions, then settle only the residual vector.</p></div><div class="page-actions"><button class="primary-button" data-action="open-epoch">Open epoch</button></div></div>
  <div class="summary-strip"><div class="summary-cell"><label>Current epoch</label><strong class="mono">EPOCH-043</strong><small>OPEN · closes 17:30</small></div><div class="summary-cell"><label>Input obligations</label><strong>23</strong><small>2 assets · 1 domain</small></div><div class="summary-cell"><label>Gross volume</label><strong>$4,912.60</strong><small>before netting</small></div><div class="summary-cell"><label>Projected residual</label><strong>$1,588.10</strong><small>67.7% movement avoided</small></div></div>
  <div class="detail-grid"><div class="panel"><div class="panel-head"><div><span class="panel-title">Epoch lifecycle</span><span class="panel-subtitle">deterministic state machine</span></div>${status('active')}</div><div style="padding:20px"><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;align-items:center;text-align:center;font-size:9px"><div><span class="status active">OPEN</span></div><div>→</div><div><span class="status neutral">FROZEN</span></div><div>→</div><div><span class="status neutral">CALCULATING</span></div><div>→</div><div><span class="status neutral">CHALLENGE</span></div></div><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;align-items:center;text-align:center;font-size:9px;margin-top:15px"><div><span class="status neutral">FINALIZED</span></div><div>→</div><div><span class="status neutral">SETTLING</span></div><div>→</div><div><span class="status neutral">SETTLED</span></div></div></div></div>
  <div class="panel"><div class="panel-head"><span class="panel-title">Last finalized epoch</span><span class="mono" style="font-size:9px;color:var(--muted)">EPOCH-042</span></div><div class="inspector-body"><div class="kv"><label>Inputs</label><div>17 obligations</div></div><div class="kv"><label>Gross</label><div class="mono">$1,842.40</div></div><div class="kv"><label>Residual</label><div class="mono">$617.80</div></div><div class="kv"><label>Excluded</label><div>1 disputed obligation</div></div><div class="kv"><label>Result hash</label><div><span class="hash">0xa5cd…c381</span></div></div><div class="kv"><label>State</label><div>${status('settled')}</div></div></div></div></div>
  <div class="panel" style="margin-top:16px"><div class="panel-head"><span class="panel-title">Residual transfer vector · EPOCH-042</span><span class="panel-subtitle">what actually moved</span></div><table class="data-table"><thead><tr><th>From</th><th>To</th><th>Asset</th><th>Gross attributed</th><th>Residual</th><th>Status</th></tr></thead><tbody><tr><td class="mono">VLT-SOL-01</td><td class="mono">provider-net-A</td><td>USDC</td><td class="mono">$38.20</td><td class="mono">$7.20</td><td>${status('settled')}</td></tr><tr><td class="mono">buyer-02</td><td class="mono">provider-net-B</td><td>USDC</td><td class="mono">$430.00</td><td class="mono">$191.60</td><td>${status('settled')}</td></tr></tbody></table></div>`;
}

function settlementsView() {
  setBreadcrumb('Settlements'); setActiveNav('settlements');
  return `<div class="page-header"><div><div class="eyebrow">Final value movement</div><h1>Settlements</h1><p class="page-subtitle">Settlement moves assets only after economic obligations have been determined and cleared.</p></div><div class="page-actions"><button class="secondary-button" data-action="reconcile">Reconcile</button></div></div>
  <div class="panel"><div class="panel-head"><span class="panel-title">Recent settlements</span><span class="mono" style="font-size:9px;color:var(--muted)">Solana primary · Base secondary</span></div><table class="data-table"><thead><tr><th>Settlement</th><th>Chain</th><th>Asset</th><th>Amount</th><th>Clearing ref</th><th>Evidence</th><th>Status</th></tr></thead><tbody>
  <tr><td class="mono">SET-913</td><td>Solana devnet</td><td>USDC</td><td class="mono">$7.20</td><td class="mono">EPOCH-042</td><td><span class="hash">4nW2…3LkP</span></td><td>${status('settled')}</td></tr>
  <tr><td class="mono">SET-912</td><td>Solana devnet</td><td>USDC</td><td class="mono">$191.60</td><td class="mono">EPOCH-042</td><td><span class="hash">7Qy1…L0ab</span></td><td>${status('settled')}</td></tr>
  <tr><td class="mono">SET-909</td><td>Base Sepolia</td><td>USDC</td><td class="mono">$38.40</td><td class="mono">EPOCH-041</td><td><span class="hash">0x41e…c7b</span></td><td>${status('settled')}</td></tr>
  </tbody></table></div>`;
}

function integrationsView() {
  setBreadcrumb('Integrations'); setActiveNav('integrations');
  const cards = [
    ['Solana','Primary settlement + vault','TESTNET_PASS','economic kernel'],['Base','Identity + commerce + settlement','LOCAL_PASS','EVM adapter'],['Tempo','Settlement adapter','DESIGN_ONLY','payment-specialized'],['Virtuals','Marketplace discovery','LOCAL_PASS','ACP adapter'],['A2A','Task execution semantics','LOCAL_PASS','agent transport'],['MCP','Agent-facing control surface','LOCAL_PASS','tool interface'],['x402','Paid resource flows','LOCAL_PASS','payment adapter'],['MPP','Metered machine payments','DESIGN_ONLY','payment adapter'],['Arcium','Confidential policy evaluation','DESIGN_ONLY','optional policy enclave']
  ];
  return `<div class="page-header"><div><div class="eyebrow">External ecosystem</div><h1>Integrations</h1><p class="page-subtitle">Mitra keeps one economic model while adapters connect different marketplaces, protocols and settlement rails.</p></div></div><div class="section-grid">${cards.map(([name,desc,level,meta]) => `<div class="mini-card"><div class="top"><h3>${name}</h3><span class="status ${level==='TESTNET_PASS'?'active':level==='LOCAL_PASS'?'clearing':'neutral'}">${level.replace('_',' ')}</span></div><p>${desc}</p><div class="metric-foot">${meta}</div></div>`).join('')}</div>`;
}

function evidenceView() {
  setBreadcrumb('Evidence'); setActiveNav('evidence');
  return `<div class="page-header"><div><div class="eyebrow">Proof surface</div><h1>Evidence</h1><p class="page-subtitle">Implementation claims are separated by evidence level. Screenshots are never treated as protocol proof.</p></div><div class="page-actions"><button class="secondary-button" data-action="export-evidence">Export evidence bundle</button></div></div>
  <div class="notice"><span>ⓘ</span><div><strong>Evidence ladder:</strong> DESIGN_ONLY → LOCAL_PASS → TESTNET_PASS → LIVE_PUBLIC_PASS → PRODUCTION_PASS. A testnet settlement is not production settlement.</div></div>
  <div class="panel" style="margin-top:16px"><div class="panel-head"><span class="panel-title">Evidence registry</span><span class="panel-subtitle">versioned proof artifacts</span></div><table class="data-table"><thead><tr><th>Integration</th><th>Network</th><th>Evidence level</th><th>Commit / version</th><th>Reference</th></tr></thead><tbody>
  <tr><td>Vault + reservation kernel</td><td>Solana devnet</td><td>${status('active')} <span style="font-size:9px">TESTNET_PASS</span></td><td class="mono">kernel-v0.1.3</td><td><span class="hash">4nW2…3LkP</span></td></tr>
  <tr><td>Clearing engine</td><td>local adversarial suite</td><td>${status('clearing')} <span style="font-size:9px">LOCAL_PASS</span></td><td class="mono">clear-v0.1.1</td><td><span class="hash">0xa5cd…c381</span></td></tr>
  <tr><td>Base adapter</td><td>Base Sepolia</td><td>${status('clearing')} <span style="font-size:9px">LOCAL_PASS</span></td><td class="mono">base-v0.0.4</td><td><span class="hash">0x41e…c7b</span></td></tr>
  <tr><td>Tempo adapter</td><td>—</td><td>${status('neutral')} <span style="font-size:9px">DESIGN_ONLY</span></td><td class="mono">tempo-v0.0.1</td><td>adapter contract</td></tr>
  </tbody></table></div>`;
}

function placeholderView(route) {
  const names = { agents:'Agents', policies:'Policies', obligations:'Obligations', clearing:'Clearing', settlements:'Settlements', integrations:'Integrations', evidence:'Evidence' };
  setBreadcrumb(names[route] || route); setActiveNav(route);
  return `<div class="page-header"><div><div class="eyebrow">Mitra 0.1</div><h1>${names[route] || route}</h1><p class="page-subtitle">This surface is wired into the design system and will inherit the same canonical economic objects.</p></div></div><div class="placeholder"><div><strong>${names[route] || route} surface</strong><div>Core shell is ready. The next build pass fills this with protocol-backed data.</div></div></div>`;
}

function render() {
  const raw = (location.hash || '#overview').slice(1);
  const route = raw || 'overview';
  let html;
  if (route === 'overview') html = overviewView();
  else if (route === 'run-501') html = runView();
  else if (route === 'vault-sol-01') html = vaultView();
  else if (route === 'runs') html = runsView();
  else if (route === 'vaults') html = vaultsView();
  else if (route === 'agents') html = agentsView();
  else if (route === 'policies') html = policiesView();
  else if (route === 'obligations') html = obligationsView();
  else if (route === 'clearing') html = clearingView();
  else if (route === 'settlements') html = settlementsView();
  else if (route === 'integrations') html = integrationsView();
  else if (route === 'evidence') html = evidenceView();
  else html = placeholderView(route);
  document.getElementById('view').innerHTML = html;
  bindViewEvents();
}

function bindViewEvents() {
  document.querySelectorAll('[data-route-link]').forEach(el => el.addEventListener('click', () => { location.hash = el.dataset.routeLink; }));
  document.querySelectorAll('[data-event-id]').forEach(el => el.addEventListener('click', () => { state.selectedEvent = el.dataset.eventId; render(); requestAnimationFrame(() => document.getElementById('inspector')?.scrollIntoView({block:'nearest'})); }));
  document.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', () => handleAction(el.dataset.action)));
}

function handleAction(action) {
  const messages = {
    'export': 'Evidence bundle prepared for export.', 'copy-vault': 'Vault ID copied.', 'freeze': 'Emergency freeze requires principal authorization.', 'copy-run': 'Run ID copied.', 'pause-run': 'Pause request requires principal authorization.', 'verify-chain': 'Settlement evidence verified against Solana devnet.', 'copy-receipt': 'Receipt reference copied.', 'open-evidence': 'Evidence view is next in the build queue.', 'new-run': 'Run composer is next in the build queue.', 'register-agent': 'Agent registration flow queued.', 'new-mandate': 'Mandate composer queued.', 'export-ledger': 'Obligation ledger prepared for export.', 'open-epoch': 'A new clearing epoch requires operator authorization.', 'reconcile': 'Reconciliation check started.', 'export-evidence': 'Evidence bundle prepared for export.'
  };
  showToast(messages[action] || 'Action acknowledged.');
}

function showToast(message) {
  const el = document.getElementById('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(window.__toast); window.__toast = setTimeout(() => el.classList.remove('show'), 2200);
}

function openPalette() {
  const p = document.getElementById('commandPalette'); p.hidden = false; const input = document.getElementById('paletteInput'); input.value = ''; renderPalette(''); setTimeout(() => input.focus(), 0);
}
function closePalette() { document.getElementById('commandPalette').hidden = true; }
function renderPalette(query) {
  const q = query.toLowerCase(); const list = searchItems.filter(i => `${i.label} ${i.sub} ${i.type}`.toLowerCase().includes(q));
  document.getElementById('paletteResults').innerHTML = list.map(i => `<button class="palette-result" data-palette-route="${i.route}"><span class="entity-icon">${i.icon}</span><span><strong>${i.label}</strong><small>${i.sub}</small></span><span class="result-type">${i.type}</span></button>`).join('') || `<div style="padding:18px;text-align:center;color:var(--muted);font-size:11px">No matching Mitra objects.</div>`;
  document.querySelectorAll('[data-palette-route]').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.paletteRoute.slice(1); closePalette(); }));
}

document.getElementById('searchButton').addEventListener('click', openPalette);
document.getElementById('newRunButton').addEventListener('click', () => showToast('Run composer is next in the build queue.'));
document.getElementById('paletteBackdrop').addEventListener('click', closePalette);
document.getElementById('paletteInput').addEventListener('input', e => renderPalette(e.target.value));
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  if (e.key === 'Escape') closePalette();
});
window.addEventListener('hashchange', render);
render();
