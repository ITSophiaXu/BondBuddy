import type { Dto } from './api';

type UploadRole = Dto<'UploadCreateRequest'>['role'];

// Presentation guidance only; upload roles and allowed media types remain in contracts.
export const OPTIONAL_MATERIAL_GUIDANCE: Partial<Record<UploadRole, { label?: string; hint: string }>> = {
  debt: { label: '有息债务明细表', hint: '借款、债券、非标融资等余额、利率、到期日及担保方式。' },
  guarantee: { label: '担保明细 / 担保合同', hint: '对外担保明细，或本期债券的担保合同、增信安排。' },
  governance: { label: '公司章程 / 治理制度', hint: '现行公司章程、章程修正案、治理制度及组织架构。' },
  bankFacilities: { hint: '各银行授信总额、已用额度、未用额度及有效期。' },
  collateralMaterials: { hint: '抵质押资产清单、权属证明、评估报告等。' },
  corporate: { label: '营业执照 / 公司基本资料', hint: '营业执照、公司简介、股权结构及子公司情况。' },
  business: { hint: '主营业务介绍、分板块经营数据及重大合同等。' },
  rating: { hint: '主体评级、债项评级或最新跟踪评级报告。' },
  other: { label: '其他补充材料', hint: '上述类别未涵盖的专项说明、证明文件等。' },
};

export const OPTIONAL_MATERIAL_FORMATS = '支持 Word（DOCX）、PDF、Excel（XLSX）、CSV、TXT 和图片（PNG / JPG / JPEG）。每类可多选或拖入多份文件。';
