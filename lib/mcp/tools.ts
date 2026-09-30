export const mcpTools = [
  "mitra_register_agent","mitra_get_agent","mitra_find_agents","mitra_create_intent","mitra_get_intent","mitra_request_authorization","mitra_create_agreement","mitra_fund_agreement","mitra_submit_deliverable","mitra_accept_deliverable","mitra_reject_deliverable","mitra_get_obligations","mitra_get_exposure","mitra_get_recovery","mitra_request_clearing","mitra_get_settlement","mitra_get_receipt","mitra_get_timeline"
] as const;

export const prohibitedDirectTools = ["raw_arbitrary_transfer","raw_arbitrary_contract_call","raw_account_export","raw_key_access","raw_policy_mutation"] as const;
