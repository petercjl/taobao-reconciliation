import {createHash} from 'node:crypto';
import {cents,yuan,failure} from './money.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const nextDay=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
export function validDay(d){return /^\d{4}-\d{2}-\d{2}$/.test(d??'')&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;}
export function monthPeriod(month){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month??''))throw failure('INVALID_MONTH','月份应为YYYY-MM。');const from=month+'-01';return {from,to:new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10)};}
export function covering(collections,{source,accountId,dataset,from,to}){
 const ranges=collections.filter(c=>c.status==='complete'&&c.scope?.source===source&&c.scope.accountId===accountId&&(dataset?c.scope.dataset===dataset:['ledger','cash'].includes(c.scope.dataset))).map(c=>[c.scope.from,c.scope.to]).sort((a,b)=>a[0].localeCompare(b[0]));
 let cursor=from;for(const [start,end]of ranges){if(end<cursor)continue;if(start>cursor)break;cursor=nextDay(end);if(cursor>to)return true;}return cursor>to;
}
export function balanceGrade(b,policy={}){
 if(!b||b.status!=='available'||b.currency!=='CNY'||!Number.isFinite(Date.parse(b.effectiveAt)))return null;
 cents(b.total);
 if(['official_statement','account_snapshot'].includes(b.sourceKind))return 'independent';
 if(b.sourceKind==='user_confirmed'&&policy.allowConfirmed===true&&b.confirmedAt&&typeof b.evidence==='string'&&b.evidence.trim())return 'confirmed';
 if(b.sourceKind==='anchored_reconstruction'&&policy.allowReconstructed===true&&b.evidence?.anchor&&b.evidence?.interval&&b.evidence?.eventHash&&b.evidence?.collectionRefs?.length)return 'reconstructed';
 return null;
}
const instant=v=>Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(v??'')?v:String(v).length===10?v+'T00:00:00+08:00':String(v).replace(' ','T')+'+08:00');
const localDay=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
function eligible(events,anchor,target){
 const start=Math.min(instant(anchor.effectiveAt),instant(target)),end=Math.max(instant(anchor.effectiveAt),instant(target));
 return events.filter(e=>e.role!=='supporting'&&e.source===anchor.source&&e.accountId===anchor.accountId).filter(e=>{const raw=e.raw??{};const at=instant(raw.tradeTime??raw.accountTime??raw.createTime??e.date);if(!Number.isFinite(at))throw failure('DATE_UNSUPPORTED','重建余额缺少可识别的资金时间。');return at>=start&&at<end;});
}
function unique(rows){const seen=new Map();for(const e of rows){const k=e.source+':'+e.accountId+':'+e.id;const before=seen.get(k);if(before&&hash(before.raw)!==hash(e.raw))throw failure('CONFLICTING_DUPLICATE','余额证据存在冲突流水。');seen.set(k,e);}return [...seen.values()];}
export function reconstructBalance({anchor,target,events,collections,policy={}}){
 if(!balanceGrade(anchor,policy))throw failure('BALANCE_ANCHOR_REQUIRED','需要有来源的余额锚点。');
 const a=instant(anchor.effectiveAt),t=instant(target);if(!Number.isFinite(t))throw failure('INVALID_BALANCE_TIME','余额时点无效。');
 const from=localDay(Math.min(a,t)),to=localDay(Math.max(a,t)-1);
 if(a!==t&&!covering(collections,{source:anchor.source,accountId:anchor.accountId,from,to}))throw failure('BALANCE_COVERAGE_GAP','余额锚点至目标边界之间缺完整资金流水。');
 const rows=unique(eligible(events,anchor,target));const net=rows.reduce((s,e)=>s+BigInt(e.amountCents),0n);const total=cents(anchor.total)+(t>=a?net:-net);
 return {schemaVersion:1,source:anchor.source,accountId:anchor.accountId,shopKey:anchor.shopKey,currency:'CNY',status:'available',effectiveAt:target,total:yuan(total),sourceKind:'anchored_reconstruction',
  evidence:{anchor:{effectiveAt:anchor.effectiveAt,total:anchor.total,sourceKind:anchor.sourceKind,sourceRef:anchor.sourceRef??anchor.evidenceRef??null},interval:{from,to},eventCount:rows.length,eventHash:hash(rows.map(e=>[e.id,e.amountCents,e.raw])),collectionRefs:collections.filter(c=>c.scope?.source===anchor.source&&c.scope.accountId===anchor.accountId&&c.status==='complete').map(c=>c.input??c.manifestPath??c.runId??'provided-collection')},note:'由已保存锚点及完整流水重建，不是官方历史余额。'};
}
export function resolveMonthBalances({plan,events,balances,collections}){
 for(const b of balances)if(b.shopKey&&plan.shopKey&&b.shopKey!==plan.shopKey)throw failure('ACCOUNT_SCOPE_MISMATCH','余额证据属于其他店铺。');
 const policy=plan.balancePolicy??{};const targets=[plan.period.from+'T00:00:00+08:00',nextDay(plan.period.to)+'T00:00:00+08:00'];const resolved=[...balances],anchorChecks=[];
 for(const account of plan.accounts){
  const anchors=balances.filter(b=>b.source===account.source&&b.accountId===account.accountId&&balanceGrade(b,policy)).sort((a,b)=>instant(a.effectiveAt)-instant(b.effectiveAt));
  for(let i=1;i<anchors.length;i++){
   if(anchors[i].effectiveAt===anchors[i-1].effectiveAt){if(cents(anchors[i].total)!==cents(anchors[i-1].total))throw failure('BALANCE_CONFLICT','同一账户同一时点存在冲突余额。');continue;}
   try{const rebuilt=reconstructBalance({anchor:anchors[i-1],target:anchors[i].effectiveAt,events,collections,policy});const residual=cents(rebuilt.total)-cents(anchors[i].total);anchorChecks.push({source:account.source,from:anchors[i-1].effectiveAt,to:anchors[i].effectiveAt,residual:yuan(residual),status:residual===0n?'passed':'failed'});}catch(e){if(e.code!=='BALANCE_COVERAGE_GAP')throw e;}
  }
  if(policy.allowReconstructed!==true)continue;
  for(const target of targets){if(anchors.some(b=>b.effectiveAt===target))continue;const choices=[...anchors].sort((a,b)=>Math.abs(instant(a.effectiveAt)-instant(target))-Math.abs(instant(b.effectiveAt)-instant(target)));
   for(const anchor of choices){try{resolved.push(reconstructBalance({anchor,target,events,collections,policy}));break;}catch(e){if(e.code!=='BALANCE_COVERAGE_GAP')throw e;}}
  }
 }
 return {balances:resolved,anchorChecks};
}
