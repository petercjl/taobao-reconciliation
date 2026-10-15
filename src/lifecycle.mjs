import {lstat,readFile,readdir,mkdir,symlink,cp,writeFile,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
export const skillSource=fileURLToPath(new URL('../skill/taobao-reconciliation/',import.meta.url));
async function digest(dir){const rows=[];async function walk(p,relative=''){for(const e of(await readdir(p,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(e.name==='.managed-skill.json')continue;const r=path.join(relative,e.name);if(e.isDirectory())await walk(path.join(p,e.name),r);else if(e.isFile())rows.push([r,createHash('sha256').update(await readFile(path.join(p,e.name))).digest('hex')]);else throw new Error('SKILL_SPECIAL_FILE');}}await walk(dir);return createHash('sha256').update(JSON.stringify(rows)).digest('hex');}
export async function skill(action,o){
 const sourceHash=await digest(skillSource);if(action==='source')return {skill:'taobao-reconciliation',source:skillSource,path:skillSource,sha256:sourceHash};
 const roots={codex:path.join(process.env.CODEX_HOME??path.join(os.homedir(),'.codex'),'skills'),sealseek:path.join(os.homedir(),'.sealseek','skill_pool'),agents:path.join(os.homedir(),'.agents','skills')};
 const root=o['target-dir']??roots[o.agent];if(!root)throw new Error('TARGET_REQUIRED');const target=path.resolve(root,'taobao-reconciliation');let stat;try{stat=await lstat(target);}catch(e){if(e.code!=='ENOENT')throw e;}
 let state='absent',record;if(stat){if(stat.isSymbolicLink()){const {realpath}=await import('node:fs/promises');state=await realpath(target)===await realpath(skillSource)?'current':'foreign-link';}else{try{record=JSON.parse(await readFile(path.join(target,'.managed-skill.json'),'utf8'));state=record.package==='@petercjl/taobao-reconciliation'?(await digest(target)===record.sha256?(record.sha256===sourceHash?'current':'stale'):'modified'):'unmanaged';}catch{state='unmanaged';}}}
 if(action==='status')return {target,state,sourceHash};if(!['install','update'].includes(action))throw new Error('UNKNOWN_SKILL_ACTION');if(state==='current')return {target,state};if(action==='install'&&state!=='absent')throw new Error('TARGET_EXISTS');if(!['absent','stale'].includes(state))throw new Error('SKILL_LOCAL_EDITS_OR_UNMANAGED');
 await mkdir(root,{recursive:true});let backup;if(stat){backup=target+'.backup-'+randomUUID();await rename(target,backup);}
 try{if(process.platform!=='win32'&&o.mode!=='copy')await symlink(skillSource,target,'dir');else{await cp(skillSource,target,{recursive:true,errorOnExist:true,force:false});await writeFile(path.join(target,'.managed-skill.json'),JSON.stringify({package:'@petercjl/taobao-reconciliation',sha256:sourceHash}),{flag:'wx'});}return {target,state:'current',backup:backup??null};}catch(e){if(backup){try{await lstat(target);}catch(x){if(x.code==='ENOENT')await rename(backup,target);}}throw e;}
}
