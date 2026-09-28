/** Canonical M1 material role partitioning shared by public contracts and trusted producers. */
export const M1_MATERIAL_PARTITIONS = [
  { label: '募集说明书', roles: [{ code: 'historical', label: '本企业历史募集书' }, { code: 'reference', label: '相似企业参考募集书' }] },
  { label: '财务与审计', roles: [{ code: 'audit', label: '审计报告（可含报表及附注）' }, { code: 'financial', label: '年度财务报表' }, { code: 'interimFinancial', label: '最近一期财务报表' }, { code: 'notes', label: '财务报表附注' }, { code: 'accountDetails', label: '财务科目明细与辅助账' }] },
  { label: '发行安排与资金用途', roles: [{ code: 'issuancePlan', label: '本期发行方案' }, { code: 'fundUse', label: '募集资金使用计划 / 项目方案' }, { code: 'feasibility', label: '项目可行性研究报告' }, { code: 'priorFundUse', label: '前次募集资金使用说明' }, { code: 'trusteeReport', label: '受托管理事务报告' }, { code: 'resolutions', label: '董事会 / 股东会决议' }] },
  { label: '工商、信用与评级', roles: [{ code: 'corporate', label: '工商及公司资料' }, { code: 'registry', label: '工商登记 / 企业信息公示材料' }, { code: 'credit', label: '征信报告' }, { code: 'creditCompliance', label: '诉讼、失信、处罚及信用核查' }, { code: 'issuerStatement', label: '发行人自查 / 专项说明' }, { code: 'rating', label: '评级报告（主体 / 债项 / 跟踪）' }, { code: 'legal', label: '法律意见书及其他法律文件' }] },
  { label: '债务、授信与担保', roles: [{ code: 'debt', label: '债务明细与融资材料' }, { code: 'bankFacilities', label: '银行授信情况表' }, { code: 'facilityEvidence', label: '银行授信证明材料' }, { code: 'outstandingBonds', label: '存续及历史债券资料' }, { code: 'guarantee', label: '本期增信 / 担保合同' }, { code: 'guarantorMaterials', label: '担保人财务、评级及资质材料' }, { code: 'collateralMaterials', label: '抵质押资产资料' }] },
  { label: '经营、治理与行业', roles: [{ code: 'business', label: '业务经营资料' }, { code: 'governance', label: '章程、治理制度与组织架构' }, { code: 'personnel', label: '董监高及其他人员资料' }, { code: 'industry', label: '行业研究 / 行业统计资料' }, { code: 'other', label: '其他材料' }] },
] as const;

export const M1_UPLOAD_MATERIAL_ROLES = M1_MATERIAL_PARTITIONS.flatMap(partition => partition.roles.map(role => role.code));
