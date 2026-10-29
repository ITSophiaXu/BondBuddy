/** Approved task tariff. Values are points, not the cash consideration of a wallet lot. */
export const AUTOMATIC_PRICE_VERSION='bb-task-price-170-20261029-v2' as const;
export const AUTOMATIC_TASK_TARIFF={
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
export type AutomaticTaskSku=keyof typeof AUTOMATIC_TASK_TARIFF;
export const AUTOMATIC_BILLING_RULES=[
  '明确提出任务后自动执行；后台锁定任务范围及价格，合格交付后自动扣积分，无需逐单确认金额。',
  '必要的读取、检查、修复、支撑底稿和平台重试包含在父任务中，不因内部拆步骤增加费用。',
  '一致性检查包含同范围修订与重新校验；新增材料、期间或独立成果形成新一轮。',
  '月订阅包含积分，每批有效90天；额外充值1元等于100积分，永久有效。旧购买批次保留原权益。',
  '余额不足时保留原任务；从任务入口完成补款后返回即可自动继续，取消的任务不会恢复。',
  '失败或取消释放未结算额度。订阅取消停止未来续费，不提前清除已付额度。',
] as const;
export const isAutomaticPriceVersion=(version:unknown):version is typeof AUTOMATIC_PRICE_VERSION=>version===AUTOMATIC_PRICE_VERSION;
