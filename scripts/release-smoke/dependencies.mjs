import {posix} from 'node:path';
import {sha256} from './support.mjs';

export function dependencyOptions({nodeImage,cachedCodex,pipIndexUrl}={}){
 if(nodeImage&&(!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(nodeImage)||nodeImage.includes('://')||nodeImage.includes('@')&&!/@sha256:[a-f0-9]{64}$/.test(nodeImage)))throw Error('Invalid local Node image reference');
 if(cachedCodex&&(!nodeImage||!/^\/opt\/[a-zA-Z0-9_./-]+\.tgz$/.test(cachedCodex)||posix.normalize(cachedCodex)!==cachedCodex))throw Error('Cached Codex tarball requires an explicit Node base and a normalized absolute /opt path');
 if(pipIndexUrl){const u=new URL(pipIndexUrl);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('Use an unauthenticated HTTPS pip index URL');}
 return {nodeImage,cachedCodex,pipIndexUrl};
}

export function dependencyDockerfile(original,options){
 const {cachedCodex}=dependencyOptions(options),originalSha256=sha256(Buffer.from(original));
 if(!cachedCodex)return {text:original,originalSha256};
 const acquisition='npm pack "@openai/codex@${CODEX_VERSION}-${pkg}" --silent >/dev/null;';
 const checks=['[ "$got" = "$want" ]','[ "$(/opt/codex/bin/codex --version)" = "codex-cli ${CODEX_VERSION}" ]',"createHash('sha512')"];
 if(original.split(acquisition).length!==2||checks.some(check=>!original.includes(check)))throw Error('Candidate Codex acquisition or verification changed; refusing local dependency adaptation');
 const text=original.replace(acquisition,'cp "'+cachedCodex+'" "openai-codex-${CODEX_VERSION}-${pkg}.tgz";');
 return {text,originalSha256,adaptation:{kind:'cached-official-codex-tarball',pathInNodeBase:cachedCodex,dockerfileSha256:sha256(Buffer.from(text)),note:'Only dependency acquisition changed; original SHA512 integrity and CLI version checks remain. This is not a default Dockerfile build.'}};
}

export function dependencyBuildArgs(options){
 const {nodeImage,pipIndexUrl}=dependencyOptions(options);
 return [...(nodeImage?['--build-arg',`NODE_IMAGE=${nodeImage}`]:[]),...(pipIndexUrl?['--build-arg',`PIP_INDEX_URL=${pipIndexUrl}`]:[])];
}

export function assertNodeBaseUnchanged(record,currentId){
 if(!record||!/^sha256:[a-f0-9]{64}$/.test(record.id)||record.id!==currentId)throw Error('Local Node base image changed during this test');
}
