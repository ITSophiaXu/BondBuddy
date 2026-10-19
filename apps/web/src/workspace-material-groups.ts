import { M1_MATERIAL_PARTITIONS } from '@bondbuddy/contracts';
import type { Dto } from './api';
type UploadRole = Dto<'MaterialResponse'>['role'];

/** The same material roles and sections in the live workspace and local design. */
export function updateMaterialPartitions(materials: { role: string }[] = []) {
  const partitions: { label: string; roles: readonly {code: UploadRole; label: string}[]; primary: readonly UploadRole[]; optional?: boolean }[] = [
    {label:'历史／参考募集书（选填）',roles:M1_MATERIAL_PARTITIONS[0].roles.filter(role => role.code === 'historical' || materials.some(m => m.role === role.code)).map(role => ({...role,label:role.code === 'historical' ? '历史／参考募集书' : '已保存参考稿'})),primary:['historical']},
    {label:'审计报告 / 财务报表及附注',roles:M1_MATERIAL_PARTITIONS[1].roles,primary:['audit']},
    {label:'募投项目与权证材料',roles:M1_MATERIAL_PARTITIONS[2].roles,primary:['fundUse']},
    {label:'债务、授信与担保（选填）',roles:M1_MATERIAL_PARTITIONS[4].roles,primary:['debt','bankFacilities','guarantee','collateralMaterials'],optional:true},
    {label:'公司、经营与信用（选填）',roles:[...M1_MATERIAL_PARTITIONS[5].roles,...M1_MATERIAL_PARTITIONS[3].roles].filter(role=>role.code!=='other'),primary:['governance','corporate','business','rating'],optional:true},
    {label:'其他补充材料（选填）',roles:M1_MATERIAL_PARTITIONS[5].roles.filter(role=>role.code==='other'),primary:['other'],optional:true}
  ];
  return partitions;
}
export function reviewMaterialGroups() {
  return [{title:'待复核募集书',roles:['historical','reference'],primary:'historical'}, {title:'审计报告 / 财务报表及附注',roles:['audit','financial','interimFinancial','notes'],primary:'audit'}, {title:'其他核验材料',roles:['other'],primary:'other'}];
}
