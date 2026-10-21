import { withProjectContext } from './project-navigation';
import { ApiClient } from './api';
import { ProjectEntry } from './project-entry';
export class ReviewEntry extends ProjectEntry {
  constructor(api:ApiClient,shell:(html:string,section:string)=>void,current:()=>boolean){
    super(api,shell,current,{section:'review',title:'复核募集书',eyebrow:'PROSPECTUS REVIEW',
      description:'先选择项目，复用募集书和核验材料，生成带修订痕迹的复核成果。',
      steps:['选择项目','材料与要求','复核结果'],next:'下一步：材料与要求',newHref:'#review?new=1',
      open:async(id,signal)=>{
        const result=await api.request<{project_id:string}>('POST','/projects/'+encodeURIComponent(id)+'/review-entry',{}, {},signal);
        if(current()&&!signal.aborted)location.hash='/projects/'+encodeURIComponent(result.project_id)+'/review?'+withProjectContext(new URLSearchParams({tab:'materials'}));
      }});
  }
}
