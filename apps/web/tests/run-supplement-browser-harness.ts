import {ApiClient,type Dto} from '../src/api';
import {RunSupplementDraftPanel} from '../src/run-supplement-draft';
import {ProjectExecution} from '../src/project-execution';
import {Draft} from '../src/draft';
import {ProjectConversation} from '../src/project-conversation';
import {ReviewWorkspace} from '../src/review-workspace';
import {MaterialWorkspace} from '../src/material-workspace';
import '../src/style.css';
import '../../../product-prototype/public/styles.css';
import '../../../product-prototype/public/project-workspace.css';
import '../src/prototype-adapter.css';

// Component harness only: real production components and app styles, with a synthetic shell.
// Static imports keep ApiClient/ApiError in the same Vite module graph as all consumers.
export async function mountSupplementBrowserHarness(input:{surface:'panel'|'m1'|'m3'|'m4';owner:string;project:Dto<'ProjectResponse'>;run:Dto<'RunResponse'>;topic:string}){
  const {surface,owner,project,run,topic}=input,api=new ApiClient(()=>{});
  const holder=window as unknown as {supplementComponent?:{dispose():void};supplementActive?:boolean};holder.supplementActive=true;
  const current=()=>holder.supplementActive===true;
  const shell=(html:string)=>{document.querySelector('.shell')!.innerHTML=html;};
  if(surface==='panel'){
    const component=new RunSupplementDraftPanel(api,owner,project.project_id,run.run_id,current);holder.supplementComponent=component;
    shell('');document.querySelector('.shell')!.append(component.element);component.updateRun(run);await component.ensureLoaded();
  }else if(surface==='m1'){
    const draft=new Draft(project,api,()=>{}),conversation=new ProjectConversation(api,project.project_id,()=>{}),component=new ProjectExecution(api,draft,conversation);
    holder.supplementComponent=component;shell('<section id="execution-host"></section><section id="execution-actions"></section>');
    component.mount(document.querySelector('#execution-host')!,document.querySelector('#execution-actions')!);
  }else if(surface==='m3'){
    const component=new ReviewWorkspace(api,owner,project.project_id,shell,current,undefined,'making',new URLSearchParams({run:run.run_id}));
    holder.supplementComponent=component;await component.render();
  }else{
    const component=new MaterialWorkspace(api,owner,shell,current,topic,undefined,false,run.run_id);
    holder.supplementComponent=component;await component.render();
  }
}
