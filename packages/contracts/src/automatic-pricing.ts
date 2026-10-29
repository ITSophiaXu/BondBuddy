/** Versioned task tariff. Points are not the cash consideration of a wallet lot. */
export const LEGACY_AUTOMATIC_PRICE_VERSION='bb-task-price-170-20261029-v2' as const;
export const AUTOMATIC_PRICE_VERSION='bb-task-price-170-20261029-v3' as const;
export const MANAGED_AUTOMATIC_PRICE_PATTERN='^bb-task-price-managed-[a-f0-9]{32}$';
export type AutomaticPriceVersion=typeof LEGACY_AUTOMATIC_PRICE_VERSION|typeof AUTOMATIC_PRICE_VERSION|`bb-task-price-managed-${string}`;
/** Identifies the policy family only. Servers must also load a published, effective database version. */
export const isAutomaticPriceVersion=(version:unknown):version is AutomaticPriceVersion=>version===LEGACY_AUTOMATIC_PRICE_VERSION||version===AUTOMATIC_PRICE_VERSION||typeof version==='string'&&new RegExp(MANAGED_AUTOMATIC_PRICE_PATTERN).test(version);

/** Planning estimate, NOT measured supplier cost. See the full-review cost decision. */
export const FULL_REVIEW_PLANNED_COST_CNY='7.5454800512' as const;
/** Exact decimal arithmetic, with separate upward rounding at base fen and final points. */
export function automaticPriceFromPlannedCost(costCny:string):{base_fen:number;points:number}{
  if(!/^\d+(?:\.\d{1,12})?$/.test(costCny))throw new RangeError('Invalid standard cost');
  const [whole,fraction='']=costCny.split('.'),scale=10n**BigInt(fraction.length),cost=BigInt(whole)*scale+BigInt(fraction||'0');
  const ceil=(n:bigint,d:bigint)=>(n+d-1n)/d;
  // C_plan / (1 - 0.95) * 1.06 * 100; then multiply by 1.7.
  const base=ceil(cost*2120n,scale),points=ceil(base*17n,10n);
  if(cost<=0n||points>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Invalid standard cost');
  return{base_fen:Number(base),points:Number(points)};
}
/** The eleven published v2 rows are inherited unchanged by v3. Future repricing overrides v3 only. */
const INHERITED_V2_TASK_TARIFF={
  quarter:{base_fen:5214,points:8864,label:'一期更新',unit:'次'},
  annual:{base_fen:11965,points:20341,label:'年度更新',unit:'次'},
  two_year:{base_fen:20335,points:34570,label:'两年补更',unit:'次'},
  three_year:{base_fen:30808,points:52374,label:'三年补更',unit:'次'},
  migration:{base_fen:30368,points:51626,label:'模板或市场迁移',unit:'次'},
  new:{base_fen:51058,points:86799,label:'新项目编制',unit:'次'},
  related:{base_fen:4685,points:7965,label:'关联文件生成',unit:'份'},
  workpaper:{base_fen:2034,points:3458,label:'说明性底稿',unit:'份'},
  integrity:{base_fen:13375,points:22738,label:'官网诚信核查',unit:'轮'},
  response:{base_fen:716,points:1218,label:'问题回复',unit:'题'},
  check:{base_fen:3585,points:6095,label:'一致性检查与维护',unit:'份／轮'},
} as const;
export const AUTOMATIC_TASK_TARIFF={...INHERITED_V2_TASK_TARIFF,
  full_review:{...automaticPriceFromPlannedCost(FULL_REVIEW_PLANNED_COST_CNY),label:'独立全面复核',unit:'份／轮'},
} as const;
export type AutomaticTaskSku=keyof typeof AUTOMATIC_TASK_TARIFF;
export type AutomaticTaskTariff=Record<AutomaticTaskSku,{base_fen:number|null;points:number;label:string;unit:string}>;
/** Public business scope follows the server's trusted-snapshot classification; token use does not add line items. */
export const AUTOMATIC_TASK_TERMS:Record<AutomaticTaskSku,{scope:string[];included:string[]}>= {
  quarter:{scope:['一份募集说明书的一次一期更新；报告期和材料以任务开始时锁定的范围为准。','单次编制材料至多100份。'],included:['本期相关内容更新、必要比较与全文一致性处理，修订版及清洁版Word。','原范围必要检查、修复、支撑材料及平台重试包含在任务内。']},
  annual:{scope:['一份募集说明书的一次年度更新；按原稿与目标年度确定本次新增期间。','单次编制材料至多100份。'],included:['该年度相关披露、必要比较及全文同步，修订版及清洁版Word。','原范围必要检查、修复、支撑材料及平台重试包含在任务内。']},
  two_year:{scope:['一份募集说明书一次补更两个年度；以锁定原稿与目标报告期分类。','单次编制材料至多100份。'],included:['两个年度的相关披露、必要历史对齐及全文同步，修订版及清洁版Word。','原范围必要检查、修复、支撑材料及平台重试包含在任务内。']},
  three_year:{scope:['一份募集说明书一次补更三个年度；超过三个年度的补更需缩小本次任务范围。','单次编制材料至多100份。'],included:['三个年度的相关披露、必要历史对齐及全文同步，修订版及清洁版Word。','原范围必要检查、修复、支撑材料及平台重试包含在任务内。']},
  migration:{scope:['一份募集说明书迁移到已支持的目标市场、品种或模板；按锁定原稿与目标分类。','标准补更至多三个年度，单次编制材料至多100份。'],included:['本次目标结构适配、相关披露调整与全文一致性处理，修订版及清洁版Word。','原范围必要检查、修复、支撑材料及平台重试包含在任务内。']},
  new:{scope:['按目标发行人、市场、品种及报告期，完成一份募集说明书的首次编制。','单次编制材料至多100份；原稿或参考稿可选。'],included:['根据锁定材料和要求编制目标工作稿，交付修订版及清洁版Word。','原范围必要检查、修复、支撑材料及平台重试包含在任务内。']},
  related:{scope:['基于锁定募集书、材料和已开放文件类型，生成一份独立关联文件。','批量选择多份独立成果时，逐份计算积分。'],included:['该文件所需的来源引用、内容组织、必要主稿对应检查与原范围修复。','生成该成果的内部步骤、支撑材料及平台重试不另收费。']},
  workpaper:{scope:['按所选底稿目录条目和锁定募集书生成一份可生成的说明性底稿。','批量底稿逐份计费；另行发起的逐份一致性检查按检查目录计费。'],included:['该条目的必要支撑内容与Word交付，原范围修复及平台重试。','单份失败不重复收取已成功交付的其他底稿费用。']},
  integrity:{scope:['按明确主体名单、适用官网和截至时间执行一轮官网诚信核查。','每轮1至5个主体，至多20个适用官网；重复主体或站点需整理后执行。'],included:['该轮查询结果、出处与待人工处理项及已约定Word成果。','本轮必要核对、原范围修复及平台重试包含在任务内。']},
  response:{scope:['对锁定问题清单中的一项独立问题，基于本轮材料组织问题回复。','单批1至200题，每题至多16000字；按独立问题条目计数。'],included:['该题必要材料核对、引用与回复工作稿；父任务原范围澄清、修复及平台重试。','需要新增独立问题或新的成果范围时，按新任务计费。']},
  check:{scope:['一份关联文件对照锁定募集书，完成一轮一致性检查与维护。','单批至多100份；新材料、期间或用户新上传版本形成新一轮范围。'],included:['本轮差异定位、同范围修订与必要重新校验。','已付本轮检查后，平台修订产生的文件版本继续享受原范围维护；有效已付项目不重复收费。']},
  full_review:{scope:['一份募集说明书与锁定材料的一轮全面复核，覆盖财务、交叉一致性、规则与格式，交付复核报告及批注。','另行委托的差异复核、原文修订各按14,900积分独立计费。'],included:['本轮复核报告与批注的修复、平台重试包含在任务内。']},
};
// The v2 review price was inherited from the earlier product, not derived from C_plan.
const LEGACY_AUTOMATIC_TASK_TARIFF={...INHERITED_V2_TASK_TARIFF,full_review:{base_fen:null,points:14900,label:'独立全面复核',unit:'份／轮'}} as const;
export function automaticTaskTariff(version:AutomaticPriceVersion):AutomaticTaskTariff{
  if(version===LEGACY_AUTOMATIC_PRICE_VERSION)return LEGACY_AUTOMATIC_TASK_TARIFF;
  if(version===AUTOMATIC_PRICE_VERSION)return AUTOMATIC_TASK_TARIFF;
  throw new RangeError('Unsupported automatic price version');
}
export const AUTOMATIC_BILLING_RULES=[
  '明确提出任务后自动执行；后台锁定任务范围及价格，合格交付后自动扣积分，无需逐单确认金额。',
  '必要的读取、检查、修复、支撑底稿和平台重试包含在父任务中，不因内部拆步骤增加费用。',
  '一致性检查包含同范围修订与重新校验；新增材料、期间或独立成果形成新一轮。',
  '月订阅包含积分，每批有效90天；额外充值1元等于100积分，永久有效。旧购买批次保留原权益。',
  '余额不足时保留原任务；从任务入口完成补款后返回即可自动继续，取消的任务不会恢复。',
  '失败或取消释放未结算额度。订阅取消停止未来续费，不提前清除已付额度。',
] as const;
