import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {cents,yuan} from './money.mjs';
import {balanceGrade,covering} from './balance-evidence.mjs';
export {cents,yuan} from './money.mjs';
export const error=(code,message)=>Object.assign(new Error(message),{code});
const sha=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const money=v=>v==null?0n:cents(v);
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function normalize(source,dataset,r,scope,ref){
 const common={source,dataset,accountId:scope.accountId,shopKey:scope.shopKey,currency:'CNY',sourceRef:ref,raw:r};
 if(source==='alipay'&&dataset==='ledger')return {...common,id:String(r.accountLogId??sha(r)),date:r.tradeTime??r.transDate,amountCents:money(r.tradeAmount).toString(),description:[r.bizDesc,r.transMemo].filter(Boolean).join(' '),orderId:String(r.bizOrigNo??''),afterBalance:r.balance??null};
 if(source==='aggregate'&&dataset==='ledger')return {...common,id:String(r.id??sha(r)),date:r.accountTime,amountCents:(money(r.inflowAmount)-money(r.outflowAmount)).toString(),description:[r.transType,r.stlBillInfo,r.memo].filter(Boolean).join(' '),orderId:String(r.tradeId??'')};
 if(source==='deposit'&&dataset==='cash'){
  if(!/^-?\d+$/.test(String(r.amount))||!['1','2'].includes(String(r.amountOperationType)))throw error('DEPOSIT_SCHEMA_CHANGED','保证金金额或方向无效。');
  return {...common,id:String(r.jourId??sha(r)),date:r.createTime??r.bizDate,amountCents:((String(r.amountOperationType)==='1'?1n:-1n)*BigInt(r.amount)).toString(),description:[r.bizDesc,r.reason].filter(Boolean).join(' '),orderId:String(r.mainOrderId??''),afterBalanceCents:r.totalCurrAmount==null?null:String(r.totalCurrAmount)};
 }return {...common,id:String(r.bizNo??r.id??sha(r)),date:source==='taobao'?(r.billCycle??r.bizDate??r.accountTime):(r.bizDate??r.accountTime??r.billCycle??r.frozenDate??r.ds??r.atime??r.gmtCreate??r.createdAt),role:'supporting'};
}
export function classify(e,rules=[]){
 for(const r of rules){if(r.source&&r.source!==e.source)continue;if(r.dataset&&r.dataset!==e.dataset)continue;if(r.descriptionIncludes&&e.description?.includes(r.descriptionIncludes))return r.category;}
 const t=e.description??'';
 if(e.source==='deposit'){
  if(/缴存|充值|补缴|补充|补足/.test(t)&&BigInt(e.amountCents)>0n)return 'transfer';
  if(/运费/.test(t)&&BigInt(e.amountCents)<0n)return 'freight';
  if(/退回|解缴|划转|退款|赔付|扣|运费/.test(t))return BigInt(e.amountCents)<0n?'deposit-debit':'transfer';return 'unknown';
 }
 if(/^0020002\|/.test(t))return 'refund';
 if(/保证金/.test(t))return 'transfer';
 if(/品牌新享|营销托管/.test(t))return 'marketing';
 if(/基础软件|0030130/.test(t))return 'software';
 if(/消费者体验|0170125T/.test(t))return 'consumer-service';
 if(/0010001|交易收款|交易货款|货款收入/.test(t))return 'sales';
 if(/0020002|交易退款/.test(t))return 'refund';
 if(/赔付|赔偿|权益红包/.test(t))return 'compensation';
 if(/运费|物流|快递/.test(t))return 'freight';
 return 'unknown';
}
function point(date){if(/^\d{6}$/.test(date??''))return date.slice(0,4)+'-'+date.slice(4,6)+'-01';if(/^\d{8}$/.test(date??''))return date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8);return String(date??'').slice(0,10);}
function monthEdges(from,to){const out=[{from,to}];let d=from;while(d<=to){const dt=new Date(d+'T00:00:00Z');const last=new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth()+1,0)).toISOString().slice(0,10);const end=last<to?last:to;if(d!==from||end!==to)out.push({from:d,to:end});d=new Date(Date.parse(end+'T00:00:00Z')+86400000).toISOString().slice(0,10);}return out;}
const edge=d=>d+'T00:00:00+08:00';const after=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
export function analyze({plan,events,balances,collections=[]}){
 if(plan.schemaVersion!==1||!/^\d{4}-\d{2}-\d{2}$/.test(plan.period?.from??'')||!/^\d{4}-\d{2}-\d{2}$/.test(plan.period?.to??'')||plan.period.from>plan.period.to||!Array.isArray(plan.accounts)||plan.accounts.length!==3||new Set(plan.accounts.map(a=>a.source)).size!==3||!['alipay','aggregate','deposit'].every(s=>plan.accounts.some(a=>a.source===s)))throw error('INPUT_SCOPE_REQUIRED','需要日期和三个明确资金账户。');
 const validCategories=['sales','refund','marketing','software','consumer-service','compensation','freight','transfer','deposit-debit','external-in','external-out','unknown'];
 const normalized=[],duplicates=[],supporting=[],seen=new Map();
 for(const e of events){if(e.currency!=='CNY'||e.raw?.currency&&e.raw.currency!=='CNY')throw error('CURRENCY_UNSUPPORTED','只支持人民币账户。');const d=point(e.date);if(d.length!==10)throw error('DATE_UNSUPPORTED','账单时间无法归入分析日期。');if(d.length!==10||d<plan.period.from||d>plan.period.to)continue;
  const key=[e.source,e.dataset,e.accountId,e.id].join(':');if(seen.has(key)){if(sha(seen.get(key).raw)!==sha(e.raw))throw error('CONFLICTING_DUPLICATE','同一流水ID出现不同内容。');duplicates.push({id:e.id,sourceRef:e.sourceRef});continue;}seen.set(key,e);
  if(e.role==='supporting'){supporting.push(e);continue;}
  if(!plan.accounts.some(a=>a.source===e.source&&a.accountId===e.accountId))throw error('ACCOUNT_SCOPE_MISMATCH','账单账户不在分析范围。');
  const category=classify(e,plan.rules);if(!validCategories.includes(category))throw error('INVALID_CATEGORY','分类规则返回未知分类。');normalized.push({...e,date:d,category});
 }
 const associations=[],unmatched=[];const used=new Set();
 // Verified platform codes plus order, day and exact opposite amount establish a unique account bridge.
 const manualKeys=new Set((plan.transferPairs??[]).flatMap(p=>[p.from,p.to]).map(p=>p.source+':'+p.id));
 for(const d of normalized.filter(e=>e.source==='deposit'&&e.orderId&&!manualKeys.has(e.source+':'+e.id))){
  const amount=BigInt(d.amountCents);const code=(d.description??'').split('|')[0];
  const target=amount>0n&&['008002800014','008002800015'].includes(code)?code:amount<0n?'008002800010':null;
  if(!target)continue;
  const matches=normalized.filter(a=>a.source==='alipay'&&!used.has(a)&&!manualKeys.has(a.source+':'+a.id)&&a.orderId===d.orderId&&a.date===d.date&&a.description?.startsWith(target+'|')&&BigInt(a.amountCents)+amount===0n);
  const reverse=normalized.filter(a=>a.source==='deposit'&&a.orderId===d.orderId&&a.date===d.date&&a.amountCents===d.amountCents);
  if(matches.length===1&&reverse.length===1){const a=matches[0];used.add(a);used.add(d);a.category='transfer';d.category='transfer';associations.push({from:{source:a.source,id:a.id},to:{source:d.source,id:d.id},method:'platform-code-order-day-opposite-amount',evidence:[a.sourceRef,d.sourceRef]});}
 }
 // Caller-specified pairs need explicit evidence in addition to opposite amounts.
 for(const pair of plan.transferPairs??[]){const a=normalized.find(e=>e.source===pair.from.source&&e.id===pair.from.id);const b=normalized.find(e=>e.source===pair.to.source&&e.id===pair.to.id);if(!a||!b||a.accountId===b.accountId&&a.source===b.source||BigInt(a.amountCents)+BigInt(b.amountCents)!==0n||used.has(a)||used.has(b)||!pair.evidence)throw error('INVALID_TRANSFER_PAIR','转账关联需要两个不同账户、相反等额流水与证据。');used.add(a);used.add(b);a.category='transfer';b.category='transfer';associations.push(pair);}
 for(const e of normalized)if(e.category==='transfer'&&!used.has(e))unmatched.push({source:e.source,id:e.id,amountCents:e.amountCents,sourceRef:e.sourceRef});
 const bridges=[];
 for(const period of monthEdges(plan.period.from,plan.period.to))for(const a of plan.accounts){const rows=normalized.filter(e=>e.source===a.source&&e.accountId===a.accountId&&e.date>=period.from&&e.date<=period.to);const net=rows.reduce((s,e)=>s+BigInt(e.amountCents),0n);const find=at=>balances.find(b=>b.source===a.source&&b.accountId===a.accountId&&b.effectiveAt===at&&balanceGrade(b,plan.balancePolicy));const begin=find(edge(period.from)),end=find(edge(after(period.to)));const delta=begin&&end?cents(end.total)-cents(begin.total):null;const grades=[balanceGrade(begin,plan.balancePolicy),balanceGrade(end,plan.balancePolicy)];const quality=grades.includes(null)?'unavailable':grades.includes('reconstructed')?'reconstructed':grades.includes('confirmed')?'confirmed':'independent';bridges.push({source:a.source,accountId:a.accountId,period,opening:begin?.total??null,closing:end?.total??null,net:yuan(net),residual:delta==null?null:yuan(net-delta),evidenceQuality:quality,openingEvidence:begin?.sourceKind??null,closingEvidence:end?.sourceKind??null,status:delta==null?'partial':net!==delta?'failed':quality==='reconstructed'?'provisional':quality==='confirmed'?'confirmed':'passed'});}
 const unknown=normalized.filter(e=>e.category==='unknown');const totals={};for(const e of normalized)if(e.category!=='transfer')totals[e.category]=(BigInt(totals[e.category]??0)+BigInt(e.amountCents)).toString();
 const accountCoverage=plan.accounts.map(a=>({...a,complete:covering(collections,{...a,...plan.period})}));
 const missingDatasets=(plan.requiredDatasets??[]).filter(d=>!covering(collections,{...d,accountId:d.accountId??collections.find(c=>c.scope?.source===d.source&&c.scope.dataset===d.dataset)?.scope.accountId,...plan.period}));
 const supportLinks=[],unmatchedSupporting=[];
 for(const e of supporting){const r=e.raw;if(e.source!=='taobao'||!['goods_income','settle_common','service_charge'].includes(r.billCode))continue;
 const category=r.billCode==='goods_income'?'sales':r.billCode==='service_charge'?'consumer-service':'software';
 const amount=r.billCode==='goods_income'?r.actualOrderAmountYuan:r.billCode==='service_charge'?r.billAmount:r.curAmount;
 const id=String(r.orderId??r.mainTradeIdAdd??r.tradeId??'');
 const hits=id&&amount!=null?normalized.filter(n=>n.category===category&&n.orderId===id&&(BigInt(n.amountCents)<0n?-BigInt(n.amountCents):BigInt(n.amountCents))===cents(amount)):[];
 if(hits.length===1)supportLinks.push({supportId:e.id,cashSource:hits[0].source,cashId:hits[0].id,method:'exact-order-and-amount',sourceRef:e.sourceRef});else unmatchedSupporting.push({id:e.id,sourceRef:e.sourceRef,category,reason:hits.length?'ambiguous':'no-exact-match'});
 }
 const groups=new Map();
 for(const e of supporting){const r=e.raw;if(e.source!=='taobao'||!['goods_income','settle_common'].includes(r.billCode))continue;const id=String(r.orderId??r.mainTradeIdAdd??r.tradeId??'');if(!id)continue;const key=r.billCode+':'+id;const g=groups.get(key)??{category:r.billCode==='goods_income'?'sales':'software',orderIds:new Set([id]),support:[],amount:0n};g.support.push(e);if(r.subOrderId)g.orderIds.add(String(r.subOrderId));g.amount+=money(r.billCode==='goods_income'?r.actualOrderAmountYuan:r.curAmount);groups.set(key,g);}
 const groupedIds=new Set();
 for(const g of groups.values()){if(!g.support.some(e=>unmatchedSupporting.some(u=>u.id===e.id)))continue;const cash=normalized.filter(n=>n.category===g.category&&g.orderIds.has(n.orderId));const sum=cash.reduce((s,n)=>s+(BigInt(n.amountCents)<0n?-BigInt(n.amountCents):BigInt(n.amountCents)),0n);if(cash.length&&sum===g.amount){g.support.forEach(e=>groupedIds.add(e.id));supportLinks.push({supportIds:g.support.map(e=>e.id),cashIds:cash.map(e=>({source:e.source,id:e.id})),method:'order-group-exact-total',sourceRefs:g.support.map(e=>e.sourceRef)});}}
 const monthlyServiceLinks=[];const monthlyMatched=new Set();
 for(const e of supporting.filter(e=>e.source==='taobao'&&e.raw.billCode==='service_charge')){
  const r=e.raw;const cycle=String(r.billCycle??'').replace(/-/g,'');if(!/^\d{6}$/.test(cycle))continue;const month=cycle.slice(0,4)+'-'+cycle.slice(4,6);const last=new Date(Date.UTC(Number(cycle.slice(0,4)),Number(cycle.slice(4,6)),0)).toISOString().slice(0,10);
  if(plan.period.from>month+'-01'||plan.period.to<last)continue;
  const rows=normalized.filter(n=>n.category==='consumer-service'&&n.date.startsWith(month));const net=rows.reduce((s,n)=>s-BigInt(n.amountCents),0n);
  if(rows.length&&net===money(r.billAmount)){monthlyMatched.add(e.id);monthlyServiceLinks.push({supportId:e.id,month,billedAmount:String(r.billAmount),cashAmount:yuan(net),cashIds:rows.map(n=>({source:n.source,id:n.id})),method:'full-month-exact-category-net',sourceRef:e.sourceRef});}
 }
 supportLinks.push(...monthlyServiceLinks);
 const remainingSupporting=unmatchedSupporting.filter(e=>!groupedIds.has(e.id)&&!monthlyMatched.has(e.id));
 const blockers=[];if(!plan.requiredDatasets?.some(d=>d.source==='taobao'))blockers.push('平台业务明细尚未完整纳入');if(remainingSupporting.length)blockers.push('部分平台明细尚未与资金流水唯一关联');if(normalized.some(e=>e.category==='deposit-debit'))blockers.push('保证金扣款用途或镜像关系尚待核实');if(unknown.length)blockers.push('存在未分类资金流水');if(unmatched.length)blockers.push('存在未关联内部转账');if(accountCoverage.some(a=>!a.complete))blockers.push('资金流水覆盖不足');if(missingDatasets.length)blockers.push('指定费用账单覆盖不足');if(plan.bindingConfirmed!==true)blockers.push('店铺和账户归属尚待确认');if(bridges.some(b=>b.status==='partial'))blockers.push('部分期初或期末独立余额缺失');
 if(bridges.some(b=>b.status==='provisional'))blockers.push('部分月界余额由有来源锚点重建，未取得独立月结余额');
 const status=bridges.some(b=>b.status==='failed')?'failed':blockers.length?'partial':'passed';
 const consolidated=monthEdges(plan.period.from,plan.period.to).map(period=>{const group=bridges.filter(b=>b.period.from===period.from&&b.period.to===period.to);const known=group.every(b=>b.residual!==null);return {period,net:yuan(group.reduce((s,b)=>s+cents(b.net),0n)),residual:known?yuan(group.reduce((s,b)=>s+cents(b.residual),0n)):null,status:group.some(b=>b.status==='failed')?'failed':!known?'partial':group.some(b=>b.status==='provisional')?'provisional':group.some(b=>b.status==='confirmed')?'confirmed':'passed'};});
 const ratio=(n,d)=>d===0n?null:(Number(n*10000n/d)/100).toFixed(2)+'%';
 const explain=rows=>{const sum=cat=>rows.filter(e=>e.category===cat).reduce((s,e)=>s+BigInt(e.amountCents),0n);const sales=sum('sales'),refund=-sum('refund');const fees=['marketing','software','consumer-service','compensation','freight'].map(category=>({category,netExpense:yuan(-sum(category)),shareOfSales:ratio(-sum(category),sales)}));return {sales:yuan(sales),refunds:yuan(refund),netSales:yuan(sales-refund),refundRate:ratio(refund,sales),fees,netCashChange:yuan(rows.reduce((s,e)=>s+BigInt(e.amountCents),0n))};};
 const incomeExpenses=explain(normalized);const monthly=[...new Set(normalized.map(e=>e.date.slice(0,7)))].sort().map(month=>({month,...explain(normalized.filter(e=>e.date.startsWith(month)))}));const channels=plan.accounts.map(a=>({source:a.source,...explain(normalized.filter(e=>e.source===a.source&&e.accountId===a.accountId))}));
 const net=normalized.reduce((s,e)=>s+BigInt(e.amountCents),0n);
 return {schemaVersion:1,status,shopKey:plan.shopKey,period:plan.period,currency:'CNY',timezone:'Asia/Shanghai',analysisBasis:'资金发生日；费用和收入以实际资金流水为主，平台明细为补充证据。',netCashChange:yuan(net),incomeExpenses,monthly,channels,consolidated,categories:Object.entries(totals).map(([category,v])=>({category,netAmount:yuan(BigInt(v)),rows:normalized.filter(e=>e.category===category).length})),bridges,unknown,unmatchedTransfers:unmatched,associations,duplicates,accountCoverage,missingDatasets,blockers,normalized,supporting,supportLinks,unmatchedSupporting:remainingSupporting,limitations:['本报告分析指定三个账户的现金收支，净现金变化不等于经营利润。','平台收入与费用明细作为辅助资料，尚未建立逐笔跨账单覆盖映射时不能证明所有业务均已识别。','保证金历史独立余额不可用时，完整性自检保持 partial。','万相台推广账户及其消耗暂未纳入；商品成本、税费和平台外费用需另行补充。']};
}
export async function loadInput(file){const full=path.resolve(file);const plan=JSON.parse(await readFile(full,'utf8'));const resolve=p=>path.resolve(path.dirname(full),p);const events=[],collections=[],balances=[];for(const entry of plan.inputs??[]){const fp=resolve(entry);const m=JSON.parse(await readFile(fp,'utf8'));if(m.schemaVersion!==1||!m.scope||m.scope.shopKey!==plan.shopKey||!Array.isArray(m.shards))throw error('CONTRACT_UNSUPPORTED','需要 tbcli 财务 manifest v1。');collections.push({...m,input:fp});for(const s of m.shards){const p=path.resolve(path.dirname(fp),s.file);if(path.dirname(p)!==path.dirname(fp))throw error('UNSAFE_REFERENCE','分片必须在 manifest 所在目录。');const v=JSON.parse(await readFile(p,'utf8'));if(v.sha256!==s.sha256||sha(v.payload)!==s.sha256)throw error('EVIDENCE_CHANGED','原始分片哈希不符。');for(const r of v.payload.rows)events.push(normalize(m.scope.source,m.scope.dataset,r,m.scope,`${fp}#${s.file}`));}}
 for(const f of plan.balances??[])balances.push(JSON.parse(await readFile(resolve(f),'utf8')));return {plan,events,collections,balances,balanceInputs:(plan.balances??[]).map(resolve)};}
