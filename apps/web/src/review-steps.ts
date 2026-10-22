export function reviewSteps(step:number){
  return `<nav class="stepper" aria-label="复核流程">${['选择项目','材料与要求','复核结果'].map((label,i)=>`${i?'<span class="step-line"></span>':''}<span class="step ${step===i+1?'current':''}" ${step===i+1?'aria-current="step"':''}><b>${step>i+1?'✓':i+1}</b>${label}</span>`).join('')}</nav>`;
}
