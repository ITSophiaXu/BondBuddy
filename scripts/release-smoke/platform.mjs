import {execFileSync} from 'node:child_process';
import {chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,win32} from 'node:path';

// Keep OS process-launch variables, but never inherit production application,
// payment, model, database or remote Docker connection variables.
export function hostEnvironment(source=process.env,home=homedir()){
 // Docker Desktop locates system CLI plugins (buildx/compose) through
 // ProgramFiles. PATH alone locates docker.exe, but not those plugins.
 const allowed=['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','TEMP','TMP','ProgramFiles'];
 const result={HOME:home,DOCKER_BUILDKIT:'1'};
 for(const name of allowed){const key=Object.keys(source).find(k=>k.toLowerCase()===name.toLowerCase());if(key&&source[key])result[name]=source[key];}
 return result;
}

// Compose long bind syntax avoids treating a Windows drive letter as the
// separator between the host path and container path. No shell is involved.
export function bindMount(source,target,platform=process.platform){
 return {type:'bind',source:platform==='win32'?win32.resolve(source).replaceAll('\\','/'):source,target,read_only:true,bind:{create_host_path:false}};
}

export function archiveExecutable(env){
 return process.platform==='win32'?join(env.SystemRoot||env.WINDIR,'System32','tar.exe'):'tar';
}

const aclScript=String.raw`
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$directory = $env:BB_RELEASE_PRIVATE_KIND -eq 'directory'
function Test-PrivateAcl($value) {
  if (!$value.AreAccessRulesProtected -or $value.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { return $false }
  $rules = @($value.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) { return $false }
  $inherit = [System.Security.AccessControl.InheritanceFlags]::None
  if ($directory) { $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit }
  foreach ($sid in @($user, $system)) {
    $match = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid.Value -and $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $_.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and $_.InheritanceFlags -eq $inherit -and $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and !$_.IsInherited })
    if ($match.Count -ne 1) { return $false }
  }
  return $true
}
# Resume often reaches an already protected path. Re-applying a fresh security
# descriptor can request Windows audit privileges even when no access changes.
# Only an exact owner/access policy match permits this read-only fast path.
if (Test-PrivateAcl (Get-Acl -LiteralPath $env:BB_RELEASE_PRIVATE_PATH)) { exit 0 }

if ($directory) { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
else { $acl = [System.Security.AccessControl.FileSecurity]::new() }
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user, $system)) {
  if ($directory) {
    $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  } else {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
  }
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $env:BB_RELEASE_PRIVATE_PATH -AclObject $acl
if (!(Test-PrivateAcl (Get-Acl -LiteralPath $env:BB_RELEASE_PRIVATE_PATH))) { throw "Private path access policy was not applied" }
`;

export function protectPrivatePath(path,kind,env){
 if(process.platform!=='win32'){chmodSync(path,kind==='directory'?0o700:0o444);return;}
 // chmod alone does not restrict Windows ACLs. The file stays writable by its
 // owner for cleanup; the container bind itself is read-only.
 if(kind==='file')chmodSync(path,0o600);
 const root=env.SystemRoot||env.WINDIR;
 if(!root)throw Error('Windows SystemRoot is missing');
 execFileSync(join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',aclScript],{
  env:{...env,BB_RELEASE_PRIVATE_PATH:path,BB_RELEASE_PRIVATE_KIND:kind},windowsHide:true,stdio:'pipe',timeout:30000,
 });
}
