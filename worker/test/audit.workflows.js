// PURCHASE ORDERS / SUPPLIERS / TRANSFERS — receiving, credit, branch-to-branch
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
const plus=(d)=>new Date(Date.now()+d*86400000).toISOString().slice(0,10);

(async()=>{
 console.log('=== PROCUREMENT / TRANSFERS AUDIT ===');
 try{const h=await fetch(BASE+'/api/health');if(!h.ok)throw new Error('health '+h.status);}
 catch(e){console.log('server not reachable: '+e.message);process.exit(3);}
 const owner=await login('owner'), staff=await login('lagos.staff'), lmgr=await login('lagos.mgr'), gm=await login('manager');
 const br=L((await req('GET','/api/branches',{token:owner})).body);
 const lagos=br.find(b=>/lagos/i.test(b.name)), minna=br.find(b=>/minna/i.test(b.name));
 const prods=L((await req('GET','/api/products',{token:owner})).body);
 const pmap=new Map(prods.map(p=>[p.id,p]));
 const otc=prods.find(p=>p.dispensing_type!=='POM'&&!p.is_controlled) || prods[0];

 async function bal(l){const tb=L((await req('GET','/api/gl/trial-balance',{token:owner})).body);
  const dr=tb.reduce((a,x)=>a+ +(x.total_debits||0),0),cr=tb.reduce((a,x)=>a+ +(x.total_credits||0),0);
  ok('books balance '+l,Math.abs(dr-cr)<0.005,`dr=${dr.toFixed(2)} cr=${cr.toFixed(2)}`);}
 async function acct(code){const tb=L((await req('GET','/api/gl/trial-balance',{token:owner})).body);
  const r=tb.find(x=>x.account_code===code);return r?(+(r.total_debits||0)-+(r.total_credits||0)):0;}

 let supplierId=null;
 {
   const sups=L((await req('GET','/api/suppliers',{token:owner})).body);
   supplierId = sups.length?sups[0].id
     : (await req('POST','/api/suppliers',{token:owner,body:{name:'Procurement Probe '+uniq(),phone:'08030000000',address:'Ikeja'}})).body.id;
   ok('a supplier exists',!!supplierId);
 }
 const raisePO=async(qty,cost,tok=owner,branch=lagos.id)=>req('POST','/api/purchase-orders',{token:tok,
   body:{branch_id:branch,supplier_id:supplierId,items:[{product_id:otc.id,quantity_ordered:qty,expected_unit_cost:cost}]}});

 console.log('\n--- A. SUPPLIER AUTHORITY AND PROJECTION ---');
 const supStaff=await req('GET','/api/suppliers',{token:staff});
 ok('a cashier CAN list suppliers (the PO screen needs it)',supStaff.status===200,`status=${supStaff.status}`);
 const first=L(supStaff.body)[0];
 ok('...but only sees id + name, never phone or address (Bug 72)',
    first && !('phone' in first) && !('address' in first),`keys=${first?Object.keys(first).join(','):'none'}`);
 const supMgr=L((await req('GET','/api/suppliers',{token:owner})).body)[0];
 ok('a manager sees the full supplier record',supMgr && ('phone' in supMgr),`keys=${supMgr?Object.keys(supMgr).join(','):'none'}`);
 const createByStaff=await req('POST','/api/suppliers',{token:staff,body:{name:'Cashier Supplier',phone:'0803'}});
 ok('a cashier cannot create a supplier',createByStaff.status===403,`status=${createByStaff.status}`);
 const editByStaff=await req('PUT',`/api/suppliers/${supplierId}`,{token:staff,body:{name:'Renamed by cashier'}});
 ok('a cashier cannot edit a supplier',editByStaff.status===403,`status=${editByStaff.status}`);

 console.log('\n--- B. PURCHASE ORDER VALIDATION ---');
 const noItems=await req('POST','/api/purchase-orders',{token:owner,body:{branch_id:lagos.id,supplier_id:supplierId,items:[]}});
 ok('a PO with no line items is refused',noItems.status>=400,`status=${noItems.status}`);
 // BUG 82 — a base unit is an indivisible physical object. `isFinite` accepted
 // 1.5, so "1.5 tablets" could be ordered, received onto the shelf, and sold.
 // Transfers and adjustments already enforced isInteger; procurement and sales
 // were the outliers.
 for(const q of [0,-5,1.5,2.7,0.5]){
   const r=await raisePO(q,100);
   ok(`quantity_ordered ${q} is refused`,r.status>=400,`status=${r.status}`);
 }
 const negCost=await raisePO(5,-100);
 ok('a negative expected cost is refused',negCost.status>=400,`status=${negCost.status}`);
 const badProd=await req('POST','/api/purchase-orders',{token:owner,
   body:{branch_id:lagos.id,supplier_id:supplierId,items:[{product_id:'nope',quantity_ordered:1,expected_unit_cost:10}]}});
 ok('an unknown product is refused cleanly (not a 500)',badProd.status>=400&&badProd.status<500,`status=${badProd.status}`);
 const badSup=await req('POST','/api/purchase-orders',{token:owner,
   body:{branch_id:lagos.id,supplier_id:'nope',items:[{product_id:otc.id,quantity_ordered:1,expected_unit_cost:10}]}});
 ok('an unknown supplier is refused cleanly',badSup.status>=400&&badSup.status<500,`status=${badSup.status}`);

 console.log('\n--- C. RECEIVING: CASH VS CREDIT MOVE DIFFERENT ACCOUNTS ---');
 const cashBefore=await acct('CASH'), apBefore=await acct('ACCOUNTS_PAYABLE');
 const po1=await raisePO(10,150);
 ok('a PO can be raised',po1.status===201,`status=${po1.status} ${String(po1.body&&po1.body.error).slice(0,70)}`);
 const rec1=await req('POST',`/api/purchase-orders/${po1.body.id}/receive`,{token:owner,body:{
   batches:[{product_id:otc.id,quantity_received:10,cost_price_per_unit:150,selling_price_per_unit:300,batch_no:'CASHPO'+uniq(),expiry_date:plus(400)}]}});
 ok('receiving for CASH succeeds',rec1.status===200||rec1.status===201,`status=${rec1.status} ${String(rec1.body&&rec1.body.error).slice(0,80)}`);
 const cashAfter=await acct('CASH');
 ok('...and CASH falls by the cost of goods received',m2(cashBefore-cashAfter)===1500,`${cashBefore} -> ${cashAfter}`);
 const po2=await raisePO(10,150);
 const rec2=await req('POST',`/api/purchase-orders/${po2.body.id}/receive`,{token:owner,body:{on_credit:true,
   batches:[{product_id:otc.id,quantity_received:10,cost_price_per_unit:150,selling_price_per_unit:300,batch_no:'CREDPO'+uniq(),expiry_date:plus(400)}]}});
 ok('receiving ON CREDIT succeeds',rec2.status===200||rec2.status===201,`status=${rec2.status}`);
 const cashAfter2=await acct('CASH'), apAfter=await acct('ACCOUNTS_PAYABLE');
 ok('...and CASH is untouched by a credit receipt',m2(cashAfter2-cashAfter)===0,`${cashAfter} -> ${cashAfter2}`);
 ok('...while ACCOUNTS_PAYABLE grows by the same 1500',m2(apBefore-apAfter)===1500,`${apBefore} -> ${apAfter}`);
 await bal('after cash and credit receipts');

 console.log('\n--- D. OVER-RECEIVING AND PARTIAL RECEIPT ---');
 const po3=await raisePO(10,100);
 const over=await req('POST',`/api/purchase-orders/${po3.body.id}/receive`,{token:owner,body:{
   batches:[{product_id:otc.id,quantity_received:50,cost_price_per_unit:100,selling_price_per_unit:200,batch_no:'OVER'+uniq(),expiry_date:plus(400)}]}});
 ok('receiving MORE than was ordered is refused',over.status>=400,`status=${over.status} ${String(over.body&&over.body.error).slice(0,90)}`);
 const partial=await req('POST',`/api/purchase-orders/${po3.body.id}/receive`,{token:owner,body:{
   batches:[{product_id:otc.id,quantity_received:4,cost_price_per_unit:100,selling_price_per_unit:200,batch_no:'PART'+uniq(),expiry_date:plus(400)}]}});
 ok('a PARTIAL receipt is accepted',partial.status===200||partial.status===201,`status=${partial.status}`);
 const po3state=(await req('GET',`/api/purchase-orders/${po3.body.id}`,{token:owner})).body;
 ok('...and the order stays open as PARTIALLY_RECEIVED',po3state&&po3state.status==='PARTIALLY_RECEIVED',`status=${po3state&&po3state.status}`);
 const rest=await req('POST',`/api/purchase-orders/${po3.body.id}/receive`,{token:owner,body:{
   batches:[{product_id:otc.id,quantity_received:6,cost_price_per_unit:100,selling_price_per_unit:200,batch_no:'REST'+uniq(),expiry_date:plus(400)}]}});
 ok('the remainder can be received',rest.status===200||rest.status===201,`status=${rest.status}`);
 const po3done=(await req('GET',`/api/purchase-orders/${po3.body.id}`,{token:owner})).body;
 ok('...and the order closes as RECEIVED',po3done&&po3done.status==='RECEIVED',`status=${po3done&&po3done.status}`);
 const afterDone=await req('POST',`/api/purchase-orders/${po3.body.id}/receive`,{token:owner,body:{
   batches:[{product_id:otc.id,quantity_received:1,cost_price_per_unit:100,selling_price_per_unit:200,batch_no:'X'+uniq(),expiry_date:plus(400)}]}});
 ok('a fully received order cannot be received again',afterDone.status>=400,`status=${afterDone.status}`);

 console.log('\n--- D2. BUG 82: FRACTIONAL UNITS CANNOT REACH THE SHELF ---');
 {
   const poF=await raisePO(10,100);
   const frac=await req('POST',`/api/purchase-orders/${poF.body.id}/receive`,{token:owner,body:{
     batches:[{product_id:otc.id,quantity_received:2.5,cost_price_per_unit:100,selling_price_per_unit:200,batch_no:'FRAC'+uniq(),expiry_date:plus(300)}]}});
   ok('receiving a FRACTIONAL quantity is refused',frac.status===400&&frac.body.code==='QUANTITY_NOT_WHOLE',
      `status=${frac.status} ${String(frac.body&&frac.body.code)}`);
   const wholeNo='WHOLE'+uniq();
   const whole=await req('POST',`/api/purchase-orders/${poF.body.id}/receive`,{token:owner,body:{
     batches:[{product_id:otc.id,quantity_received:10,cost_price_per_unit:100,selling_price_per_unit:200,batch_no:wholeNo,expiry_date:plus(300)}]}});
   ok('...while a whole quantity still receives normally',whole.status===200||whole.status===201,`status=${whole.status}`);
   const rows=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body);
   const fractional=rows.filter(x=>!Number.isInteger(x.quantity_remaining));
   ok('NO stock row anywhere holds a fractional quantity',fractional.length===0,
      `fractional rows: ${fractional.map(x=>x.batch_no+'='+x.quantity_remaining).join(', ')}`);
   // ...and the sale path, which shares the flaw.
   const sellable=rows.find(x=>x.quantity_remaining>3&&x.selling_price_per_unit>0
     &&pmap.get(x.product_id)&&pmap.get(x.product_id).dispensing_type!=='POM');
   if(sellable){
     const tl=L((await req('GET','/api/till?branch_id='+lagos.id,{token:owner})).body);
     if(!tl.some(x=>x.status==='OPEN')) await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:0}});
     const sf=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
       items:[{product_id:sellable.product_id,quantity:1.5,unit_type:'BASE_UNIT'}],
       payments:[{method:'CASH',amount:m2(1.5*sellable.selling_price_per_unit)}]}});
     ok('selling a fractional quantity is refused too',sf.status===400,`status=${sf.status}`);
     const sw=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
       items:[{product_id:sellable.product_id,quantity:2,unit_type:'BASE_UNIT'}],
       payments:[{method:'CASH',amount:m2(2*sellable.selling_price_per_unit)}]}});
     ok('...while a whole quantity still sells normally',sw.status===201,`status=${sw.status}`);
   } else note('no sellable batch for the fractional-sale check');
 }

 console.log('\n--- E. EXPIRED STOCK CANNOT BE RECEIVED ---');
 const po4=await raisePO(5,100);
 const expd=await req('POST',`/api/purchase-orders/${po4.body.id}/receive`,{token:owner,body:{
   batches:[{product_id:otc.id,quantity_received:5,cost_price_per_unit:100,selling_price_per_unit:200,batch_no:'EXP'+uniq(),expiry_date:plus(-1)}]}});
 ok('receiving already-expired stock is refused at the door',expd.status>=400,`status=${expd.status} ${String(expd.body&&expd.body.code)}`);
 const noExpiry=await req('POST',`/api/purchase-orders/${po4.body.id}/receive`,{token:owner,body:{
   batches:[{product_id:otc.id,quantity_received:5,cost_price_per_unit:100,selling_price_per_unit:-50,batch_no:'NEG'+uniq(),expiry_date:plus(300)}]}});
 ok('a negative selling price is refused',noExpiry.status>=400,`status=${noExpiry.status}`);

 console.log('\n--- F. PO CANCELLATION ---');
 const po5=await raisePO(5,100);
 const cancelStaff=await req('POST',`/api/purchase-orders/${po5.body.id}/cancel`,{token:staff,body:{reason:'cashier cancelling'}});
 ok('a cashier cannot cancel a purchase order',cancelStaff.status===403,`status=${cancelStaff.status}`);
 const noReason=await req('POST',`/api/purchase-orders/${po5.body.id}/cancel`,{token:owner,body:{}});
 ok('cancelling without a reason is refused',noReason.status>=400,`status=${noReason.status} ${String(noReason.body&&noReason.body.code)}`);
 const cancelled=await req('POST',`/api/purchase-orders/${po5.body.id}/cancel`,{token:owner,body:{reason:'ordered in error'}});
 ok('a manager can cancel with a reason',cancelled.status===200,`status=${cancelled.status}`);
 const recCancelled=await req('POST',`/api/purchase-orders/${po5.body.id}/receive`,{token:owner,body:{
   batches:[{product_id:otc.id,quantity_received:1,cost_price_per_unit:100,selling_price_per_unit:200,batch_no:'C'+uniq(),expiry_date:plus(300)}]}});
 ok('a CANCELLED order cannot be received',recCancelled.status>=400,`status=${recCancelled.status}`);

 console.log('\n--- G. CREDITOR BALANCE AND PAYMENT ---');
 const bals=L((await req('GET','/api/creditors/balances',{token:owner})).body);
 // v_creditor_balances is grouped by supplier AND BRANCH, and the richer seed
 // gives one supplier debt at several branches. Matching on supplier alone
 // returned a DIFFERENT branch's row than the one being paid, so the balance
 // "did not move" — the app was right and this lookup was wrong. Scope the
 // read to the same branch the payment is posted to.
 const owed=bals.find(x=>x.supplier_id===supplierId&&x.branch_id===lagos.id);
 ok('the supplier now shows an outstanding balance',owed&&Number(owed.balance_owed)>0,JSON.stringify(owed).slice(0,110));
 const owedAmt=Number(owed.balance_owed);
 const overPay=await req('POST',`/api/creditors/${supplierId}/payments`,{token:owner,body:{branch_id:lagos.id,amount:m2(owedAmt*10)}});
 ok('a supplier cannot be paid more than is owed (Bug 55)',overPay.status>=400,`status=${overPay.status}`);
 const payStaff=await req('POST',`/api/creditors/${supplierId}/payments`,{token:staff,body:{branch_id:lagos.id,amount:10}});
 ok('a cashier cannot pay a supplier',payStaff.status===403,`status=${payStaff.status}`);
 const balStaff=await req('GET','/api/creditors/balances',{token:staff});
 ok('a cashier cannot read supplier debt',balStaff.status===403,`status=${balStaff.status}`);
 // Payment method is deliberately TRANSFER here: this assertion exercises
 // creditor-balance reduction, not whether the till drawer happens to have a
 // large enough physical cash balance after the procurement fixtures.
 const pay=await req('POST',`/api/creditors/${supplierId}/payments`,{token:owner,body:{branch_id:lagos.id,amount:m2(owedAmt/2),paid_by_method:'TRANSFER'}});
 ok('a manager can pay part of the balance',pay.status===201,`status=${pay.status}`);
 const bals2=L((await req('GET','/api/creditors/balances',{token:owner})).body);
 const owed2=bals2.find(x=>x.supplier_id===supplierId&&x.branch_id===lagos.id);
 ok('...and the balance falls by exactly that amount',m2(owedAmt-Number(owed2.balance_owed))===m2(owedAmt/2),
    `${owedAmt} -> ${owed2&&owed2.balance_owed}`);
 await bal('after a supplier payment');

 console.log('\n--- H. TRANSFERS: BRANCH FENCING ---');
 const lstock=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body)
   .filter(x=>x.quantity_remaining>10&&pmap.get(x.product_id)&&pmap.get(x.product_id).dispensing_type!=='POM');
 ok('Lagos has transferable stock',lstock.length>0,`n=${lstock.length}`);
 const src=lstock[0];
 const mstock=L((await req('GET','/api/stock?branch_id='+minna.id,{token:owner})).body).filter(x=>x.quantity_remaining>5);
 if(mstock.length){
   const pull=await req('POST','/api/transfers',{token:lmgr,body:{to_branch_id:lagos.id,stock_batch_id:mstock[0].id,quantity:1}});
   ok('a Lagos manager cannot PULL stock out of Minna',pull.status===403&&pull.body.code==='BRANCH_SCOPE_VIOLATION',
      `status=${pull.status} ${String(pull.body&&pull.body.code)}`);
 } else note('no Minna stock to test the cross-branch pull');
 const sameBranch=await req('POST','/api/transfers',{token:owner,body:{to_branch_id:lagos.id,stock_batch_id:src.id,quantity:1}});
 ok('a transfer to the SAME branch is refused',sameBranch.status>=400,`status=${sameBranch.status}`);
 for(const q of [0,-5,1.5]){
   const r=await req('POST','/api/transfers',{token:owner,body:{to_branch_id:minna.id,stock_batch_id:src.id,quantity:q}});
   ok(`transfer quantity ${q} is refused`,r.status>=400,`status=${r.status}`);
 }
 const tooMuch=await req('POST','/api/transfers',{token:owner,body:{to_branch_id:minna.id,stock_batch_id:src.id,quantity:src.quantity_remaining+1000}});
 ok('transferring more than the batch holds is refused',tooMuch.status>=400,`status=${tooMuch.status}`);

 console.log('\n--- I. A TRANSFER MOVES STOCK AND VALUE BETWEEN BRANCHES ---');
 const moveQty=5;
 const srcBefore=src.quantity_remaining;
 const t=await req('POST','/api/transfers',{token:owner,body:{to_branch_id:minna.id,stock_batch_id:src.id,quantity:moveQty}});
 ok('a transfer can be initiated',t.status===201,`status=${t.status} ${String(t.body&&t.body.error).slice(0,80)}`);
 const midSrc=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.id===src.id);
 ok('stock is NOT deducted until receipt (dispatch does not reserve)',midSrc.quantity_remaining===srcBefore,
    `${srcBefore} -> ${midSrc.quantity_remaining}`);
 const recvByStaff=await req('POST',`/api/transfers/${t.body.id}/receive`,{token:staff,body:{}});
 ok('a Lagos cashier cannot receive a transfer destined for Minna',recvByStaff.status===403,`status=${recvByStaff.status}`);
 const recvd=await req('POST',`/api/transfers/${t.body.id}/receive`,{token:owner,body:{}});
 ok('an org-wide manager can receive it',recvd.status===200,`status=${recvd.status} ${String(recvd.body&&recvd.body.error).slice(0,80)}`);
 const srcAfter=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.id===src.id);
 ok('...the source branch loses exactly the transferred quantity',srcBefore-srcAfter.quantity_remaining===moveQty,
    `${srcBefore} -> ${srcAfter.quantity_remaining}`);
 const destRows=L((await req('GET','/api/stock?branch_id='+minna.id,{token:owner})).body)
   .filter(x=>x.product_id===src.product_id&&x.batch_no===src.batch_no);
 ok('...and the destination gains a batch with the SAME batch number and expiry',
    destRows.some(x=>x.quantity_remaining===moveQty&&x.expiry_date===src.expiry_date),
    `dest rows=${destRows.map(x=>x.batch_no+':'+x.quantity_remaining).join(',')}`);
 const rerecv=await req('POST',`/api/transfers/${t.body.id}/receive`,{token:owner,body:{}});
 ok('a received transfer cannot be received twice',rerecv.status>=400,`status=${rerecv.status}`);
 await bal('after a completed transfer');

 console.log('\n--- J. A TRANSFER WHOSE STOCK IS SOLD BEFORE RECEIPT ---');
 // TRAP #63/#64 — see test/tools/lib-fefo.js.
 const src2=pickSellableFefoBatch(
   L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body),
   {minQty:6,predicate:(x)=>pmap.get(x.product_id)&&pmap.get(x.product_id).dispensing_type!=='POM'&&!pmap.get(x.product_id).is_controlled});
 if(src2){
   const all=src2.quantity_remaining;
   const t2=await req('POST','/api/transfers',{token:owner,body:{to_branch_id:minna.id,stock_batch_id:src2.id,quantity:all}});
   const tl=L((await req('GET','/api/till?branch_id='+lagos.id,{token:owner})).body);
   if(!tl.some(x=>x.status==='OPEN')) await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:0}});
   await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
     items:[{product_id:src2.product_id,quantity:all,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:m2(all*src2.selling_price_per_unit)}]}});
   const blocked=await req('POST',`/api/transfers/${t2.body.id}/receive`,{token:owner,body:{}});
   ok('receiving a transfer whose stock was sold is REFUSED (no fabricated stock)',blocked.status>=400,
      `status=${blocked.status} ${String(blocked.body&&blocked.body.error).slice(0,70)}`);
   const cancel=await req('POST',`/api/transfers/${t2.body.id}/cancel`,{token:owner,body:{reason:'source stock sold before receipt'}});
   ok('...and the blocked transfer can be cancelled to clear it',cancel.status===200,`status=${cancel.status}`);
   await bal('after a blocked-then-cancelled transfer');
 } else note('no suitable batch for the sold-before-receipt scenario');

 console.log('\n--- K. TRANSFER VISIBILITY ---');
 const seen=L((await req('GET','/api/transfers',{token:lmgr})).body);
 const foreign=seen.filter(x=>x.from_branch_id!==lagos.id&&x.to_branch_id!==lagos.id);
 ok('a Branch Manager sees only transfers involving their own branch',foreign.length===0,`foreign=${foreign.length}`);

 await bal('at the end of the procurement sweep');
 console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
 if(notes.length){console.log('\nOBSERVATIONS:');notes.forEach(n=>console.log('  - '+n));}
 if(fails.length){console.log('\nFAILURES:');fails.forEach(f=>console.log('  - '+f));process.exit(1);}
})();
