// 빌드 시점에 scripts/build_dataset.py가 원본 CSV에서 만든 데이터셋(원본은 수정하지 않음).
import raw from "../data/dataset.json";

export interface InfluencerPerf {
  influencer_id: string; influencer_name: string; tier: string; country: string; fee_type: string; campaigns: number;
  gmv: number; spend: number; cp: number; cp_alt: number; nominal_roas: number; real_roas: number; return_rate: number;
  spend_share: number; plan_share: number; cp_rank: number; cp_alt_rank: number; spend_rank: number; gmv_rank: number;
}
export interface CampaignPerf {
  campaign_id: string; campaign_name: string; influencer_id: string; product_line: string; country: string; orders: number;
  gmv: number; refund: number; spend: number; cp: number; nominal_roas: number; real_roas: number; return_rate: number;
}
export interface Plan {
  plan_id: string; campaign_id: string; campaign_name: string; influencer_id: string; product_line: string;
  requested_budget_krw: number; expected_gmv_krw: number; settlement_date: string; contract_deadline: string;
}
export interface SupplyCat {
  category: string; product_id: string | null; min_cover_weeks: number; min_cover_sku: string; safety_min: number;
  lead_time_weeks: number; line_utilization_pct: number; constrained: boolean; line_saturated: boolean;
}
export interface LegalRule {
  id: string; law: string; title: string; action: "warn" | "block"; type: "trigger" | "required_disclosure";
  triggers?: string[]; exceptions?: string[]; required_any?: string[]; reason: string; alternatives: string[];
  replace?: Record<string, string>; text: string;
}
export interface Contract {
  contract_id: string; influencer_id: string; influencer_name: string; fixed_fee_krw: number; performance_fee: string;
  expiry_date: string; notice_deadline: string; fixed_fee_payment_schedule: null | { date: string; amount_krw: number }[]; source: string;
}

export interface Dataset {
  policy: {
    covenant: { min_cash_krw: number };
    authority: { campaign_item_team_limit_krw: number; campaign_plan_total_ceo_report_krw: number; exclusive_contract_ceo_limit_krw: number };
    contracts: Contract[];
    recommendation_thresholds: { real_roas_reject_below: number; real_roas_conditional_below: number };
  };
  legal_kb: { rules: LegalRule[] };
  mock_replies: Record<string, { reply_id: string; summary: string; [k: string]: unknown }>;
  influencers: Record<string, InfluencerPerf>;
  campaigns: Record<string, CampaignPerf>;
  alignment: { spearman_spend_vs_cp: number; inverted: boolean; top_spend_influencer: string };
  trend: { half: string; gmv: number; cp: number; spend: number; gmv_growth: number | null; cp_growth: number | null }[];
  supply: Record<string, SupplyCat>;
  plans: Plan[];
  plan_total: number;
  ad_copies: Record<string, string>;
  cash: {
    opening: number;
    ar: { id: string; channel_id: string; invoice_date: string; due_date: string; amount: number }[];
    ap: { id: string; due: string; amount: number }[];
    po: { id: string; due: string; amount: number }[];
    official: { week: string; closing: number }[];
    history_tail: { date: string; closing: number }[];
  };
  policy_hits: Record<string, { source: string; text: string; score: number }[]>;
}

export const DS = raw as unknown as Dataset;
export const CONTRACT = DS.policy.contracts[0];
export const PLANS: Record<string, Plan> = Object.fromEntries(DS.plans.map((p) => [p.plan_id, p]));
