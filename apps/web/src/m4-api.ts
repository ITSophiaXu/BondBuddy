import type { M4Topic, M4TopicCreateRequest, M4Workspace, M4DraftRequest, M4Draft, M4ViewRequest, M4ViewState,
  M4MessageRequest, M4Message, M4QuoteRequest, M4QuoteResponse, M4ExecuteRequest, M4MaterialPin,
  M4TemplateCreateRequest, M4Template, M4Artifact, Run } from '@bondbuddy/contracts';
import { ApiClient, ApiError } from './api';

export class M4Api {
  constructor(private api:ApiClient, private signal:AbortSignal) {}
  topics(){return this.api.request<{topics:M4Topic[]}>('GET','/m4/topics',undefined,{},this.signal);}
  create(input:M4TopicCreateRequest){return this.api.request<{topic:M4Topic}>('POST','/m4/topics',input,{},this.signal);}
  async workspace(id:string){
    const w=await this.api.request<M4Workspace>('GET',`/m4/topics/${encodeURIComponent(id)}/workspace`,undefined,{},this.signal);
    if(w.topic?.topic_id!==id||w.project?.project_id!==w.topic.project_id||!Array.isArray(w.tasks)||!Array.isArray(w.messages)||!Array.isArray(w.artifacts)||
      w.tasks.some(t=>t.manifest.topic_id!==id||t.events.some(e=>e.run_id!==t.run.run_id))||w.artifacts.some(a=>a.topic_id!==id))throw new ApiError(0,'DATA_UNAVAILABLE');
    return w;
  }
  draft(id:string,input:M4DraftRequest){return this.api.request<{draft:M4Draft}>('PUT',`/m4/topics/${encodeURIComponent(id)}/drafts/${input.input.document_type}`,input,{},this.signal);}
  view(id:string,input:M4ViewRequest){return this.api.request<{view:M4ViewState&{version:number}}>('PUT',`/m4/topics/${encodeURIComponent(id)}/view`,input,{},this.signal);}
  message(id:string,input:M4MessageRequest){return this.api.request<{message:M4Message;run:Run}>('POST',`/m4/topics/${encodeURIComponent(id)}/messages`,input,{},this.signal);}
  quote(id:string,input:M4QuoteRequest){return this.api.request<M4QuoteResponse>('POST',`/m4/topics/${encodeURIComponent(id)}/quote`,input,{},this.signal);}
  execute(id:string,input:M4ExecuteRequest){return this.api.request<{run:Run}>('POST',`/m4/topics/${encodeURIComponent(id)}/execute`,input,{},this.signal);}
  material(id:string,material:M4MaterialPin){return this.api.request<void>('POST',`/m4/topics/${encodeURIComponent(id)}/materials`,{material}, {},this.signal);}
  template(input:M4TemplateCreateRequest){return this.api.request<{template:M4Template}>('POST','/m4/templates',input,{},this.signal);}
  templates(){return this.api.request<{templates:M4Template[]}>('GET','/m4/templates',undefined,{},this.signal);}
  async preview(artifact:M4Artifact){
    const p=await this.api.request<{artifact:M4Artifact;content:string}>('GET',`/m4/artifacts/${encodeURIComponent(artifact.artifact_id)}/versions/${artifact.artifact_version}/preview`,undefined,{},this.signal);
    if(p.artifact?.artifact_id!==artifact.artifact_id||p.artifact.artifact_version!==artifact.artifact_version||p.artifact.sha256!==artifact.sha256||typeof p.content!=='string')throw new ApiError(0,'DATA_UNAVAILABLE');
    return p;
  }
}
