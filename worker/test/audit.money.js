// POS / TILL / VOIDS / REFUNDS / DEBTORS — CASH ACCOUNTABILITY END TO END
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
 console.log('=== CASH ACCOUNTABILITY AUDIT ===');
 try{const h=await fetch(BASE+'/api/health');if(!h.ok)throw new Error('health '+h.status);}
 catch(e){console.log('server not reachable: '+e.message);process.exit(3);}
 const owner=await login('owner'), staff=await login('lagos.staff'), lmgr=await login('lagos.mgr');
 const br=L((await req('GET','/api/branches',{token:owner})).body);
 const lagos=br.find(b=>/lagos/i.test(b.name)), minna=br.find(b=>/minna/i.test(b.name));
 const prods=L((await req('GET','/api/products',{token:owner})).body);
 const pmap=new Map(prods.map(p=>[p.id,p]));
 // TRAP #63/#64: FEFO decides which batch fills a line, so the fixture must
 // pick a batch that IS its product's FEFO batch, or this probe's arithmetic
 // and the server's will disagree. See test/tools/lib-fefo.js.
 const pickBatch=async()=>pickSellableFefoBatch(
   L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body),
   {minQty:20,predicate:(x)=>pmap.get(x.product_id)&&!pmap.get(x.product_id).is_controlled&&pmap.get(x.product_id).dispensing_type!=='POM'});

 async function bal(l){const tb=L((await req('GET','/api/gl/trial-balance',{token:owner})).body);
  const dr=tb.reduce((a,x)=>a+ +(x.total_debits||0),0),cr=tb.reduce((a,x)=>a+ +(x.total_credits||0),0);
  ok('books balance '+l,Math.abs(dr-cr)<0.005,`dr=${dr.toFixed(2)} cr=${cr.toFixed(2)}`);}
 async function closeAnyOpenTill(){
   const tl=L((await req('GET','/api/till?branch_id='+lagos.id,{token:owner})).body);
   for(const t of tl.filter(x=>x.status==='OPEN')){
     const e=(await req('GET',`/api/till/${t.id}/expected`,{token:owner})).body;
     await req('POST',`/api/till/${t.id}/close`,{token:owner,body:{counted_closing_cash:e.expected_closing_cash,force_reason:'probe reset'}});
   }
 }
 const expectedOf=async(id)=>(await req('GET',`/api/till/${id}/expected`,{token:owner})).body.expected_closing_cash;

 // BUG 83: customers are now cash-only by default (credit_limit 0). This probe
 // tests CASH ACCOUNTABILITY, not the credit ceiling, so each debtor fixture is
 // granted headroom via the real manager-only endpoint.
 const newDebtor=async(name,branch=lagos.id)=>{
   const c=(await req('POST','/api/customers',{token:owner,body:{branch_id:branch,name:name+' '+uniq(),phone:'0803'+uniq()}})).body;
   await req('PUT',`/api/customers/${c.id}`,{token:owner,body:{credit_limit:1000000}});
   return c;
 };
 console.log('\n--- A. A TILL MUST BE OPEN TO SELL FOR CASH ---');
 await closeAnyOpenTill();
 const b0=await pickBatch();
 const noTill=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b0.product_id,quantity:1,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:b0.selling_price_per_unit}]}});
 note(`cash sale with NO open till -> ${noTill.status} ${String(noTill.body&&(noTill.body.code||noTill.body.error)).slice(0,70)}`);
 ok('a cash sale without an open till is refused',noTill.status>=400,`status=${noTill.status}`);

 console.log('\n--- B. ONE OPEN TILL PER BRANCH ---');
 const till=(await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:10000}})).body;
 ok('a till opens with a float',!!till.id,JSON.stringify(till).slice(0,80));
 const second=await req('POST','/api/till/open',{token:owner,body:{branch_id:lagos.id,opening_cash:500}});
 ok('a SECOND till at the same branch is refused',second.status>=400,`status=${second.status}`);
 for(const bad of [-100,'abc',null]){
   const r=await req('POST','/api/till/open',{token:owner,body:{branch_id:minna.id,opening_cash:bad}});
   if(bad===null){ note(`opening_cash null -> ${r.status}`); if(r.status===201) await req('POST',`/api/till/${r.body.id}/close`,{token:owner,body:{counted_closing_cash:0,force_reason:'cleanup'}}); }
   else ok(`opening_cash ${bad} is refused`,r.status>=400,`status=${r.status}`);
 }

 console.log('\n--- C. PAYMENT SPLITS MUST SUM TO THE SALE TOTAL ---');
 const b1=await pickBatch(); const unit=b1.selling_price_per_unit;
 const total=m2(unit*4);
 const short=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b1.product_id,quantity:4,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:m2(total-1)}]}});
 ok('an underpaid sale is refused',short.status>=400,`status=${short.status} ${String(short.body&&short.body.error).slice(0,70)}`);
 const overp=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b1.product_id,quantity:4,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:m2(total+1)}]}});
 ok('an overpaid sale is refused (change is cash_tendered, not an inflated payment)',overp.status>=400,`status=${overp.status}`);
 const split=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b1.product_id,quantity:4,unit_type:'BASE_UNIT'}],
   payments:[{method:'CASH',amount:m2(total/2)},{method:'POS_CARD',amount:m2(total-m2(total/2))}]}});
 ok('a CASH + CARD split that sums exactly is accepted',split.status===201,`status=${split.status} ${String(split.body&&split.body.error).slice(0,80)}`);
 const badMethod=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b1.product_id,quantity:1,unit_type:'BASE_UNIT'}],payments:[{method:'CRYPTO',amount:unit}]}});
 ok('an unknown payment method is refused',badMethod.status>=400,`status=${badMethod.status}`);

 console.log('\n--- D. ONLY THE CASH LEG OF A SPLIT HITS THE DRAWER ---');
 const beforeSplit=await expectedOf(till.id);
 const b2=await pickBatch(); const u2=b2.selling_price_per_unit; const t2=m2(u2*2);
 const cashPart=m2(t2/2), cardPart=m2(t2-cashPart);
 const s2=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b2.product_id,quantity:2,unit_type:'BASE_UNIT'}],
   payments:[{method:'CASH',amount:cashPart},{method:'POS_CARD',amount:cardPart}]}});
 ok('the split sale is recorded',s2.status===201,`status=${s2.status}`);
 const afterSplit=await expectedOf(till.id);
 ok('expected cash rises by the CASH leg only',m2(afterSplit-beforeSplit)===cashPart,
    `${beforeSplit} -> ${afterSplit} (cash leg ${cashPart}, card ${cardPart})`);

 console.log('\n--- E. CHANGE GIVEN DOES NOT INFLATE THE DRAWER ---');
 const beforeChange=await expectedOf(till.id);
 const b3=await pickBatch(); const t3=m2(b3.selling_price_per_unit*1);
 const s3=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b3.product_id,quantity:1,unit_type:'BASE_UNIT'}],
   payments:[{method:'CASH',amount:t3,cash_tendered:m2(t3+1000)}]}});
 ok('a sale with cash tendered above the total is accepted',s3.status===201,`status=${s3.status} ${String(s3.body&&s3.body.error).slice(0,80)}`);
 const afterChange=await expectedOf(till.id);
 ok('expected cash rises by the SALE amount, not the tendered amount',m2(afterChange-beforeChange)===t3,
    `${beforeChange} -> ${afterChange} (sale ${t3}, tendered ${m2(t3+1000)})`);
 const underTender=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b3.product_id,quantity:1,unit_type:'BASE_UNIT'}],
   payments:[{method:'CASH',amount:t3,cash_tendered:m2(t3-5)}]}});
 ok('tendering LESS than the amount due is refused',underTender.status>=400,`status=${underTender.status}`);

 console.log('\n--- F. BUG 79: DEBTOR REPAYMENTS AND SUPPLIER PAYMENTS ARE CASH ---');
 const cust=await newDebtor('Cash Probe');
 const b4=await pickBatch(); const debt=m2(b4.selling_price_per_unit*4);
 const credit=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,customer_id:cust.id,
   items:[{product_id:b4.product_id,quantity:4,unit_type:'BASE_UNIT'}],payments:[{method:'CREDIT',amount:debt}]}});
 ok('a CREDIT sale is accepted',credit.status===201,`status=${credit.status} ${String(credit.body&&credit.body.error).slice(0,80)}`);
 const afterCredit=await expectedOf(till.id);
 const beforeRepay=afterCredit;
 ok('a CREDIT sale puts NO cash in the drawer',m2(afterCredit-afterChange)===0,`${afterChange} -> ${afterCredit}`);
 const repay=m2(Math.min(500,debt));
 const rp=await req('POST',`/api/customers/${cust.id}/payments`,{token:staff,body:{branch_id:lagos.id,amount:repay}});
 ok('the debtor can repay',rp.status===201,`status=${rp.status} ${String(rp.body&&rp.body.error).slice(0,80)}`);
 const afterRepay=await expectedOf(till.id);
 ok('a CASH debt repayment INCREASES expected cash (Bug 79)',m2(afterRepay-beforeRepay)===repay,
    `${beforeRepay} -> ${afterRepay} (repaid ${repay})`);

 console.log('\n--- G. THE DRAWER RECONCILES EXACTLY ---');
 const finalExpected=await expectedOf(till.id);
 const exact=await req('POST',`/api/till/${till.id}/close`,{token:staff,body:{counted_closing_cash:finalExpected}});
 ok('closing with the exact expected figure yields ZERO discrepancy',
    exact.status===200 && m2(exact.body.discrepancy)===0,
    `status=${exact.status} discrepancy=${exact.body&&exact.body.discrepancy}`);
 await bal('after a full trading session');

 console.log('\n--- H. A REAL SHORTAGE IS STILL REPORTED ---');
 const till2=(await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:5000}})).body;
 const b5=await pickBatch();
 await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b5.product_id,quantity:2,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:m2(b5.selling_price_per_unit*2)}]}});
 const exp2=await expectedOf(till2.id);
 const shortClose=await req('POST',`/api/till/${till2.id}/close`,{token:staff,body:{counted_closing_cash:m2(exp2-250)}});
 ok('a genuine 250 shortage is reported as such',shortClose.status===200 && m2(shortClose.body.discrepancy)===-250,
    `discrepancy=${shortClose.body&&shortClose.body.discrepancy}`);
 await bal('after a real shortage posts to CASH_OVER_SHORT');

 console.log('\n--- I. TILL CLOSE AUTHORITY AND VALIDATION ---');
 const till3=(await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:1000}})).body;
 for(const bad of [undefined,null,-5,'abc']){
   const r=await req('POST',`/api/till/${till3.id}/close`,{token:staff,body:{counted_closing_cash:bad}});
   ok(`counted_closing_cash ${String(bad)} is refused (no fabricated 0)`,r.status>=400,`status=${r.status}`);
 }
 const otherStaff=(await req('POST','/api/users',{token:owner,body:{full_name:'Other Cashier',username:'cash-'+uniq(),pin:'4321',role:'STAFF',branch_id:lagos.id}})).body;
 const otherTok=await login(otherStaff.username,'4321');
 const steal=await req('POST',`/api/till/${till3.id}/close`,{token:otherTok,body:{counted_closing_cash:1000}});
 ok('a colleague cannot close a till they did not open',steal.status===403 && steal.body.code==='STAFF_CLOSE_NOT_OWN_TILL',
    `status=${steal.status} ${String(steal.body&&steal.body.code)}`);
 const noReason=await req('POST',`/api/till/${till3.id}/close`,{token:owner,body:{counted_closing_cash:1000}});
 ok('a manager force-closing someone else\'s till must give a reason',noReason.status>=400 && noReason.body.code==='FORCE_REASON_REQUIRED',
    `status=${noReason.status} ${String(noReason.body&&noReason.body.code)}`);
 const forced=await req('POST',`/api/till/${till3.id}/close`,{token:owner,body:{counted_closing_cash:1000,force_reason:'cashier left without closing'}});
 ok('...and with a reason it succeeds, recorded as a force-close',forced.status===200 && !!forced.body.force_closed_by,
    `status=${forced.status} force_closed_by=${forced.body&&forced.body.force_closed_by}`);
 const reclose=await req('POST',`/api/till/${till3.id}/close`,{token:owner,body:{counted_closing_cash:1000,force_reason:'again'}});
 ok('a closed till cannot be closed twice',reclose.status>=400,`status=${reclose.status}`);

 console.log('\n--- J. VOIDS: AUTHORITY, WINDOW AND REVERSAL ---');
 const till4=(await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:2000}})).body;
 const b6=await pickBatch(); const t6=m2(b6.selling_price_per_unit*3);
 const qtyBefore=b6.quantity_remaining;
 const sale6=(await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b6.product_id,quantity:3,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:t6}]}})).body;
 const expBeforeVoid=await expectedOf(till4.id);
 const noReasonVoid=await req('POST',`/api/sales/${sale6.id}/void`,{token:owner,body:{}});
 ok('a void with no reason is refused',noReasonVoid.status>=400,`status=${noReasonVoid.status}`);
 const otherVoid=await req('POST',`/api/sales/${sale6.id}/void`,{token:otherTok,body:{reason:'voiding a colleague sale'}});
 ok('a cashier cannot void a colleague\'s sale',otherVoid.status>=400,`status=${otherVoid.status} ${String(otherVoid.body&&otherVoid.body.code)}`);
 const voided=await req('POST',`/api/sales/${sale6.id}/void`,{token:staff,body:{reason:'customer changed their mind'}});
 ok('the cashier can void their OWN recent sale',voided.status===200,`status=${voided.status} ${String(voided.body&&voided.body.error).slice(0,80)}`);
 const expAfterVoid=await expectedOf(till4.id);
 ok('...and the cash comes back OUT of expected cash',m2(expBeforeVoid-expAfterVoid)===t6,
    `${expBeforeVoid} -> ${expAfterVoid} (sale ${t6})`);
 const restocked=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.id===b6.id);
 ok('...and the stock is returned to the shelf',restocked && restocked.quantity_remaining===qtyBefore,
    `before=${qtyBefore} after=${restocked&&restocked.quantity_remaining}`);
 const revoid=await req('POST',`/api/sales/${sale6.id}/void`,{token:owner,body:{reason:'double void'}});
 ok('a sale cannot be voided twice',revoid.status>=400,`status=${revoid.status}`);
 await bal('after a void');

 console.log('\n--- K. VOIDING A CREDIT SALE CLEARS THE DEBT ---');
 const cust2=await newDebtor('Void Debtor');
 const b7=await pickBatch(); const t7=m2(b7.selling_price_per_unit*2);
 const cs=(await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,customer_id:cust2.id,
   items:[{product_id:b7.product_id,quantity:2,unit_type:'BASE_UNIT'}],payments:[{method:'CREDIT',amount:t7}]}})).body;
 const debtBefore=(await req('GET',`/api/customers/${cust2.id}`,{token:owner})).body;
 note(`debt after credit sale: ${JSON.stringify(debtBefore&&{bal:debtBefore.balance_owed||debtBefore.outstanding_balance}).slice(0,60)}`);
 const vc=await req('POST',`/api/sales/${cs.id}/void`,{token:owner,body:{reason:'credit sale entered in error'}});
 ok('a credit sale can be voided',vc.status===200,`status=${vc.status}`);
 const debtAfter=(await req('GET',`/api/customers/${cust2.id}`,{token:owner})).body;
 const owedAfter=Number((debtAfter&&(debtAfter.balance_owed??debtAfter.outstanding_balance))||0);
 ok('...and the customer no longer owes for it',owedAfter===0,`owed=${owedAfter}`);
 await bal('after voiding a credit sale');

 console.log('\n--- L. DEBTORS CANNOT BE OVERPAID OR PAID NEGATIVE ---');
 const cust3=await newDebtor('Overpay');
 const b8=await pickBatch(); const t8=m2(b8.selling_price_per_unit*2);
 await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,customer_id:cust3.id,
   items:[{product_id:b8.product_id,quantity:2,unit_type:'BASE_UNIT'}],payments:[{method:'CREDIT',amount:t8}]}});
 const over2=await req('POST',`/api/customers/${cust3.id}/payments`,{token:staff,body:{branch_id:lagos.id,amount:m2(t8*10)}});
 ok('a debtor cannot repay more than they owe',over2.status>=400,`status=${over2.status} ${String(over2.body&&over2.body.error).slice(0,90)}`);
 for(const bad of [0,-50]){
   const r=await req('POST',`/api/customers/${cust3.id}/payments`,{token:staff,body:{branch_id:lagos.id,amount:bad}});
   ok(`a repayment of ${bad} is refused`,r.status>=400,`status=${r.status}`);
 }

 console.log('\n--- M. CROSS-BRANCH CASH FENCING ---');
 const mTill=L((await req('GET','/api/till',{token:owner})).body).filter(t=>t.branch_id===minna.id&&t.status==='OPEN');
 const lagosVisible=L((await req('GET','/api/till',{token:staff})).body).filter(t=>t.branch_id!==lagos.id);
 ok('a Lagos cashier sees no other branch\'s till sessions',lagosVisible.length===0,`foreign=${lagosVisible.length}`);
 const minnaCust=(await req('POST','/api/customers',{token:owner,body:{branch_id:minna.id,name:'Minna Debtor '+uniq(),phone:'0803'+uniq()}})).body;
 const xPay=await req('POST',`/api/customers/${minnaCust.id}/payments`,{token:lmgr,body:{branch_id:lagos.id,amount:100}});
 ok('a Lagos manager cannot take a repayment against a Minna customer',xPay.status>=400,`status=${xPay.status} ${String(xPay.body&&xPay.body.code)}`);

 await bal('at the end of the cash sweep');
 console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
 if(notes.length){console.log('\nOBSERVATIONS:');notes.forEach(n=>console.log('  - '+n));}
 if(fails.length){console.log('\nFAILURES:');fails.forEach(f=>console.log('  - '+f));process.exit(1);}
})();
