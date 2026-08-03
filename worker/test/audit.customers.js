// CUSTOMERS / DEBTORS / CREDIT LIMITS
// Requires: bash test/devserver.sh 9001
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const { pickSellableFefoBatch } = require('./lib-fefo');
let pass=0,fail=0;const fails=[];const notes=[];
function ok(n,c,d){if(c){pass++;console.log('  OK   '+n);}else{fail++;fails.push(n+(d?' — '+d:''));console.log('  FAIL '+n+(d?'  -> '+d:''));}}
function note(m){notes.push(m);console.log('  ..   '+m);}
async function req(m,p,{token,body}={}){const h={'content-type':'application/json'};if(token)h.authorization='Bearer '+token;
 const r=await fetch(BASE+p,{method:m,headers:h,body:body?JSON.stringify(body):undefined});let j=null;const t=await r.text();
 try{j=t?JSON.parse(t):null}catch{j=t}return{status:r.status,body:j};}
const login=async(u,p='1234')=>(await req('POST','/api/auth/login',{body:{username:u,pin:p}})).body?.token;
const L=b=>Array.isArray(b)?b:[];
const uniq=()=>Math.random().toString(36).slice(2,8);
const m2=(n)=>Math.round(n*100)/100;

(async()=>{
 console.log('=== CUSTOMERS / DEBTORS / CREDIT LIMITS AUDIT ===');
 try{const h=await fetch(BASE+'/api/health');if(!h.ok)throw new Error('health '+h.status);}
 catch(e){console.log('server not reachable: '+e.message);process.exit(3);}
 const owner=await login('owner'), staff=await login('lagos.staff'), lmgr=await login('lagos.mgr');
 const br=L((await req('GET','/api/branches',{token:owner})).body);
 const lagos=br.find(b=>/lagos/i.test(b.name)), minna=br.find(b=>/minna/i.test(b.name));
 const prods=L((await req('GET','/api/products',{token:owner})).body);
 const pmap=new Map(prods.map(p=>[p.id,p]));
 // TRAP #63/#64: price against the batch FEFO will ACTUALLY use, not an
 // arbitrary one. See test/tools/lib-fefo.js — choosing freely produced 20
 // "failures" that were all this probe's arithmetic, not the app's.
 const stockNow=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body);
 // 40 units is ample: this probe's largest line is 3. The old 300 was an
 // arbitrary "plenty" figure and, once the fixture correctly demanded a batch
 // that is ALSO its product's FEFO batch, nothing in the seed satisfied it.
 const batch=pickSellableFefoBatch(stockNow,{minQty:40,
   predicate:(x)=>pmap.get(x.product_id)&&pmap.get(x.product_id).dispensing_type!=='POM'&&!pmap.get(x.product_id).is_controlled});
 ok('a sellable batch exists',!!batch,batch?`${batch.batch_no} qty=${batch.quantity_remaining} @${batch.selling_price_per_unit}`:'none');
 const unit=batch.selling_price_per_unit;
 const tl=L((await req('GET','/api/till?branch_id='+lagos.id,{token:owner})).body);
 if(!tl.some(x=>x.status==='OPEN')) await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:0}});
 const newCust=async(name,tok=owner,branch=lagos.id)=>(await req('POST','/api/customers',{token:tok,
   body:{branch_id:branch,name:name+' '+uniq(),phone:'0803'+uniq()}})).body;
 const creditSale=async(cust,qty,tok=staff,extra={})=>req('POST','/api/sales',{token:tok,
   body:{branch_id:lagos.id,customer_id:cust.id,items:[{product_id:batch.product_id,quantity:qty,unit_type:'BASE_UNIT'}],
         payments:[{method:'CREDIT',amount:m2(qty*unit)}],...extra}});
 async function bal(l){const tb=L((await req('GET','/api/gl/trial-balance',{token:owner})).body);
  const dr=tb.reduce((a,x)=>a+ +(x.total_debits||0),0),cr=tb.reduce((a,x)=>a+ +(x.total_credits||0),0);
  ok('books balance '+l,Math.abs(dr-cr)<0.005,`dr=${dr.toFixed(2)} cr=${cr.toFixed(2)}`);}

 console.log('\n--- A. A NEW CUSTOMER IS CASH-ONLY BY DEFAULT (BUG 83) ---');
 const c1=await newCust('Default Limit');
 ok('a new customer has a credit_limit of 0',Number(c1.credit_limit)===0,`credit_limit=${c1.credit_limit}`);
 const denied=await creditSale(c1,2);
 ok('a credit sale to a 0-limit customer is REFUSED',denied.status===400&&denied.body.code==='CREDIT_LIMIT_EXCEEDED',
    `status=${denied.status} ${String(denied.body&&denied.body.code)}`);
 ok('...and the message tells the cashier what to do',/no credit limit set|paid for now/i.test(String(denied.body&&denied.body.error)),
    String(denied.body&&denied.body.error).slice(0,110));
 const ledger=L((await req('GET',`/api/customers/${c1.id}/balance`,{token:owner})).body.history);
 ok('...and NO debt was recorded for the refused sale',ledger.length===0,`entries=${ledger.length}`);

 console.log('\n--- B. ONLY A MANAGER MAY GRANT CREDIT ---');
 const byStaff=await req('PUT',`/api/customers/${c1.id}`,{token:staff,body:{credit_limit:50000}});
 ok('a cashier cannot set a credit limit',byStaff.status===403&&byStaff.body.code==='CREDIT_LIMIT_MANAGER_ONLY',
    `status=${byStaff.status} ${String(byStaff.body&&byStaff.body.code)}`);
 const stillZero=(await req('GET',`/api/customers`,{token:owner})).body.find(x=>x.id===c1.id);
 ok('...and the limit really is unchanged',Number(stillZero.credit_limit)===0,`credit_limit=${stillZero.credit_limit}`);
 for(const bad of [-1,'abc',null]){
   const r=await req('PUT',`/api/customers/${c1.id}`,{token:owner,body:{credit_limit:bad}});
   ok(`credit_limit ${String(bad)} is refused`,r.status===400,`status=${r.status}`);
 }
 const granted=await req('PUT',`/api/customers/${c1.id}`,{token:owner,body:{credit_limit:m2(unit*10)}});
 ok('a manager can grant a credit limit',granted.status===200&&Number(granted.body.credit_limit)===m2(unit*10),
    `credit_limit=${granted.body&&granted.body.credit_limit}`);

 console.log('\n--- C. THE LIMIT IS ENFORCED ON THE RESULTING BALANCE ---');
 const under=await creditSale(c1,6);
 ok('a credit sale UNDER the limit succeeds',under.status===201,`status=${under.status} ${String(under.body&&under.body.error).slice(0,80)}`);
 const b1=(await req('GET',`/api/customers/${c1.id}/balance`,{token:owner})).body;
 ok('...and the debt is recorded',m2(b1.balance_owed)===m2(6*unit),`owed=${b1.balance_owed}`);
 const overflow=await creditSale(c1,6);
 ok('a SECOND sale that would breach the limit is refused (cumulative, not per-sale)',
    overflow.status===400&&overflow.body.code==='CREDIT_LIMIT_EXCEEDED',
    `status=${overflow.status} ${String(overflow.body&&overflow.body.code)}`);
 ok('...and the error states the limit, the current debt and the new total',
    overflow.body&&overflow.body.credit_limit!==undefined&&overflow.body.already_owed!==undefined&&overflow.body.would_owe!==undefined,
    JSON.stringify(overflow.body&&{l:overflow.body.credit_limit,o:overflow.body.already_owed,w:overflow.body.would_owe}));
 const exact=await creditSale(c1,4);
 ok('a sale taking the customer EXACTLY to the limit is allowed',exact.status===201,`status=${exact.status}`);
 const b2=(await req('GET',`/api/customers/${c1.id}/balance`,{token:owner})).body;
 ok('...and the balance now equals the limit',m2(b2.balance_owed)===m2(unit*10),`owed=${b2.balance_owed} limit=${m2(unit*10)}`);

 console.log('\n--- D. REPAYING FREES THE HEADROOM UP AGAIN ---');
 const repay=await req('POST',`/api/customers/${c1.id}/payments`,{token:staff,body:{branch_id:lagos.id,amount:m2(unit*5)}});
 ok('the customer can repay part of the debt',repay.status===201,`status=${repay.status}`);
 const afterRepay=await creditSale(c1,4);
 ok('...and credit becomes available again',afterRepay.status===201,`status=${afterRepay.status} ${String(afterRepay.body&&afterRepay.body.error).slice(0,80)}`);
 await bal('after credit sales and a repayment');

 console.log('\n--- E. THE OVERRIDE: MANAGER-ONLY, REASON REQUIRED, RECORDED ---');
 const c2=await newCust('Override Test');
 await req('PUT',`/api/customers/${c2.id}`,{token:owner,body:{credit_limit:m2(unit*2)}});
 const staffOverride=await creditSale(c2,10,staff,{credit_override_reason:'cashier trying to self-authorise'});
 ok('a CASHIER cannot override a credit limit',staffOverride.status===403&&staffOverride.body.code==='CREDIT_OVERRIDE_FORBIDDEN',
    `status=${staffOverride.status} ${String(staffOverride.body&&staffOverride.body.code)}`);
 const shortReason=await creditSale(c2,10,owner,{credit_override_reason:'ok'});
 ok('an override with a token reason is refused',shortReason.status===400&&shortReason.body.code==='CREDIT_OVERRIDE_REASON_REQUIRED',
    `status=${shortReason.status} ${String(shortReason.body&&shortReason.body.code)}`);
 const goodOverride=await creditSale(c2,10,owner,{credit_override_reason:'Long-standing corporate account, invoice raised'});
 ok('a MANAGER can override with a real reason',goodOverride.status===201,`status=${goodOverride.status} ${String(goodOverride.body&&goodOverride.body.error).slice(0,80)}`);
 const saleRow=(await req('GET',`/api/sales/${goodOverride.body.id}`,{token:owner})).body;
 ok('...and the authorisation is recorded ON THE SALE',/corporate account/i.test(String(saleRow&&saleRow.credit_override_reason)),
    String(saleRow&&saleRow.credit_override_reason).slice(0,70));
 const normalSale=await creditSale(c1,1,staff);
 const normalRow=(await req('GET',`/api/sales/${normalSale.body?normalSale.body.id:''}`,{token:owner})).body;
 ok('a sale within the limit carries NO override reason',normalSale.status!==201||!(normalRow&&normalRow.credit_override_reason),
    `reason=${normalRow&&normalRow.credit_override_reason}`);
 await bal('after an authorised over-limit sale');

 console.log('\n--- F. A NON-CREDIT SALE IS NEVER BLOCKED BY A LIMIT ---');
 const cashSale=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,customer_id:c1.id,
   items:[{product_id:batch.product_id,quantity:3,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:m2(3*unit)}]}});
 ok('a CASH sale to a customer at their limit still succeeds',cashSale.status===201,`status=${cashSale.status}`);
 const walkIn=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:batch.product_id,quantity:2,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:m2(2*unit)}]}});
 ok('an anonymous cash sale is unaffected',walkIn.status===201,`status=${walkIn.status}`);
 const noCust=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:batch.product_id,quantity:2,unit_type:'BASE_UNIT'}],payments:[{method:'CREDIT',amount:m2(2*unit)}]}});
 ok('a credit sale with NO customer is still refused',noCust.status===400,`status=${noCust.status}`);

 console.log('\n--- G. VOIDING A CREDIT SALE RESTORES HEADROOM ---');
 const c3=await newCust('Void Headroom');
 await req('PUT',`/api/customers/${c3.id}`,{token:owner,body:{credit_limit:m2(unit*5)}});
 const s1=await creditSale(c3,5);
 ok('the customer is taken to their limit',s1.status===201,`status=${s1.status}`);
 const blocked=await creditSale(c3,1);
 ok('...so a further credit sale is refused',blocked.status===400,`status=${blocked.status}`);
 const v=await req('POST',`/api/sales/${s1.body.id}/void`,{token:owner,body:{reason:'customer returned the goods'}});
 ok('the credit sale can be voided',v.status===200,`status=${v.status}`);
 const afterVoid=await creditSale(c3,5);
 ok('...and the full credit line is available again',afterVoid.status===201,`status=${afterVoid.status}`);
 await bal('after voiding a credit sale');

 console.log('\n--- H. CROSS-BRANCH FENCING ---');
 const mc=await newCust('Minna Customer',owner,minna.id);
 const seenByStaff=L((await req('GET','/api/customers',{token:staff})).body).filter(x=>x.branch_id===minna.id);
 ok('a Lagos cashier sees no Minna customers',seenByStaff.length===0,`leaked=${seenByStaff.length}`);
 const balx=await req('GET',`/api/customers/${mc.id}/balance`,{token:staff});
 ok('...and cannot read a Minna balance',balx.status===403,`status=${balx.status}`);
 const limitx=await req('PUT',`/api/customers/${mc.id}`,{token:lmgr,body:{credit_limit:99999}});
 ok('a Lagos manager cannot set a Minna customer\'s limit',limitx.status===403,`status=${limitx.status}`);

 console.log('\n--- I. DEBTOR AGING REPORT ---');
 const aging=await req('GET','/api/customers/aging',{token:owner});
 ok('the aging report is readable by a manager',aging.status===200,`status=${aging.status}`);
 ok('...and returns rows, buckets and a total',aging.body&&Array.isArray(aging.body.rows)&&aging.body.totals&&aging.body.total_outstanding!==undefined,
    JSON.stringify(aging.body&&aging.body.totals));
 const debtor=L(aging.body.rows).find(r=>r.customer_id===c1.id);
 ok('...listing a customer who owes money',!!debtor,`rows=${L(aging.body.rows).length}`);
 if(debtor){
   ok('...with their balance, age in days and bucket',
      debtor.balance_owed>0&&debtor.oldest_debt_age_days!==undefined&&!!debtor.bucket,
      JSON.stringify({owed:debtor.balance_owed,days:debtor.oldest_debt_age_days,bucket:debtor.bucket}));
   ok('...and a flag when they are over their limit',debtor.over_limit!==undefined,`over_limit=${debtor.over_limit}`);
 }
 const agingStaff=await req('GET','/api/customers/aging',{token:staff});
 ok('a cashier cannot read the aging report',agingStaff.status===403,`status=${agingStaff.status}`);
 const agingScoped=await req('GET','/api/customers/aging',{token:lmgr});
 const foreign=L(agingScoped.body&&agingScoped.body.rows).filter(r=>r.branch_id&&r.branch_id!==lagos.id);
 ok('a Branch Manager sees only their own branch in the aging report',foreign.length===0,`foreign=${foreign.length}`);
 const sum=L(aging.body.rows).reduce((a,r)=>a+Number(r.balance_owed||0),0);
 ok('the reported total matches the sum of its rows',Math.abs(m2(sum)-aging.body.total_outstanding)<0.02,
    `sum=${m2(sum)} reported=${aging.body.total_outstanding}`);

 await bal('at the end of the credit sweep');
 console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
 if(notes.length){console.log('\nOBSERVATIONS:');notes.forEach(n=>console.log('  - '+n));}
 if(fails.length){console.log('\nFAILURES:');fails.forEach(f=>console.log('  - '+f));process.exit(1);}
})();
