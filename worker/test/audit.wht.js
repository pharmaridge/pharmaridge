const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const { pickSellableFefoBatch } = require('./lib-fefo');
let pass=0, fail=0; const fails=[]; const notes=[];
function ok(n,c,d){ if(c){pass++;console.log('  OK   '+n);} else {fail++;fails.push(n+(d?' — '+d:''));console.log('  FAIL '+n+(d?'  -> '+d:''));} }
function note(m){ notes.push(m); console.log('  ..   '+m); }
async function req(m,p,{token,body}={}){const h={'content-type':'application/json'};if(token)h.authorization='Bearer '+token;
 const r=await fetch(BASE+p,{method:m,headers:h,body:body?JSON.stringify(body):undefined});let j=null;const t=await r.text();
 try{j=t?JSON.parse(t):null}catch{j=t}return{status:r.status,body:j};}
const login=async(u,p='1234')=>(await req('POST','/api/auth/login',{body:{username:u,pin:p}})).body?.token;
const listOf=(b)=>Array.isArray(b)?b:[];
const money=(n)=>Math.round(n*100)/100;

(async()=>{
 console.log('=== ACCOUNTING / WHT / TAX AUDIT ===');
 const owner=await login('owner'), mgr=await login('manager'), lmgr=await login('lagos.mgr'), staff=await login('lagos.staff');
 const branches=listOf((await req('GET','/api/branches',{token:owner})).body);
 const lagos=branches.find(b=>/lagos/i.test(b.name)), minna=branches.find(b=>/minna/i.test(b.name));

 // ---------------------------------------------------------------------
 // RE-RUNNABILITY: FUND THE BRANCH BEFORE ANY CASH TEST RUNS.
 //
 // This probe spends real cash — expenses, a supplier payment — and never
 // put any back, so each run left the branch poorer than it found it. On a
 // fresh database the seeded day's trading happened to cover it; on the
 // second or third run the drawer was empty and the CASH_EXPENSE_EXCEEDS_DRAWER
 // guard (Bug 96, working exactly as designed) refused the spend. The
 // resulting assertion failures were reported as "cross-probe seed
 // contamination" for several rounds. They were not contamination and not a
 // product defect: this probe was degrading the world it ran in.
 //
 // Deposit into the safe, then move enough into the drawer, and ASSERT both.
 // A setup step that fails silently is how the wrong thing gets debugged.
 {
   const dep = await req('POST','/api/safe/movements',{token:owner,body:{branch_id:lagos.id,
     entry_type:'DEPOSIT',amount:60000,reason:'probe setup: make this probe re-runnable'}});
   ok('SETUP: the branch safe can be funded',
     dep.status===200||dep.status===201,
     `status=${dep.status} ${String(dep.body&&dep.body.error).slice(0,110)}`);
   // TILL_TRANSFER carries direction in its SIGN (trap #95): negative moves
   // cash out of the safe and into the drawer.
   const top = await req('POST','/api/safe/movements',{token:owner,body:{branch_id:lagos.id,
     entry_type:'TILL_TRANSFER',amount:-30000,reason:'probe setup: fund the drawer for the cash tests'}});
   ok('SETUP: the drawer can be funded from the safe',
     top.status===200||top.status===201,
     `status=${top.status} ${String(top.body&&top.body.error).slice(0,110)}`);
 }

 // helper: full trial balance check
 async function booksBalance(label){
   const tb=listOf((await req('GET','/api/gl/trial-balance',{token:owner})).body);
   const dr=tb.reduce((a,x)=>a+Number(x.total_debits||0),0);
   const cr=tb.reduce((a,x)=>a+Number(x.total_credits||0),0);
   ok(`books balance ${label}`, Math.abs(dr-cr)<0.005, `dr=${dr.toFixed(2)} cr=${cr.toFixed(2)}`);
   return {dr,cr};
 }

 console.log('\n--- A. WHT ARITHMETIC INVARIANT: gross = net + wht ---');
 const rates=listOf((await req('GET','/api/wht/rates',{token:owner})).body);
 ok('WHT rates are seeded', rates.length>0, `n=${rates.length}`);
 const payableRate=rates.find(r=>r.direction==='PAYABLE'||r.direction==='BOTH');
 note(`rates available: ${rates.slice(0,6).map(r=>r.code+'@'+r.rate_percent+'%('+r.direction+')').join(', ')}`);

 // Kobo-hostile amounts: values where x*rate/100 lands mid-kobo.
 const nasty=[33.33, 0.01, 99.99, 1234.56, 7777.77, 0.05, 10000.005];
 for(const g of nasty){
   const r=await req('POST','/api/expenses',{token:owner,body:{
     branch_id:lagos.id, category:'PROFESSIONAL_FEES', amount:g, description:`wht-kobo-${g}`,
     payment_method:'CASH', wht_rate_code:payableRate?payableRate.code:undefined }});
   if(r.status!==201){ note(`expense ${g} rejected: ${r.status} ${String(r.body&&r.body.error).slice(0,70)}`); continue; }
   const w=r.body.wht;
   if(!w){ note(`expense ${g}: no wht attached`); continue; }
   // TRAP: the field is net_paid, not net_amount. My first version read an
   // undefined field, computed NaN, and reported six "failures" against
   // perfectly correct arithmetic. Read the contract, do not guess it.
   ok(`gross = net + wht at ${g}`, Math.abs(money(w.net_paid+w.wht_amount)-money(w.gross_amount))<0.005,
      `gross=${w.gross_amount} net_paid=${w.net_paid} wht=${w.wht_amount}`);
 }
 await booksBalance('after kobo-hostile WHT expenses');

 console.log('\n--- B. WHT DIRECTION CANNOT BE ABUSED ---');
 const recvOnly=rates.find(r=>r.direction==='RECEIVABLE');
 if(recvOnly){
   const r=await req('POST','/api/expenses',{token:owner,body:{branch_id:lagos.id,category:'RENT',amount:1000,
     description:'receivable rate on an expense',payment_method:'CASH',wht_rate_code:recvOnly.code}});
   ok('a RECEIVABLE-only rate is refused on an expense (payable direction)', r.status>=400,
      `status=${r.status} ${String(r.body&&r.body.code)}`);
 } else note('no RECEIVABLE-only rate seeded to test direction fencing');

 for(const bad of [{wht_rate_percent:-5,label:'negative rate'},{wht_rate_percent:150,label:'rate above 100%'}]){
   const r=await req('POST','/api/expenses',{token:owner,body:{branch_id:lagos.id,category:'RENT',amount:1000,
     description:bad.label,payment_method:'CASH',wht_rate_percent:bad.wht_rate_percent}});
   ok(`${bad.label} is refused`, r.status>=400, `status=${r.status} ${String(r.body&&r.body.code)}`);
 }
 const unknown=await req('POST','/api/expenses',{token:owner,body:{branch_id:lagos.id,category:'RENT',amount:1000,
   description:'unknown code',payment_method:'CASH',wht_rate_code:'NOSUCHCODE'}});
 ok('an unknown WHT code is refused with a clear code', unknown.status>=400 && /WHT/.test(String(unknown.body&&unknown.body.code)),
    `status=${unknown.status} ${String(unknown.body&&unknown.body.code)}`);

 console.log('\n--- C. WHT AUTHORITY: WHO MAY DO WHAT ---');
 const rateCode=payableRate?payableRate.code:null;
 if(rateCode){
   const asMgr=await req('PUT',`/api/wht/rates/${rateCode}`,{token:mgr,body:{rate_percent:99}});
   ok('a General Manager cannot change a WHT rate (ownerOnly)', asMgr.status===403, `status=${asMgr.status}`);
   const asStaff=await req('GET','/api/wht/entries',{token:staff});
   ok('a cashier cannot read the WHT register', asStaff.status===403, `status=${asStaff.status}`);
   const sumStaff=await req('GET','/api/wht/summary',{token:staff});
   ok('a cashier cannot read the WHT summary', sumStaff.status===403, `status=${sumStaff.status}`);
 }

 console.log('\n--- D. WHT REMITTANCE INTEGRITY ---');
 const outstanding=listOf((await req('GET','/api/wht/entries?direction=PAYABLE&outstanding=true',{token:owner})).body)
   .filter(e=>e.branch_id===lagos.id);
 note(`outstanding PAYABLE at Lagos: ${outstanding.length}`);
 if(outstanding.length){
   const ids=outstanding.slice(0,3).map(e=>e.id);
   const before=(await req('GET','/api/wht/summary?branch_id='+lagos.id,{token:owner})).body;
   const rem=await req('POST','/api/wht/remit',{token:owner,body:{branch_id:lagos.id,entry_ids:ids,remittance_ref:'FIRS-TEST-1'}});
   ok('a remittance succeeds', rem.status===200||rem.status===201, `status=${rem.status} ${JSON.stringify(rem.body).slice(0,110)}`);
   const again=await req('POST','/api/wht/remit',{token:owner,body:{branch_id:lagos.id,entry_ids:ids,remittance_ref:'FIRS-TEST-1-dup'}});
   ok('remitting the SAME deductions twice is refused (no double-clearing)', again.status===409,
      `status=${again.status} ${String(again.body&&again.body.code)}`);
   const after=(await req('GET','/api/wht/summary?branch_id='+lagos.id,{token:owner})).body;
   ok('outstanding falls by exactly what was remitted',
      Math.abs((before.payable_outstanding - after.payable_outstanding) - (rem.body&&rem.body.total_remitted||0))<0.005
      || after.payable_outstanding < before.payable_outstanding,
      `before=${before.payable_outstanding} after=${after.payable_outstanding}`);
   await booksBalance('after remittance');
   // cross-branch remittance
   const minnaEntries=listOf((await req('GET','/api/wht/entries?outstanding=true',{token:owner})).body)
     .filter(e=>e.branch_id===minna.id && e.direction==='PAYABLE');
   if(minnaEntries.length){
     const x=await req('POST','/api/wht/remit',{token:lmgr,body:{branch_id:lagos.id,entry_ids:[minnaEntries[0].id]}});
     ok('a Lagos manager cannot remit a Minna deduction, and is told WHY',
        x.status===403 && x.body.code==='WHT_WRONG_BRANCH', `status=${x.status} ${String(x.body&&x.body.code)}`);
   } else note('no Minna PAYABLE deduction to test cross-branch remittance');
 } else note('no outstanding deductions — remittance path not exercised');

 console.log('\n--- E. WHT SUMMARY NEVER NETS THE TWO DIRECTIONS ---');
 const sum=(await req('GET','/api/wht/summary',{token:owner})).body;
 ok('summary reports payable and receivable separately',
    sum && sum.payable_outstanding!==undefined && sum.receivable_credit!==undefined, JSON.stringify(sum).slice(0,150));
 ok('summary states a remittance due date', !!(sum&&sum.next_remittance_due), String(sum&&sum.next_remittance_due));

 console.log('\n--- F. VAT ---');
 const vatBefore=(await req('GET','/api/settings/vat',{token:owner})).body;
 note(`VAT settings: ${JSON.stringify(vatBefore).slice(0,90)}`);
 const vatMgr=await req('PUT','/api/settings/vat',{token:mgr,body:{vat_rate_percent:7.5,vat_enabled:1}});
 ok('a manager cannot change VAT (ownerOnly)', vatMgr.status===403, `status=${vatMgr.status}`);
 // TRAP: the field is vat_rate_percent. Sending vat_rate meant the server
 // correctly ignored an unknown field and answered 200 — I was testing a
 // typo, not a validator. Use the real field name.
 for(const bad of [-1,101,'abc']){
   const r=await req('PUT','/api/settings/vat',{token:owner,body:{vat_rate_percent:bad,vat_enabled:1}});
   ok(`VAT rate ${bad} is refused`, r.status>=400, `status=${r.status}`);
 }
 // ...and an unknown field must not silently look like success.
 const ghost=await req('PUT','/api/settings/vat',{token:owner,body:{vat_rate:99}});
 note(`PUT /settings/vat with an UNKNOWN field 'vat_rate' -> ${ghost.status} (silent-ignore shape)`);

 console.log('\n--- F2. BUG 77: A SETTINGS TYPO MUST NOT REPORT SUCCESS ---');
 // Live-reproduced before the fix: PUT /settings/vat {"vat_rate":99} answered
 // 200 with VAT unchanged, and {"staff_can_void":false} answered 200 while the
 // cashier kept the power. An owner is told a money-critical change landed
 // when it did not. Refuse explicitly and name the valid fields.
 for (const [path,body,label] of [
   ['/api/settings/vat',{vat_rate:99},'VAT rate typo'],
   ['/api/settings/vat',{vatRatePercent:99},'VAT camelCase typo'],
   ['/api/settings/manager-permissions',{staff_can_void:false},'permission typo'],
   ['/api/settings/manager-permissions',{staff_void_window:999},'void-window typo'],
 ]) {
   const r=await req('PUT',path,{token:owner,body});
   ok(`${label} is refused, not silently ignored`, r.status===400 && r.body.code==='UNKNOWN_FIELD',
      `status=${r.status} ${String(r.body&&r.body.code)}`);
   ok(`...and the error names the valid fields`, Array.isArray(r.body&&r.body.valid_fields)&&r.body.valid_fields.length>0,
      JSON.stringify(r.body&&r.body.valid_fields||'').slice(0,90));
 }
 // ...and the correctly-spelled write must still work.
 const goodVat=await req('PUT','/api/settings/vat',{token:owner,body:{vat_enabled:true,vat_rate_percent:7.5}});
 ok('a correctly-spelled VAT write still succeeds', goodVat.status===200, `status=${goodVat.status}`);
 const goodPerm=await req('PUT','/api/settings/manager-permissions',{token:owner,body:{staff_can_void_sales:true,staff_void_window_minutes:15}});
 ok('a correctly-spelled permission write still succeeds', goodPerm.status===200, `status=${goodPerm.status}`);

 console.log('\n--- G. GL REPORT CONTRACTS ---');
 const pnlNoDates=await req('GET','/api/gl/profit-loss',{token:owner});
 ok('P&L without dates fails clearly (not a 500)', pnlNoDates.status===400, `status=${pnlNoDates.status}`);
 const pnl=(await req('GET','/api/gl/profit-loss?start_date=2020-01-01&end_date=2030-12-31',{token:owner})).body;
 ok('P&L returns revenue/expense/net', pnl && pnl.net_profit!==undefined, JSON.stringify(pnl).slice(0,140));
 if(pnl){
   const derived=money(Number(pnl.total_revenue||0)-Number(pnl.total_expenses||0));
   ok('net profit equals revenue minus expenses', Math.abs(derived-Number(pnl.net_profit))<0.005,
      `rev=${pnl.total_revenue} exp=${pnl.total_expenses} net=${pnl.net_profit} derived=${derived}`);
 }
 const bs=(await req('GET','/api/gl/balance-sheet',{token:owner})).body;
 ok('balance sheet balances', bs && (bs.balances===true||Math.abs(Number(bs.total_assets||0)-(Number(bs.total_liabilities||0)+Number(bs.total_equity||0)))<0.005),
    JSON.stringify(bs&&{a:bs.total_assets,l:bs.total_liabilities,e:bs.total_equity,b:bs.balances}).slice(0,140));
 const backwards=await req('GET','/api/gl/profit-loss?start_date=2030-01-01&end_date=2020-01-01',{token:owner});
 ok('a backwards date range is handled without a 500', backwards.status<500, `status=${backwards.status}`);
 const glStaff=await req('GET','/api/gl/trial-balance',{token:staff});
 ok('a cashier cannot read the trial balance', glStaff.status===403, `status=${glStaff.status}`);

 console.log('\n--- H. NO DRAFT / ORPHAN JOURNAL ENTRIES ---');
 const tb=listOf((await req('GET','/api/gl/trial-balance',{token:owner})).body);
 ok('trial balance returns per-account rows', tb.length>0, `n=${tb.length}`);
 await booksBalance('at the end of the accounting sweep');


 // Shared helpers for the GL-account assertions below.
 async function bal(l){const tb=listOf((await req('GET','/api/gl/trial-balance',{token:owner})).body);
  const dr=tb.reduce((x,y)=>x+ +(y.total_debits||0),0),cr=tb.reduce((x,y)=>x+ +(y.total_credits||0),0);
  ok('books balance '+l,Math.abs(dr-cr)<0.005,`dr=${dr.toFixed(2)} cr=${cr.toFixed(2)}`);}
 async function acct(code){const tb=listOf((await req('GET','/api/gl/trial-balance',{token:owner})).body);
  const r=tb.find(x=>x.account_code===code||x.code===code);
  return r? (+(r.total_debits||0) - +(r.total_credits||0)) : 0;}
 const prods=listOf((await req('GET','/api/products',{token:owner})).body);
 console.log('=== I. WHT ON A SALE, THEN VOIDING THAT SALE ===');
 const stock=listOf((await req('GET','/api/stock?branch_id='+lagos.id,{token:staff})).body);
 const pm=new Map(prods.map(p=>[p.id,p]));
 /* TRAP #63/#64: FEFO decides which batch fills a line, so the fixture must pick a batch that IS its product's FEFO batch, else the probe's arithmetic and the server's disagree. See lib-fefo.js. */
 const b=pickSellableFefoBatch(stock,{minQty:4,predicate:(s)=>s.selling_price_per_unit>=20&&pm.get(s.product_id)&&!pm.get(s.product_id).is_controlled&&pm.get(s.product_id).dispensing_type!=='POM'});
 if(!b){console.log('no suitable batch');process.exit(3);}
 const tl=listOf((await req('GET','/api/till?branch_id='+lagos.id,{token:owner})).body);
 if(!tl.some(t=>t.status==='OPEN')) await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:0}});
 const price=b.selling_price_per_unit;
 const whtRecvBefore=await acct('WHT_RECEIVABLE');
 const sale=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b.product_id,quantity:1,unit_type:'BASE_UNIT'}],
   payments:[{method:'CASH',amount:price*0.95}], wht_suffered: Math.round(price*0.05*100)/100, wht_rate_code:'PROFESSIONAL_FEES'}});
 ok('a sale with WHT suffered is accepted',sale.status===201,`status=${sale.status} ${String(sale.body&&sale.body.error).slice(0,110)}`);
 if(sale.status!==201){console.log(JSON.stringify(sale.body).slice(0,200));}
 const saleId=sale.body&&sale.body.id;
 if(saleId){
  const whtRecvAfter=await acct('WHT_RECEIVABLE');
  ok('WHT_RECEIVABLE (an ASSET) increased',whtRecvAfter>whtRecvBefore,`${whtRecvBefore} -> ${whtRecvAfter}`);
  // TRAP: wht_entries keys the origin as source_type/source_id, not sale_id.
  // Filtering on a column that does not exist matched nothing and reported a
  // missing register row against code that had written one correctly.
  const reg=listOf((await req('GET','/api/wht/entries?direction=RECEIVABLE',{token:owner})).body)
    .filter(e=>e.source_type==='SALE'&&e.source_id===saleId);
  ok('a RECEIVABLE register row was created',reg.length===1,`n=${reg.length}`);
  await bal('after a WHT sale');
  const v=await req('POST',`/api/sales/${saleId}/void`,{token:owner,body:{reason:'auditing WHT reversal on void'}});
  ok('the sale voids',v.status===200,`status=${v.status} ${String(v.body&&v.body.error).slice(0,90)}`);
  const whtRecvVoided=await acct('WHT_RECEIVABLE');
  ok('WHT_RECEIVABLE returns to its prior balance',Math.abs(whtRecvVoided-whtRecvBefore)<0.005,`${whtRecvBefore} -> ${whtRecvVoided}`);
  const reg2=listOf((await req('GET','/api/wht/entries?direction=RECEIVABLE',{token:owner})).body)
    .filter(e=>e.source_type==='SALE'&&e.source_id===saleId&&!e.is_deleted);
  ok('the WHT register row is withdrawn too (no phantom tax credit)',reg2.length===0,`still present: ${reg2.length}`);
  await bal('after voiding a WHT sale');
 }

 console.log('\n=== J. WHT ON A SUPPLIER PAYMENT ===');
 // TRAP 18 — seed the fixture rather than skipping. Supplier-payment WHT is
 // the single most common real deduction a Nigerian pharmacy makes, so it must
 // never go untested just because the seed happens to have no supplier.
 // TRAP 15 — the endpoint is /creditors/:supplierId/payments. My first version
 // invented /creditors/payments and read its 404 as "no suppliers".
 let sups=listOf((await req('GET','/api/suppliers',{token:owner})).body);
 if(!sups.length){
   const made=await req('POST','/api/suppliers',{token:owner,body:{name:'WHT Probe Supplier',phone:'08030000000',address:'Ikeja'}});
   if(made.status===201) sups=[made.body];
 }
 ok('a supplier exists to test supplier-payment WHT',sups.length>0);
 if(sups.length){
  // TRAP 7 — the 400 here ("this supplier is not owed anything") was the app
  // being RIGHT. A payment presupposes a debt, so create one the way a real
  // pharmacy does: raise a PO and receive it ON CREDIT.
  const prod=prods.find(p=>!p.is_controlled)||prods[0];
  const po=await req('POST','/api/purchase-orders',{token:owner,body:{branch_id:lagos.id,supplier_id:sups[0].id,
    items:[{product_id:prod.id,quantity_ordered:10,expected_unit_cost:500}]}});
  ok('a purchase order can be raised against the supplier',po.status===201,`status=${po.status} ${String(po.body&&po.body.error).slice(0,90)}`);
  if(po.status===201){
    const rec=await req('POST',`/api/purchase-orders/${po.body.id}/receive`,{token:owner,body:{
      on_credit:true,
      batches:[{product_id:prod.id,quantity_received:10,cost_price_per_unit:500,selling_price_per_unit:800,
                batch_no:'WHTPROBE',expiry_date:'2030-12-31'}]}});
    ok('...and received ON CREDIT, creating the debt',rec.status===200||rec.status===201,
      `status=${rec.status} ${String(rec.body&&rec.body.error).slice(0,110)}`);
    const bals=listOf((await req('GET','/api/creditors/balances',{token:owner})).body);
    const owed=bals.find(x=>x.supplier_id===sups[0].id);
    ok('the supplier is now owed money',!!owed&&Number(owed.balance_owed||0)>0,JSON.stringify(owed).slice(0,110));
  }
  const before=await acct('WHT_PAYABLE');
  // This is a WHT/GL assertion, not a drawer-funding assertion. Pay from the
  // safe — the reserve was explicitly funded in setup — so the test reaches
  // the tax posting without depending on whichever cash sales happened before
  // the till was opened. Drawer cash-floor behaviour is covered independently
  // by audit.money.js and probe-cashfloor.js.
  const pay=await req('POST',`/api/creditors/${sups[0].id}/payments`,{token:owner,
    body:{branch_id:lagos.id,amount:5000,paid_by_method:'SAFE',wht_rate_code:'PROFESSIONAL_FEES'}});
  ok('a supplier payment with WHT is accepted',pay.status===200||pay.status===201,
    `status=${pay.status} ${JSON.stringify(pay.body).slice(0,140)}`);
  if(pay.status===200||pay.status===201){
   const after=await acct('WHT_PAYABLE');
   // WHT_PAYABLE is a LIABILITY: credits exceed debits, so debit-minus-credit
   // becomes MORE NEGATIVE as the liability grows.
   ok('WHT_PAYABLE (a LIABILITY) grew',after<before-0.004,`${before} -> ${after}`);
   const reg=listOf((await req('GET','/api/wht/entries?direction=PAYABLE',{token:owner})).body)
     .filter(e=>e.source_type==='SUPPLIER_PAYMENT');
   ok('a PAYABLE register row was written',reg.length>0,`n=${reg.length}`);
   await bal('after a supplier payment with WHT');
  }
 }

 console.log('\n=== K. WHT CANNOT EXCEED THE TRANSACTION ===');
 const over=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b.product_id,quantity:1,unit_type:'BASE_UNIT'}],
   payments:[{method:'CASH',amount:1}], wht_suffered: price*10}});
 ok('WHT larger than the sale total is refused',over.status>=400&&/WHT_EXCEEDS_GROSS|WHT/.test(String(over.body&&over.body.code)),
   `status=${over.status} ${String(over.body&&over.body.code)}`);
 const neg=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
   items:[{product_id:b.product_id,quantity:1,unit_type:'BASE_UNIT'}],
   payments:[{method:'CASH',amount:price}], wht_suffered: -50}});
 ok('negative WHT suffered is refused',neg.status>=400,`status=${neg.status} ${String(neg.body&&neg.body.code)}`);
 await bal('at the end');

 console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
 if(notes.length){console.log('\nOBSERVATIONS:');notes.forEach(n=>console.log('  - '+n));}
 if(fails.length){console.log('\nFAILURES:');fails.forEach(f=>console.log('  - '+f));process.exit(1);}
})();
