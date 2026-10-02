/** User-supplied internal reconciliation methods for M3-02. Source quotes are preserved verbatim.
 * Conditions and caveats describe implementation boundaries, not verified regulatory authority.
 * Conditional/manual methods intentionally have no runnable terms in this version.
 */
export interface AuditReconciliationRule {
  id: string;
  source_item: number;
  title: string;
  source_quote: string;
  category: 'deterministic' | 'conditional' | 'manual';
  result_metric: string;
  result_aliases?: string[];
  terms?: {
    metric: string;
    aliases?: string[];
    coefficient: 1 | -1;
    period_role?: 'same' | 'opening' | 'flow';
  }[];
  conditions: string[];
  caveat: string;
  applicability?: 'consolidated';
}

const rules: AuditReconciliationRule[] = [
  {
    "id": "audit-reconciliation-01",
    "source_item": 1,
    "title": "会计恒等式",
    "source_quote": "资产 = 负债 + 所有者权益",
    "category": "deterministic",
    "result_metric": "total_assets",
    "result_aliases": [
      "资产总计",
      "资产合计"
    ],
    "terms": [
      {
        "metric": "total_liabilities",
        "aliases": [
          "负债合计"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "total_equity",
        "aliases": [
          "所有者权益合计",
          "股东权益合计"
        ],
        "coefficient": 1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "资产、负债和权益为同一截止日的完整总额；合并权益总额包含少数股东权益。"
    ],
    "caveat": "不得以归属于母公司所有者权益替代合并所有者权益合计。"
  },
  {
    "id": "audit-reconciliation-02",
    "source_item": 2,
    "title": "流动资产汇总",
    "source_quote": "流动资产合计 = 货币资金 + 交易性金融资产 + 应收票据 + 应收账款 + 应收款项融资 + 预付款项 + 其他应收款 + 存货 + 合同资产 + 一年内到期的非流动资产 + 其他流动资产（各明细科目相加）",
    "category": "conditional",
    "result_metric": "current_assets",
    "result_aliases": [
      "流动资产合计"
    ],
    "conditions": [
      "源报表采用流动/非流动分类，全部流动资产明细已识别且加总范围完整。",
      "采用实际报表明细，不重复加总子合计；缺失科目不得默认零。"
    ],
    "caveat": "附件列举并非完整报表模板；持有待售资产等额外明细可能存在，当前保留条件提示。"
  },
  {
    "id": "audit-reconciliation-03",
    "source_item": 3,
    "title": "非流动资产汇总",
    "source_quote": "非流动资产合计 = 债权投资 + 其他债权投资 + 长期应收款 + 长期股权投资 + 其他权益工具投资 + 投资性房地产 + 固定资产 + 在建工程 + 使用权资产 + 无形资产 + 商誉 + 长期待摊费用 + 递延所得税资产 + 其他非流动资产（各明细科目相加）",
    "category": "conditional",
    "result_metric": "non_current_assets",
    "result_aliases": [
      "非流动资产合计"
    ],
    "conditions": [
      "源报表采用流动/非流动分类，全部非流动资产明细已识别且加总范围完整。",
      "采用实际报表明细，不重复加总子合计；缺失科目不得默认零。"
    ],
    "caveat": "附件可能遗漏生产性生物资产、油气资产等明细；不能将固定枚举视为完整清单。"
  },
  {
    "id": "audit-reconciliation-04",
    "source_item": 4,
    "title": "资产总计",
    "source_quote": "流动资产合计 + 非流动资产合计 = 资产总计",
    "category": "deterministic",
    "result_metric": "total_assets",
    "result_aliases": [
      "资产总计",
      "资产合计"
    ],
    "terms": [
      {
        "metric": "current_assets",
        "aliases": [
          "流动资产合计"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "non_current_assets",
        "aliases": [
          "非流动资产合计"
        ],
        "coefficient": 1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "报表采用流动/非流动分类，两大类合计覆盖资产总计且截止日一致。"
    ],
    "caveat": "非分类报表不能强套流动/非流动资产公式。"
  },
  {
    "id": "audit-reconciliation-05",
    "source_item": 5,
    "title": "流动负债汇总",
    "source_quote": "流动负债合计 = 短期借款 + 交易性金融负债 + 应付票据 + 应付账款 + 预收款项 + 合同负债 + 应付职工薪酬 + 应交税费 + 其他应付款 + 一年内到期的非流动负债 + 其他流动负债（各明细科目相加）",
    "category": "conditional",
    "result_metric": "current_liabilities",
    "result_aliases": [
      "流动负债合计"
    ],
    "conditions": [
      "源报表采用流动/非流动分类，全部流动负债明细已识别且加总范围完整。",
      "采用实际报表明细，不重复加总子合计；缺失科目不得默认零。"
    ],
    "caveat": "附件列举并非完整报表模板；持有待售负债等额外明细可能存在。"
  },
  {
    "id": "audit-reconciliation-06",
    "source_item": 6,
    "title": "非流动负债汇总",
    "source_quote": "非流动负债合计 = 长期借款 + 应付债券 + 租赁负债 + 长期应付款 + 预计负债 + 递延收益 + 递延所得税负债 + 其他非流动负债（各明细科目相加）",
    "category": "conditional",
    "result_metric": "non_current_liabilities",
    "result_aliases": [
      "非流动负债合计"
    ],
    "conditions": [
      "源报表采用流动/非流动分类，全部非流动负债明细已识别且加总范围完整。",
      "采用实际报表明细，不重复加总子合计；缺失科目不得默认零。"
    ],
    "caveat": "仅凭附件列举的负债科目不足以证明源报表加总范围完整。"
  },
  {
    "id": "audit-reconciliation-07",
    "source_item": 7,
    "title": "负债合计",
    "source_quote": "流动负债合计 + 非流动负债合计 = 负债合计",
    "category": "deterministic",
    "result_metric": "total_liabilities",
    "result_aliases": [
      "负债合计"
    ],
    "terms": [
      {
        "metric": "current_liabilities",
        "aliases": [
          "流动负债合计"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "non_current_liabilities",
        "aliases": [
          "非流动负债合计"
        ],
        "coefficient": 1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "报表采用流动/非流动分类，两大类合计覆盖负债合计且截止日一致。"
    ],
    "caveat": "非分类报表不能强套流动/非流动负债公式。"
  },
  {
    "id": "audit-reconciliation-08",
    "source_item": 8,
    "title": "所有者权益合计",
    "source_quote": "所有者权益合计 = 实收资本（股本）+ 资本公积 + 其他综合收益 + 专项储备 + 盈余公积 + 未分配利润",
    "category": "conditional",
    "result_metric": "total_equity",
    "result_aliases": [
      "所有者权益合计",
      "股东权益合计"
    ],
    "conditions": [
      "完整权益项目清单及符号已从源报告确认。",
      "纳入其他权益工具、减：库存股等实际明细；合并报表纳入少数股东权益。"
    ],
    "caveat": "附件简式遗漏可能存在的权益项目，尤其合并报表少数股东权益；当前不直接套算。"
  },
  {
    "id": "audit-reconciliation-09",
    "source_item": 9,
    "title": "固定资产净值",
    "source_quote": "固定资产净值 = 固定资产原值 - 累计折旧",
    "category": "deterministic",
    "result_metric": "fixed_assets_net_value",
    "result_aliases": [
      "固定资产净值"
    ],
    "terms": [
      {
        "metric": "fixed_assets_original_cost",
        "aliases": [
          "固定资产原值"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "accumulated_depreciation",
        "aliases": [
          "固定资产累计折旧"
        ],
        "coefficient": -1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "原文明确净值仅扣累计折旧；原值及累计折旧为同一固定资产范围和截止日。"
    ],
    "caveat": "固定资产净值与扣除减值准备后的账面价值不同，不泛化匹配报表中的“固定资产”。"
  },
  {
    "id": "audit-reconciliation-10",
    "source_item": 10,
    "title": "固定资产账面价值",
    "source_quote": "固定资产账面价值 = 固定资产原值 - 累计折旧 - 减值准备",
    "category": "deterministic",
    "result_metric": "fixed_assets_carrying_value",
    "result_aliases": [
      "固定资产账面价值"
    ],
    "terms": [
      {
        "metric": "fixed_assets_original_cost",
        "aliases": [
          "固定资产原值"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "accumulated_depreciation",
        "aliases": [
          "固定资产累计折旧"
        ],
        "coefficient": -1,
        "period_role": "same"
      },
      {
        "metric": "fixed_assets_impairment",
        "aliases": [
          "固定资产减值准备"
        ],
        "coefficient": -1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "原值、累计折旧、减值准备均为固定资产同一范围和截止日的余额；抵减余额的符号明确。"
    ],
    "caveat": "不将固定资产净值、固定资产清理或使用权资产混入该公式。"
  },
  {
    "id": "audit-reconciliation-11",
    "source_item": 11,
    "title": "在建工程转固",
    "source_quote": "在建工程期末余额 = 在建工程期初余额 + 本期增加 - 本期转入固定资产 - 本期其他减少",
    "category": "conditional",
    "result_metric": "construction_in_progress_closing",
    "result_aliases": [
      "在建工程期末余额"
    ],
    "conditions": [
      "期初余额与期间起点衔接；增加、转固及其他减少覆盖完整期间变动。",
      "重分类、合并、汇率及其他变化已进入完整桥接，且净额/原值口径一致。"
    ],
    "caveat": "缺失其他变动时不得把简化余额桥接差额直接定性为错误。"
  },
  {
    "id": "audit-reconciliation-12",
    "source_item": 12,
    "title": "无形资产账面价值",
    "source_quote": "无形资产账面价值 = 无形资产原值 - 累计摊销 - 减值准备",
    "category": "deterministic",
    "result_metric": "intangible_assets_carrying_value",
    "result_aliases": [
      "无形资产账面价值"
    ],
    "terms": [
      {
        "metric": "intangible_assets_original_cost",
        "aliases": [
          "无形资产原值"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "accumulated_amortization",
        "aliases": [
          "无形资产累计摊销"
        ],
        "coefficient": -1,
        "period_role": "same"
      },
      {
        "metric": "intangible_assets_impairment",
        "aliases": [
          "无形资产减值准备"
        ],
        "coefficient": -1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "原值、累计摊销、减值准备均为无形资产同一范围和截止日的余额；抵减余额的符号明确。"
    ],
    "caveat": "不使用其他资产的摊销或减值准备，不将净值与账面价值混淆。"
  },
  {
    "id": "audit-reconciliation-13",
    "source_item": 13,
    "title": "应收账款净额",
    "source_quote": "应收账款净额 = 应收账款账面余额 - 坏账准备",
    "category": "deterministic",
    "result_metric": "accounts_receivable_net",
    "result_aliases": [
      "应收账款净额",
      "应收账款账面价值"
    ],
    "terms": [
      {
        "metric": "accounts_receivable_gross",
        "aliases": [
          "应收账款账面余额"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "accounts_receivable_bad_debt_allowance",
        "aliases": [
          "应收账款坏账准备"
        ],
        "coefficient": -1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "应收账款账面余额和坏账准备为同一截止日及范围；准备以正数抵减余额表达。"
    ],
    "caveat": "应收票据、应收款项融资及合同资产不能替代应收账款。"
  },
  {
    "id": "audit-reconciliation-14",
    "source_item": 14,
    "title": "其他应收款净额",
    "source_quote": "其他应收款净额 = 其他应收款账面余额 - 坏账准备",
    "category": "deterministic",
    "result_metric": "other_receivables_net",
    "result_aliases": [
      "其他应收款净额",
      "其他应收款账面价值"
    ],
    "terms": [
      {
        "metric": "other_receivables_gross",
        "aliases": [
          "其他应收款账面余额"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "other_receivables_bad_debt_allowance",
        "aliases": [
          "其他应收款坏账准备"
        ],
        "coefficient": -1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "其他应收款账面余额和坏账准备为同一截止日及范围；准备以正数抵减余额表达。"
    ],
    "caveat": "报表“其他应收款”可能包含应收利息/股利等展示项，应先确认与附注明细范围相同。"
  },
  {
    "id": "audit-reconciliation-15",
    "source_item": 15,
    "title": "存货净额",
    "source_quote": "存货净额 = 存货账面余额 - 存货跌价准备",
    "category": "deterministic",
    "result_metric": "inventory_net",
    "result_aliases": [
      "存货净额",
      "存货账面价值"
    ],
    "terms": [
      {
        "metric": "inventory_gross",
        "aliases": [
          "存货账面余额"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "inventory_write_down_allowance",
        "aliases": [
          "存货跌价准备"
        ],
        "coefficient": -1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "存货账面余额和跌价准备为同一截止日及范围；准备以正数抵减余额表达。"
    ],
    "caveat": "不混用存货原值、净额及合同履约成本等不同范围。"
  },
  {
    "id": "audit-reconciliation-16",
    "source_item": 16,
    "title": "长期股权投资",
    "source_quote": "长期股权投资账面价值 = 初始投资成本 ± 损益调整 ± 其他综合收益调整 ± 其他权益变动 - 减值准备",
    "category": "conditional",
    "result_metric": "long_term_equity_investment_carrying_value",
    "result_aliases": [
      "长期股权投资账面价值"
    ],
    "conditions": [
      "确认投资采用权益法且完整分项余额、符号和计量口径可追溯。",
      "分红、增减投资、处置、其他变动及减值已进入各分项或另有完整桥接。"
    ],
    "caveat": "不能把最初投出金额当作任意长期股权投资的当前成本余额；成本法、权益法及合并抵销须分别处理。"
  },
  {
    "id": "audit-reconciliation-17",
    "source_item": 17,
    "title": "未分配利润（表内）",
    "source_quote": "未分配利润期末余额 = 未分配利润期初余额 + 本期净利润 - 提取盈余公积 - 分配股利/利润",
    "category": "conditional",
    "result_metric": "retained_earnings_closing",
    "result_aliases": [
      "未分配利润期末余额",
      "期末未分配利润"
    ],
    "conditions": [
      "使用完整未分配利润变动表；合并口径使用归母净利润。",
      "盈余公积提取、利润分配、前期调整和其他变动完整；重述期初不重复添加已含调整。"
    ],
    "caveat": "附件简式不能省略其他变动；现金支付股利不等于该期间利润分配金额。"
  },
  {
    "id": "audit-reconciliation-18",
    "source_item": 18,
    "title": "营业利润",
    "source_quote": "营业利润 = 营业收入 - 营业成本 - 税金及附加 - 销售费用 - 管理费用 - 研发费用 - 财务费用 + 其他收益 + 投资收益（损失以\"-\"号填列）+ 公允价值变动收益（损失以\"-\"号填列）- 信用减值损失 - 资产减值损失 + 资产处置收益（损失以\"-\"号填列）",
    "category": "conditional",
    "result_metric": "operating_profit",
    "result_aliases": [
      "营业利润"
    ],
    "conditions": [
      "全部利润表组成项目和范围完整，源表收益/损失符号约定有证据。",
      "减值损失若按“损失以负号填列”，应带符号相加；正数损失金额才作减项。"
    ],
    "caveat": "附件对信用及资产减值损失直接相减可能二次减负而颠倒影响；当前只提示条件，不执行简式。"
  },
  {
    "id": "audit-reconciliation-19",
    "source_item": 19,
    "title": "利润总额",
    "source_quote": "利润总额 = 营业利润 + 营业外收入 - 营业外支出",
    "category": "deterministic",
    "result_metric": "total_profit",
    "result_aliases": [
      "利润总额"
    ],
    "terms": [
      {
        "metric": "operating_profit",
        "aliases": [
          "营业利润"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "non_operating_income",
        "aliases": [
          "营业外收入"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "non_operating_expenses",
        "aliases": [
          "营业外支出"
        ],
        "coefficient": -1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "营业利润、营业外收入和支出属于同一完整报告期间；收入和费用展示符号明确。"
    ],
    "caveat": "营业外支出按正数费用金额抵减，不重复反转已被规范化的符号。"
  },
  {
    "id": "audit-reconciliation-20",
    "source_item": 20,
    "title": "净利润",
    "source_quote": "净利润 = 利润总额 - 所得税费用",
    "category": "deterministic",
    "result_metric": "net_profit",
    "result_aliases": [
      "净利润"
    ],
    "terms": [
      {
        "metric": "total_profit",
        "aliases": [
          "利润总额"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "income_tax_expense",
        "aliases": [
          "所得税费用"
        ],
        "coefficient": -1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "利润总额和所得税费用属于同一完整报告期间；所得税收益保留其负费用符号。"
    ],
    "caveat": "净利润指该报表总净利润，不能替换为归母净利润；所得税费用不等于支付所得税现金。"
  },
  {
    "id": "audit-reconciliation-21",
    "source_item": 21,
    "title": "毛利",
    "source_quote": "毛利 = 营业收入 - 营业成本",
    "category": "deterministic",
    "result_metric": "gross_profit",
    "result_aliases": [
      "毛利"
    ],
    "terms": [
      {
        "metric": "operating_revenue",
        "aliases": [
          "营业收入"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "operating_cost",
        "aliases": [
          "营业成本"
        ],
        "coefficient": -1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "营业收入和营业成本属于相同业务范围及完整期间。"
    ],
    "caveat": "主营业务与全部营业业务不得混用；毛利不是毛利率。"
  },
  {
    "id": "audit-reconciliation-22",
    "source_item": 22,
    "title": "主营业务收入与成本配比",
    "source_quote": "主营业务收入与主营业务成本之间通常存在一定的配比关系",
    "category": "manual",
    "result_metric": "main_business_revenue_cost_matching",
    "conditions": [
      "核对业务模式、收入确认、成本结转、期间及政策变化。",
      "如采用比率/阈值，须另有明确业务依据和可比样本。"
    ],
    "caveat": "“通常存在配比关系”没有确定等式或附件支持的固定阈值，不能自动认定收入成本不配比。"
  },
  {
    "id": "audit-reconciliation-23",
    "source_item": 23,
    "title": "净利润归属",
    "source_quote": "净利润 = 归属于母公司所有者的净利润 + 少数股东损益",
    "category": "deterministic",
    "result_metric": "net_profit",
    "result_aliases": [
      "净利润"
    ],
    "terms": [
      {
        "metric": "parent_net_profit",
        "aliases": [
          "归属于母公司所有者的净利润",
          "归属于母公司股东的净利润",
          "归母净利润"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "minority_profit",
        "aliases": [
          "少数股东损益"
        ],
        "coefficient": 1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "仅适用于合并报表；归母净利润和少数股东损益为相同完整期间及范围。"
    ],
    "caveat": "母公司个别报表没有少数股东损益时不能默认填零或套用该归属式。",
    "applicability": "consolidated"
  },
  {
    "id": "audit-reconciliation-24",
    "source_item": 24,
    "title": "综合收益总额",
    "source_quote": "综合收益总额 = 净利润 + 其他综合收益税后净额",
    "category": "deterministic",
    "result_metric": "total_comprehensive_income",
    "result_aliases": [
      "综合收益总额"
    ],
    "terms": [
      {
        "metric": "net_profit",
        "aliases": [
          "净利润"
        ],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "other_comprehensive_income_after_tax",
        "aliases": [
          "其他综合收益税后净额"
        ],
        "coefficient": 1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "净利润和其他综合收益税后净额为同一完整期间，归属范围一致。"
    ],
    "caveat": "不以其他综合收益税前金额或仅归母部分替代报表总税后净额。"
  },
  {
    "id": "audit-reconciliation-25",
    "source_item": 25,
    "title": "现金净流量",
    "source_quote": "现金净流量 = 现金流入 - 现金流出",
    "category": "deterministic",
    "result_metric": "cash_net_flow",
    "terms": [
      {
        "metric": "cash_inflow",
        "aliases": [],
        "coefficient": 1,
        "period_role": "same"
      },
      {
        "metric": "cash_outflow",
        "aliases": [],
        "coefficient": -1,
        "period_role": "same"
      }
    ],
    "conditions": [
      "仅对有原文标签证据的精确 cash_net_flow、cash_inflow、cash_outflow 指标执行。",
      "现金流入和流出为同一活动分类、期间和范围；流出采用正数支出金额。"
    ],
    "caveat": "此为通用活动净流量定义；不靠宽泛中文别名自动合并经营、投资、筹资分类，不把活动净流量当现金及现金等价物净增加额。"
  },
  {
    "id": "audit-reconciliation-26",
    "source_item": 26,
    "title": "现金及现金等价物净增加额",
    "source_quote": "现金及现金等价物净增加额 = 经营活动现金流量净额 + 投资活动现金流量净额 + 筹资活动现金流量净额",
    "category": "conditional",
    "result_metric": "cash_and_cash_equivalents_net_increase",
    "result_aliases": [
      "现金及现金等价物净增加额"
    ],
    "conditions": [
      "完整现金流量表提供经营、投资、筹资及汇率变动对现金及现金等价物影响。",
      "汇率项只有明确不存在或为零的证据才可按零处理。"
    ],
    "caveat": "调整后的方法为三类活动现金流量净额加汇率变动影响；附件三项简式遗漏汇率项。"
  },
  {
    "id": "audit-reconciliation-27",
    "source_item": 27,
    "title": "期末现金余额",
    "source_quote": "期末现金及现金等价物余额 = 期初现金及现金等价物余额 + 现金及现金等价物净增加额",
    "category": "deterministic",
    "result_metric": "cash_and_cash_equivalents",
    "result_aliases": [
      "期末现金及现金等价物余额",
      "现金及现金等价物余额"
    ],
    "terms": [
      {
        "metric": "cash_and_cash_equivalents",
        "aliases": [
          "期初现金及现金等价物余额",
          "现金及现金等价物余额"
        ],
        "coefficient": 1,
        "period_role": "opening"
      },
      {
        "metric": "cash_and_cash_equivalents_net_increase",
        "aliases": [
          "现金及现金等价物净增加额"
        ],
        "coefficient": 1,
        "period_role": "flow"
      }
    ],
    "conditions": [
      "结果为期末时点余额；期初为该流量期间起点的余额，期间连续且现金及现金等价物定义一致。",
      "净增加额为完整期间流量，已包含汇率变动等应计入影响。"
    ],
    "caveat": "用期初/期末证据角色区分相同现金余额指标，不将余额与净增加额混用；重述或范围改变须有桥接。"
  },
  {
    "id": "audit-reconciliation-28",
    "source_item": 28,
    "title": "间接法核心",
    "source_quote": "经营活动现金流量净额 = 净利润 + 不影响经营活动现金流量但减少净利润的项目 - 不影响经营活动现金流量但增加净利润的项目 + 与净利润无关但增加经营活动现金流量的项目 - 与净利润无关但减少经营活动现金流量的项目",
    "category": "manual",
    "result_metric": "operating_cash_flow",
    "result_aliases": [
      "经营活动产生的现金流量净额",
      "经营活动现金流量净额"
    ],
    "conditions": [
      "取得实际现金流量补充资料及完整调整项目。",
      "核对每项调整属于非现金、非经营损益还是经营性资产负债变化，并核对符号。"
    ],
    "caveat": "附件是间接法概念说明，不是可直接运行的完整科目清单；使用第29项的完整补充资料桥接。"
  },
  {
    "id": "audit-reconciliation-29",
    "source_item": 29,
    "title": "间接法展开",
    "source_quote": "经营活动现金流量净额 = 净利润 + 资产减值准备 + 信用减值损失 + 固定资产折旧 + 无形资产摊销 + 长期待摊费用摊销 + 处置固定资产/无形资产/其他长期资产的损失（收益以\"-\"号填列）+ 固定资产报废损失（收益以\"-\"号填列）+ 公允价值变动损失（收益以\"-\"号填列）+ 财务费用（收益以\"-\"号填列）+ 投资损失（收益以\"-\"号填列）+ 递延所得税资产减少（增加以\"-\"号填列）+ 递延所得税负债增加（减少以\"-\"号填列）+ 存货的减少（增加以\"-\"号填列）+ 经营性应收项目的减少（增加以\"-\"号填列）+ 经营性应付项目的增加（减少以\"-\"号填列）",
    "category": "conditional",
    "result_metric": "operating_cash_flow",
    "result_aliases": [
      "经营活动产生的现金流量净额",
      "经营活动现金流量净额"
    ],
    "conditions": [
      "实际现金流量补充资料全部调整行已识别，符号和范围明确。",
      "包含源报告实际存在的使用权资产折旧、“其他”等项目，不重复计入减值或处置调整。",
      "经营性往来及递延税调整采用补充资料，不直接以未经桥接的资产负债表差额代替。"
    ],
    "caveat": "附件展开式可能不完整；资产负债表差额可能含合并、汇率、其他综合收益及非现金变动。"
  },
  {
    "id": "audit-reconciliation-30",
    "source_item": 30,
    "title": "净利润与未分配利润（证监会表述）",
    "source_quote": "资产负债表年初数\"未分配利润\" + 利润表中本年累计数\"净利润\" = 资产负债表期末数\"未分配利润\"",
    "category": "conditional",
    "result_metric": "retained_earnings_closing",
    "result_aliases": [
      "未分配利润期末余额",
      "期末未分配利润"
    ],
    "conditions": [
      "仅在无盈余公积提取、利润分配、前期调整及其他变动的明确证据下使用简式。",
      "期初与本年累计净利润期间衔接，合并口径使用归母净利润。"
    ],
    "caveat": "保留附件“证监会表述”的来源声称，监管出处未验证；无分配和调整不能仅凭缺失信息推断。"
  },
  {
    "id": "audit-reconciliation-31",
    "source_item": 31,
    "title": "净利润与未分配利润（含分配）",
    "source_quote": "期末未分配利润 = 期初未分配利润 + 本期净利润（± 以前年度损益调整）- 提取盈余公积 - 分配股利/利润",
    "category": "conditional",
    "result_metric": "retained_earnings_closing",
    "result_aliases": [
      "未分配利润期末余额",
      "期末未分配利润"
    ],
    "conditions": [
      "完整未分配利润桥接覆盖提取、分配、前期调整及其他变动。",
      "合并口径使用归母净利润；期初已重述时不得重复添加同一调整。"
    ],
    "caveat": "本期利润分配与实际现金支付股利不同；相同变化不能在期初调整和本期桥接重复计入。"
  },
  {
    "id": "audit-reconciliation-32",
    "source_item": 32,
    "title": "动态会计方程",
    "source_quote": "资产 + 费用 = 负债 + 所有者权益 + 收入",
    "category": "manual",
    "result_metric": "dynamic_accounting_equation",
    "conditions": [
      "明确数据为未结账试算等适用体系，收入、费用、权益定义及结账状态可核对。"
    ],
    "caveat": "期末资产负债表权益已包含本期损益，再加当期收入费用可能重复计入利润，不能跨成品报表直接套该概念方程。"
  },
  {
    "id": "audit-reconciliation-33",
    "source_item": 33,
    "title": "现金及现金等价物（证监会表述）",
    "source_quote": "现金流量表中的\"现金及现金等价物净额\" = 资产负债表中的\"货币资金\"期末金额 - \"货币资金\"期初金额（企业不存在可划分为现金等价物的短期投资及不影响变现的定期存款时）",
    "category": "conditional",
    "result_metric": "cash_and_cash_equivalents_net_increase",
    "result_aliases": [
      "现金及现金等价物净增加额"
    ],
    "conditions": [
      "期初、期末都有完整货币资金与现金及现金等价物桥接及一致定义。",
      "排除不符合现金定义的货币资金，纳入货币资金之外符合定义的现金等价物。",
      "净额的原文语义已确认为净增加额，期间与余额起止衔接。"
    ],
    "caveat": "保留附件“证监会表述”的来源声称，监管出处未验证；无短期投资仍不足以证明货币资金差额等于现金净增加额。"
  },
  {
    "id": "audit-reconciliation-34",
    "source_item": 34,
    "title": "期末现金余额",
    "source_quote": "现金流量表\"期末现金及现金等价物余额\" = 资产负债表\"货币资金\"期末余额（须扣除受限货币资金）",
    "category": "conditional",
    "result_metric": "cash_and_cash_equivalents",
    "result_aliases": [
      "期末现金及现金等价物余额",
      "现金及现金等价物余额"
    ],
    "conditions": [
      "同一截止日存在完整现金桥接：货币资金减不符合现金定义金额，加货币资金之外符合定义的现金等价物。",
      "受限/其他排除金额及外部现金等价物的分类有附注证据。"
    ],
    "caveat": "仅扣受限资金可能仍不成立，不能忽略外部现金等价物及其他不符合现金定义的货币资金。"
  },
  {
    "id": "audit-reconciliation-35",
    "source_item": 35,
    "title": "受限货币资金",
    "source_quote": "资产负债表\"货币资金\" - 现金流量表\"现金及现金等价物\" = 附注中\"受限货币资金\"",
    "category": "conditional",
    "result_metric": "restricted_monetary_funds",
    "result_aliases": [
      "受限货币资金"
    ],
    "conditions": [
      "证明受限资金是货币资金与现金及现金等价物之间唯一差异。",
      "不存在货币资金之外的现金等价物及其他排除/调整，且定义与截止日一致。"
    ],
    "caveat": "一般应提供完整桥接；货币资金减现金及现金等价物的差额未必等于附注受限资金。"
  },
  {
    "id": "audit-reconciliation-36",
    "source_item": 36,
    "title": "扩展恒等式",
    "source_quote": "现金及现金等价物净增加额 + 非现金资产净增加额 = 负债净增加额 + 所有者权益净增加额",
    "category": "conditional",
    "result_metric": "liabilities_and_equity_net_increase",
    "conditions": [
      "非现金资产定义为同口径资产总计减现金及现金等价物，包含扣除货币资金之外现金等价物的处理。",
      "资产、负债、权益及现金起止期间、合并范围、重述基线一致。"
    ],
    "caveat": "这是余额变动恒等式；未定义完整现金与非现金资产范围时不能直接套用，也不能视为经营现金流推导。"
  },
  {
    "id": "audit-reconciliation-37",
    "source_item": 37,
    "title": "现金净增加额推导",
    "source_quote": "现金及现金等价物净增加额 = 负债净增加额 + 所有者权益净增加额 - 非现金资产净增加额",
    "category": "conditional",
    "result_metric": "cash_and_cash_equivalents_net_increase",
    "result_aliases": [
      "现金及现金等价物净增加额"
    ],
    "conditions": [
      "非现金资产定义为同口径资产总计减现金及现金等价物。",
      "资产、负债、权益及现金起止期间、合并范围、重述基线一致，完整桥接可追溯。"
    ],
    "caveat": "未定义完整非现金资产范围或现金等价物桥接时，该推导不足以支持明确金额错误。"
  },
  {
    "id": "audit-reconciliation-38",
    "source_item": 38,
    "title": "净利润→经营现金流（间接法）",
    "source_quote": "净利润 ± 经营活动非现金的资产和负债的变化 = 经营活动现金流量净额",
    "category": "manual",
    "result_metric": "operating_cash_flow",
    "result_aliases": [
      "经营活动产生的现金流量净额",
      "经营活动现金流量净额"
    ],
    "conditions": [
      "取得完整间接法补充资料，包括非现金损益、非经营损益及经营性资产负债调整。"
    ],
    "caveat": "只加减经营性资产负债变化可能漏掉折旧、减值、投资损益等调整；与第28/29项关联，当前保留概念提示。"
  },
  {
    "id": "audit-reconciliation-39",
    "source_item": 39,
    "title": "支付的各项税费",
    "source_quote": "支付的各项税费 = 附注中应交税费本期减少 + 直接计入管理费用中的税费",
    "category": "manual",
    "result_metric": "cash_paid_for_taxes",
    "result_aliases": [
      "支付的各项税费"
    ],
    "conditions": [
      "应交税费减少区分现金结算、非现金抵销、重分类及其他减少，核对税种和期间。",
      "直接支付税费、退款、资本化/非经营分类及是否已计入附注减少具有完整桥接。"
    ],
    "caveat": "本期减少不等于全部现金支付，直接管理费用可能重复；附件简式不能直接认定支付税费金额错误。"
  },
  {
    "id": "audit-reconciliation-40",
    "source_item": 40,
    "title": "支付给职工的现金",
    "source_quote": "支付给职工以及为职工支付的现金 = 附注中应付职工薪酬本期减少 + 直接计入管理费用中的与职工相关的费用 + 支付的个人所得税",
    "category": "manual",
    "result_metric": "cash_paid_to_and_for_employees",
    "result_aliases": [
      "支付给职工以及为职工支付的现金"
    ],
    "conditions": [
      "职工薪酬减少区分现金结算、非现金抵销、重分类及其他减少，区分经营和资本化支付。",
      "直接支付职工相关费用、个税代扣代缴及其是否已包含在薪酬现金支出中有完整桥接。"
    ],
    "caveat": "管理费用支付和个税可能已包含在应付薪酬减少或职工现金支出中，重复添加会高估；当前要求人工桥接。"
  }
];

function deepFreeze<T>(value:T):T {
  if(value && typeof value==='object' && !Object.isFrozen(value)){
    for(const nested of Object.values(value as Record<string,unknown>))deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export const AUDIT_RECONCILIATION_KNOWLEDGE = deepFreeze({
  version: 'audit-reconciliation-2026-10-02-v1',
  source_sha256: '0dd2a03aaca23e48b01144594b50451f17806059460ef9567aedd782f1124ecb',
  source_name: '审计报告科目之间的勾稽关系.docx',
  authority: 'internal_method' as const,
  rules,
});
