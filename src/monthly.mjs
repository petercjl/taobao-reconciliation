import {readFile,writeFile,mkdir,lstat,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {loadInput,analyze} from './analyze.mjs';
import {cents,yuan,failure} from './money.mjs';
import {monthPeriod,nextDay,resolveMonthBalances,balanceGrade} from './balance-evidence.mjs';
const sha=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const absent=async p=>{try{await lstat(p);throw failure('OUTPUT_EXISTS','输出已存在。');}catch(e){if(e.code!=='ENOENT')throw e;}};
const write=async(p,v)=>writeFile(p,typeof v==='string'?v:JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const exists=async p=>{try{await lstat(p);return true;}catch(e){if(e.code!=='ENOENT')throw e;return false;}};
const esc=v=>String(v??'缺少证据').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={alipay:'支付宝',aggregate:'聚合结算',deposit:'现金保证金',sales:'货款',refund:'退款',marketing:'品牌新享营销托管',software:'基础软件服务费','consumer-service':'消费者体验服务费',compensation:'赔付',freight:'运费追缴',transfer:'内部转移','external-in':'外部注资','external-out':'外部提现',unknown:'未分类','deposit-debit':'保证金扣款待关联'};
const table=(headers,rows)=>'<div class="scroll"><table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
export function cashEquation(r){const sum=cat=>r.normalized.filter(e=>e.category===cat).reduce((s,e)=>s+BigInt(e.amountCents),0n);const sales=sum('sales'),refund=-sum('refund');const fees=r.incomeExpenses.fees.reduce((s,f)=>s+cents(f.netExpense),0n);const externalIn=sum('external-in'),externalOut=-sum('external-out');const predicted=sales-refund-fees+externalIn-externalOut;return {sales:yuan(sales),refunds:yuan(refund),fees:yuan(fees),externalIn:yuan(externalIn),externalOut:yuan(externalOut),predictedNet:yuan(predicted),actualNet:r.netCashChange,residual:yuan(predicted-cents(r.netCashChange))};}
export async function verifyPrevious(file,{shopKey,month,accounts}){
 const state=await read(file);const period=monthPeriod(month);if(state.schemaVersion!==1||state.shopKey!==shopKey||nextDay(monthPeriod(state.month).to)!==period.from||JSON.stringify(state.accounts)!==JSON.stringify(accounts))throw failure('PREVIOUS_SCOPE_MISMATCH','前月台账的月份或账户不匹配。');
 if(sha(await readFile(state.reportPath,'utf8'))!==state.reportHash)throw failure('PREVIOUS_REPORT_CHANGED','前月报告内容已变化，需要重新复核。');
 if(state.balanceStatus==='failed'||state.balanceStatus==='partial')throw failure('PREVIOUS_NOT_RECONCILED','前月未形成可承接的余额证据。');
 if(state.stateDirectory&&await exists(state.stateDirectory)){for(const f of await readdir(state.stateDirectory)){if(!f.endsWith('.json'))continue;const other=await read(path.join(state.stateDirectory,f));if(other.month===state.month&&other.createdAt>state.createdAt)throw failure('PREVIOUS_REVISION_STALE','前月已有新修订，请选用最新台账并复核承接。');}}
 return {...state,inputRef:path.resolve(file),inputHash:sha(await readFile(file,'utf8'))};
}
export async function analyzeMonth({input,month,out,previous,stateDir}){
 const period=monthPeriod(month);const data=await loadInput(input);if(data.plan.period.from!==period.from||data.plan.period.to!==period.to)throw failure('MONTH_SCOPE_MISMATCH','输入计划须覆盖指定完整自然月。');
 await absent(out);let prior;
 if(previous){prior=await verifyPrevious(previous,{shopKey:data.plan.shopKey,month,accounts:data.plan.accounts});data.balances.push(...prior.closingBalances);}
 const evidence=resolveMonthBalances(data);
 const inMonth=e=>e.date.slice(0,10)>=period.from&&e.date.slice(0,10)<=period.to;
 const ids=new Set(data.events.filter(inMonth).map(e=>e.source+':'+e.id));
 const plan={...data.plan,transferPairs:(data.plan.transferPairs??[]).filter(p=>ids.has(p.from.source+':'+p.from.id)&&ids.has(p.to.source+':'+p.to.id))};
 const r=analyze({...data,plan,balances:evidence.balances});
 if(evidence.anchorChecks.some(c=>c.status==='failed')){r.status='failed';r.blockers.push('余额锚点之间存在金额差额');}
 const group=r.consolidated[0];const balanceStatus=evidence.anchorChecks.some(c=>c.status==='failed')?'failed':group.status;
 const classificationStatus=r.unknown.length||r.unmatchedTransfers.length||r.normalized.some(e=>e.category==='deposit-debit')?'partial':'complete';
 const businessStatus=r.missingDatasets.length||r.unmatchedSupporting.length||!plan.requiredDatasets?.some(d=>d.source==='taobao')?'partial':'complete';
 const equation=cashEquation(r);const cashStatus=balanceStatus==='failed'||equation.residual!=='0.00'?'failed':classificationStatus!=='complete'||balanceStatus==='partial'?'partial':balanceStatus;
 const feeDetails=r.incomeExpenses.fees.map(f=>({...f,charged:yuan(r.normalized.filter(e=>e.category===f.category&&BigInt(e.amountCents)<0n).reduce((s,e)=>s-BigInt(e.amountCents),0n)),returned:yuan(r.normalized.filter(e=>e.category===f.category&&BigInt(e.amountCents)>0n).reduce((s,e)=>s+BigInt(e.amountCents),0n))}));
 const comparable=prior&&prior.policyVersion==='monthly-cash-v1'&&prior.currency==='CNY'&&!['failed','partial'].includes(prior.balanceStatus);
 const comparison=comparable?{month:prior.month,netChange:yuan(cents(r.netCashChange)-cents(prior.netCashChange)),salesChange:yuan(cents(r.incomeExpenses.sales)-cents(prior.sales)),evidenceComparable:prior.balanceStatus===balanceStatus}:null;
 const result={...r,month,policyVersion:'monthly-cash-v1',checks:{balance:balanceStatus,cash:cashStatus,classification:classificationStatus,businessCoverage:businessStatus,accountScope:plan.bindingConfirmed===true?'confirmed':'unconfirmed'},equation,feeDetails,comparison,anchorChecks:evidence.anchorChecks,previous:prior?{ref:prior.inputRef,sha256:prior.inputHash,reportHash:prior.reportHash}:null};
 await mkdir(out,{mode:0o700});
 await write(path.join(out,'analysis.json'),result);await write(path.join(out,'balance-evidence.json'),{schemaVersion:1,balances:evidence.balances,anchorChecks:evidence.anchorChecks});
 const csv=[['入账日期','账户','流水号','订单号','类别','金额（元）','说明'],...r.normalized.map(e=>[e.date,names[e.source],e.id,e.orderId??'',names[e.category]??e.category,yuan(BigInt(e.amountCents)),/^[=+@-]/.test(e.description??'')?"'"+e.description:e.description??''])].map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n');
 await write(path.join(out,'details.csv'),'\ufeff'+csv);
 await write(path.join(out,'report.html'),renderMonth(result));
 const closingBalances=evidence.balances.filter(b=>b.effectiveAt===nextDay(period.to)+'T00:00:00+08:00'&&balanceGrade(b,plan.balancePolicy));
 const reportPath=path.resolve(out,'analysis.json');const state={schemaVersion:1,policyVersion:'monthly-cash-v1',shopKey:plan.shopKey,month,accounts:plan.accounts,currency:'CNY',balanceStatus:cashStatus,closingBalances,netCashChange:r.netCashChange,sales:r.incomeExpenses.sales,reportPath,reportHash:sha(await readFile(reportPath,'utf8')),previous:result.previous,createdAt:new Date().toISOString()};
 if(stateDir){const dir=path.resolve(stateDir,sha(plan.shopKey).slice(0,20),month);await mkdir(dir,{recursive:true,mode:0o700});state.stateDirectory=dir;const statePath=path.join(dir,randomUUID()+'.json');await write(statePath,state);state.savedStatePath=statePath;}
 await write(path.join(out,'state.json'),state);
 const inputs=[path.resolve(input),...data.collections.map(c=>c.input),...data.balanceInputs,...(previous?[path.resolve(previous)]:[])];
 await write(path.join(out,'manifest.json'),{schemaVersion:1,month,policyVersion:state.policyVersion,checks:result.checks,createdAt:state.createdAt,files:['report.html','analysis.json','details.csv','balance-evidence.json','state.json'],inputHashes:await Promise.all([...new Set(inputs)].map(async file=>({file,sha256:sha(await readFile(file,'utf8'))})))});
 return {out:path.resolve(out),month,checks:result.checks,equation,state:path.resolve(out,'state.json'),blockers:r.blockers};
}
export function renderMonth(r){
 const eq=r.equation;const statusLabels={passed:'独立余额验证通过',confirmed:'含用户确认起点',provisional:'包含锚点重建余额',partial:'证据或分类待补',failed:'存在差额'};
 const equation=`${eq.sales} − ${eq.refunds} − ${eq.fees}`+(eq.externalIn!=='0.00'||eq.externalOut!=='0.00'?` + ${eq.externalIn} − ${eq.externalOut}`:'')+` = ${eq.actualNet}`;
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.month)} 店铺账单</title><style>body{font:16px/1.65 system-ui,sans-serif;max-width:1160px;margin:32px auto;padding:20px;color:#263e34;background:#f5f5f1}section{background:white;border:1px solid #e0e6de;border-radius:12px;padding:22px;margin:20px 0}h1{font-size:30px}h2{font-size:22px}.formula{font-size:clamp(20px,3vw,30px);font-weight:650;color:#245e49}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:10px;text-align:left;border-bottom:1px solid #e1e5df}th{background:#edf2ec}input{padding:10px;border:1px solid #bdcabc;border-radius:6px;width:330px;max-width:90%}.note{padding:12px;background:#fff8e9}summary{cursor:pointer}small{color:#637568}td:nth-child(3),td:nth-child(4){white-space:nowrap}</style><h1>${esc(r.month)} 店铺收入与费用</h1><p>${esc(r.shopKey)} · ${r.period.from} 至 ${r.period.to} · 资金发生日</p><section><h2>本月现金等式</h2><p class="formula">${esc(equation)} 元</p><p>货款 − 退款 − 净费用${eq.externalIn!=='0.00'||eq.externalOut!=='0.00'?' + 外部注资 − 外部提现':''} = 三账户净现金增加</p><p>余额校验：${esc(statusLabels[r.checks.cash])}；分类：${esc(r.checks.classification)}；业务账单覆盖：${esc(r.checks.businessCoverage)}；账户范围：${esc(r.checks.accountScope)}。</p><p class="note">${r.checks.balance==='provisional'?'部分历史月界余额由已保存锚点和完整流水重建；金额可衔接，但不是独立官方月结凭证。':'余额证据来源见下表。'} 净现金变化不等于利润。</p></section><section><h2>第一步：账单闭合</h2>${table(['账户','期初','期末','流水净额','差额','证据等级'],r.bridges.map(b=>[names[b.source],b.opening,b.closing,b.net,b.residual,b.evidenceQuality]))}<p>账户内部转移保留在各账户流水中，合并时抵销。未分类 ${r.unknown.length} 条，未匹配转账 ${r.unmatchedTransfers.length} 条，未匹配辅助账单 ${r.unmatchedSupporting.length} 条。</p>${r.blockers.length?'<details><summary>查看待处理项</summary><ul>'+r.blockers.map(b=>'<li>'+esc(b)+'</li>').join('')+'</ul></details>':''}</section><section><h2>第二步：费用分析</h2>${table(['费用','扣费','返还','净费用','占货款'],r.feeDetails.map(f=>[names[f.category],f.charged,f.returned,f.netExpense,f.shareOfSales]))}<p>退款 ${eq.refunds} 元，退款率 ${esc(r.incomeExpenses.refundRate)}；费用率以本月货款为分母。退款按实际退款月份记录，官方业务账期单独关联。</p>${r.comparison?'<p>与'+esc(r.comparison.month)+'相比：货款变化 '+esc(r.comparison.salesChange)+' 元；现金净变化差 '+esc(r.comparison.netChange)+' 元。'+(r.comparison.evidenceComparable?'':'两月余额证据等级不同，比较需结合限制。')+'</p>':'<p>没有已核对且口径可比的前月报告，本次只解释当月。</p>'}</section><section><h2>收款渠道</h2>${table(['账户','货款','退款','现金净变化'],r.channels.map(c=>[names[c.source],c.sales,c.refunds,c.netCashChange]))}</section><section><h2>资金明细</h2><input id="filter" placeholder="筛选订单号、费用或说明"><details><summary>展开本月 ${r.normalized.length} 条资金明细</summary><div id="ledger">${table(['日期','账户','流水号','订单号','类别','金额','说明'],r.normalized.map(e=>[e.date,names[e.source],e.id,e.orderId,names[e.category]??e.category,yuan(BigInt(e.amountCents)),e.description]))}</div></details></section><section><h2>范围与证据</h2><p>本报告包含支付宝、聚合结算和现金保证金。万相台、商品采购、税费和平台外物流需要独立数据来源。</p><p>业务月账单未发布、归属未确认与余额差额分别记录。已取得的数据不因余额相等就自动解释为全部经营收入费用。</p><small>analysis.json保存关联结果，details.csv保存明细，balance-evidence.json记录余额来源；manifest.json保存输入哈希，state.json用于下月承接。CSV中的长流水号和订单号导入电子表格时应选择文本列。</small></section><script>document.getElementById('filter').addEventListener('input',e=>{const q=e.target.value.trim();document.querySelectorAll('#ledger tbody tr').forEach(r=>r.hidden=q&&!r.textContent.includes(q));});</script></html>`;
}
export async function runTbcli(args){return new Promise((resolve,reject)=>{const child=spawn(process.platform==='win32'?'tbcli.cmd':'tbcli',args,{env:{...process.env,TBCLI_UPDATE_CHECK:'0'},shell:false});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',()=>reject(failure('TBCLI_UNAVAILABLE','无法执行tbcli。')));child.on('close',code=>{if(code!==0)return reject(failure('TBCLI_COLLECTION_STOPPED','取数停止，已成功步骤保留；请检查登录、验证或命令错误后恢复。'));try{resolve(JSON.parse(stdout));}catch{reject(failure('TBCLI_RESPONSE_INVALID','tbcli未返回有效JSON。'));}});});}
export async function collectMonth({input,month,out,resume=false},call=runTbcli){
 const request=await read(input);const period=monthPeriod(month);
 const current=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date());
 if(month>=current)throw failure('MONTH_NOT_CLOSED','月度流程只处理已结束月份；当月截至时点分析请使用明确日期范围。');
 if(!request.shopKey||!request.sellerId||!Array.isArray(request.accounts)||request.accounts.length!==3||!['alipay','aggregate','deposit'].every(s=>request.accounts.some(a=>a.source===s&&a.accountId)))throw failure('ACCOUNT_SCOPE_REQUIRED','需要店铺键、卖家身份和三个资金账户。');
 if(!resume){await absent(out);await mkdir(out,{mode:0o700});await write(path.join(out,'request.json'),{request,month});}
 else {const saved=await read(path.join(out,'request.json'));if(sha(saved)!==sha({request,month}))throw failure('RESUME_SCOPE_MISMATCH','恢复的店铺、月份或账户不匹配。');}
 const steps=path.join(out,'steps');await mkdir(steps,{recursive:true,mode:0o700});
 const step=async(key,args)=>{const record=path.join(steps,key+'.json');if(await exists(record)){const old=await read(record);for(const ref of old.files??[])if(sha(await readFile(ref.path,'utf8'))!==ref.sha256)throw failure('EVIDENCE_CHANGED','已完成采集步骤的文件发生变化。');return old.result;}const result=await call(args);const files=[];for(const file of [result.manifestPath,...(args.includes('--out')?[args[args.indexOf('--out')+1]]:[])])if(file&&await exists(file)&&(await lstat(file)).isFile())files.push({path:path.resolve(file),sha256:sha(await readFile(file,'utf8'))});await write(record,{args,result,files});return result;};
 try{
  const auth=await call(['auth','status','--json']);if(auth.taobaoLoggedIn!==true)throw failure('AUTH_REQUIRED','淘宝会话需要登录。');
  const identity=resume?await call(['finance','identity','--json']):await step('identity',['finance','identity','--out',path.resolve(out,'identity.json'),'--json']);
  if(String(identity.pageIdentity?.seller?.sellerId)!==String(request.sellerId))throw failure('ACCOUNT_SCOPE_MISMATCH','当前店铺卖家身份与请求不同。');
  const payIds=identity.alipay?.result?.filter(a=>a.current===true).map(a=>String(a.accountId))??[];
  if(!payIds.includes(String(request.accounts.find(a=>a.source==='alipay').accountId)))throw failure('ACCOUNT_SCOPE_MISMATCH','支付宝当前账户与请求不同。');
  const catalog=await step('catalog',['finance','catalog','--source','taobao','--out',path.resolve(out,'catalog.json'),'--json']);
  const datasets=request.requiredDatasets??catalog.datasets.filter(d=>d.kind==='detail').map(d=>({source:'taobao',dataset:d.id}));
  const jobs=[...request.accounts.map(a=>({...a,dataset:a.source==='deposit'?'cash':'ledger'})),...datasets.map(d=>({...d,accountId:String(request.sellerId)}))];const manifests=[];
  for(const [i,job]of jobs.entries()){
   const folder=path.resolve(out,'data-'+i);const args=['finance','fetch','--source',job.source,'--dataset',job.dataset,'--shop-key',request.shopKey,'--account-id',job.accountId,'--start-date',period.from,'--end-date',period.to,'--out',folder,'--json'];
   if(await exists(path.join(folder,'run.json'))){const run=await read(path.join(folder,'run.json'));args.push('--resume',run.runId);}
   const r=await step('fetch-'+i,args);if(r.status!=='complete')throw failure('COLLECTION_PARTIAL','指定月份账单尚未完成。');manifests.push(r.manifestPath);
  }
  const balances=[];
  for(const a of request.accounts)for(const [label,date]of [['opening',period.from],['closing',nextDay(period.to)]]){const file=path.resolve(out,a.source+'-'+label+'.json');await step(a.source+'-'+label,['finance','balances','--source',a.source,'--shop-key',request.shopKey,'--account-id',a.accountId,'--at',date+'T00:00:00+08:00','--out',file,'--json']);balances.push(file);}
  const resolve=p=>path.resolve(path.dirname(path.resolve(input)),p);
  const plan={schemaVersion:1,shopKey:request.shopKey,period,accounts:request.accounts,inputs:[...manifests,...(request.bootstrapInputs??[]).map(resolve)],balances:[...balances,...(request.balanceInputs??[]).map(resolve)],requiredDatasets:datasets,bindingConfirmed:request.bindingConfirmed===true,balancePolicy:request.balancePolicy??{},rules:request.rules??[],transferPairs:request.transferPairs??[]};
  const file=path.resolve(out,'analysis-input.json');if(!(await exists(file)))await write(file,plan);
  return {status:'complete',month,input:file,collectionDirectory:path.resolve(out)};
 }catch(e){await write(path.join(out,'failure-'+randomUUID()+'.json'),{code:e.code??'COLLECTION_FAILED',month,retainedSteps:steps});throw e;}
}