export function render(r){const labels={sales:'货款收入',refund:'退款',marketing:'品牌新享营销托管',software:'基础软件服务费','consumer-service':'消费者体验服务费',compensation:'赔付',freight:'运费',unknown:'未分类','deposit-debit':'保证金扣款待关联','external-in':'外部注资','external-out':'外部转出'};const table=(headers,rows)=>`<table><thead><tr>${headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>'<tr>'+row.map(v=>`<td>${escape(v??'未知')}</td>`).join('')+'</tr>').join('')}</tbody></table>`;
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>淘宝收入费用分析</title><style>body{font:16px/1.7 system-ui;background:#f6f5f1;color:#25352f;max-width:1100px;margin:40px auto;padding:24px}h1{font-size:32px}section{background:white;border-radius:14px;padding:24px;margin:20px 0}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}small{color:#65766d}.metric{font-size:30px;color:#146554}</style><h1>淘宝店铺收入与费用</h1><p>${escape(r.shopKey)} · ${r.period.from} 至 ${r.period.to}</p><section><small>三个资金账户净现金变化</small><div class="metric">¥ ${r.netCashChange}</div><p>数据完整性：${escape(r.status)}。${escape(r.analysisBasis)}</p>${r.blockers.map(b=>'<p>• '+escape(b)+'</p>').join('')}</section><section><h2>收入与费用构成</h2>${table(['项目','净额（元）','流水笔数'],r.categories.map(c=>[labels[c.category]??c.category,c.netAmount,c.rows]))}</section><section><h2>月度收入费用</h2>${table(['月份','货款收入','退款','退款率','现金净变化'],r.monthly.map(m=>[m.month,m.sales,m.refunds,m.refundRate,m.netCashChange]))}<p>费用率以对应净费用除以货款收入，零收入时留空。</p>${table(['费用项目','净费用（元）','占货款比例'],r.incomeExpenses.fees.map(f=>[labels[f.category],f.netExpense,f.shareOfSales]))}</section><section><h2>收款渠道</h2>${table(['资金账户','货款收入','退款','现金净变化'],r.channels.map(c=>[c.source,c.sales,c.refunds,c.netCashChange]))}</section><section><h2>账户余额桥接</h2>${table(['账户','期间','期初','期末','流水净额','差额','状态'],r.bridges.map(b=>[b.source,b.period.from+' ~ '+b.period.to,b.opening,b.closing,b.net,b.residual,b.status]))}</section><section><h2>待核实范围</h2>${r.limitations.map(x=>'<p>'+escape(x)+'</p>').join('')}<p>未分类 ${r.unknown.length} 笔；待关联转账 ${r.unmatchedTransfers.length} 笔；待核对平台明细 ${r.unmatchedSupporting.length} 条；重复记录 ${r.duplicates.length} 笔。</p>${table(['待核对明细','类型','原因'],r.unmatchedSupporting.map(e=>[e.id,labels[e.category]??e.category,e.reason]))}<p>原始分片、完整来源路径和关联证据见同目录 analysis.json；输入文件哈希见 manifest.json。</p></section></html>`;
}
export async function analyzeFile(input,out){const data=await loadInput(input);const r=analyze(data);try{await lstat(out);throw error('OUTPUT_EXISTS','输出目录已存在。');}catch(e){if(e.code!=='ENOENT')throw e;}await mkdir(out,{mode:0o700});for(const [name,value]of [['analysis.json',JSON.stringify(r,null,2)+'\n'],['report.html',render(r)],['manifest.json',JSON.stringify({schemaVersion:1,input:path.resolve(input),status:r.status,createdAt:new Date().toISOString(),files:['analysis.json','report.html'],inputHashes:await Promise.all([path.resolve(input),...data.collections.map(c=>c.input),...data.balanceInputs].map(async f=>({file:f,sha256:sha(await readFile(f,'utf8'))})))},null,2)+'\n']])await writeFile(path.join(out,name),value,{flag:'wx',mode:0o600});return {status:r.status,out:path.resolve(out),blockers:r.blockers};}
