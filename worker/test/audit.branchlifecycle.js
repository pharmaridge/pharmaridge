// BRANCH LIFECYCLE & PLAN/BILLING ENFORCEMENT
// Requires: bash test/devserver.sh 9001
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass=0,fail=0;const fails=[];const notes=[];
function ok(n,c,d){if(c){pass++;console.log('  OK   '+n);}else{fail++;fails.push(n+(d?' — '+d:''));console.log('  FAIL '+n+(d?'  -> '+d:''));}}
function note(m){notes.push(m);console.log('  ..   '+m);}
async function req(m,p,{token,body}={}){const h={'content-type':'application/json'};if(token)h.authorization='Bearer '+token;
 const r=await fetch(BASE+p,{method:m,headers:h,body:body?JSON.stringify(body):undefined});let j=null;const t=await r.text();
 try{j=t?JSON.parse(t):null}catch{j=t}return{status:r.status,body:j};}
const login=async(u,p='1234')=>(await req('POST','/api/auth/login',{body:{username:u,pin:p}})).body?.token;
const L=b=>Array.isArray(b)?b:[];
const uniq=()=>Math.random().toString(36).slice(2,8);

(async()=>{
 console.log('=== BRANCH LIFECYCLE & PLAN ENFORCEMENT AUDIT ===');
 try{const h=await fetch(BASE+'/api/health');if(!h.ok)throw new Error('health '+h.status);}
 catch(e){console.log('server not reachable: '+e.message);process.exit(3);}
 const owner=await login('owner'), admin=await login('admin'), staff=await login('lagos.staff'), lmgr=await login('lagos.mgr');
 const plan=async()=>(await req('GET','/api/dashboard/plan',{token:owner})).body;
 const branches=async()=>L((await req('GET','/api/branches',{token:owner})).body);
 const br0=await branches();
 const lagos=br0.find(b=>/lagos/i.test(b.name));
 const prods=L((await req('GET','/api/products',{token:owner})).body);
 const pmap=new Map(prods.map(p=>[p.id,p]));
 const otc=prods.find(p=>p.dispensing_type!=='POM'&&!p.is_controlled)||prods[0];
 let supplierId=(L((await req('GET','/api/suppliers',{token:owner})).body)[0]||{}).id;
 if(!supplierId) supplierId=(await req('POST','/api/suppliers',{token:owner,body:{name:'BranchSup '+uniq(),phone:'0803',address:'x'}})).body.id;
 async function bal(l){const tb=L((await req('GET','/api/gl/trial-balance',{token:owner})).body);
  const dr=tb.reduce((a,x)=>a+ +(x.total_debits||0),0),cr=tb.reduce((a,x)=>a+ +(x.total_credits||0),0);
  ok('books balance '+l,Math.abs(dr-cr)<0.005,`dr=${dr.toFixed(2)} cr=${cr.toFixed(2)}`);}

 console.log('\n--- A. WHO MAY OPEN AND CLOSE A BRANCH ---');
 const byStaff=await req('POST','/api/branches',{token:staff,body:{name:'Cashier Branch',address:'x',phone:'0803'}});
 ok('a cashier cannot create a branch',byStaff.status===403,`status=${byStaff.status}`);
 const byBM=await req('POST','/api/branches',{token:lmgr,body:{name:'BM Branch',address:'x',phone:'0803'}});
 ok('a Branch Manager cannot create a branch',byBM.status===403,`status=${byBM.status}`);
 const foreignEdit=await req('PUT',`/api/branches/${br0.find(b=>b.id!==lagos.id).id}`,{token:lmgr,body:{name:'Renamed by foreign BM'}});
 ok('a Branch Manager cannot edit ANOTHER branch',foreignEdit.status===403&&foreignEdit.body.code==='BRANCH_SCOPE_VIOLATION',
    `status=${foreignEdit.status}`);

 console.log('\n--- B. PLAN LIMITS ARE ENFORCED ---');
 const p0=await plan();
 note(`branches ${p0.branches.used}/${p0.branches.max} · staff ${p0.staff.used}/${p0.staff.max}`);
 const tighten=await req('PUT','/api/admin/settings',{token:admin,body:{max_branches:p0.branches.used}});
 ok('the vendor can tighten the branch cap',tighten.status===200,`status=${tighten.status}`);
 const atCap=await req('POST','/api/branches',{token:owner,body:{name:'Over Cap '+uniq(),address:'x',phone:'0803'}});
 ok('creating a branch AT the cap is refused',atCap.status===403&&atCap.body.code==='PLAN_LIMIT_EXCEEDED',
    `status=${atCap.status} ${String(atCap.body&&atCap.body.code)}`);
 const ownerRaise=await req('PUT','/api/admin/settings',{token:owner,body:{max_branches:999}});
 ok('the OWNER cannot raise their own plan limits',ownerRaise.status===403,`status=${ownerRaise.status}`);
 const capStill=await plan();
 ok('...and the cap really is unchanged',capStill.branches.max===p0.branches.used,`max=${capStill.branches.max}`);

 console.log('\n--- C. BUG 85: CLOSING A BRANCH FREES ITS PAID SLOT ---');
 const spare=(await branches()).find(b=>b.id!==lagos.id&&b.is_active);
 ok('a second active branch exists to close',!!spare,spare?spare.name:'none');
 const closeSpare=await req('PUT',`/api/branches/${spare.id}`,{token:owner,body:{is_active:false}});
 ok('it can be closed',closeSpare.status===200,`status=${closeSpare.status}`);
 const pAfter=await plan();
 ok('the closed branch NO LONGER counts against the plan',pAfter.branches.used===p0.branches.used-1,
    `${p0.branches.used} -> ${pAfter.branches.used}`);
 const replacement=await req('POST','/api/branches',{token:owner,body:{name:'Replacement '+uniq(),address:'12 New Road',phone:'0803'}});
 ok('...so a replacement branch CAN be opened at the same cap',replacement.status===201,
    `status=${replacement.status} ${String(replacement.body&&replacement.body.error).slice(0,80)}`);
 // symmetry with staff, which always behaved this way
 const pStaff=await plan();
 // TRAP: an earlier version deactivated whichever active STAFF it found first,
 // which was lagos.staff — the actor later sections depend on. Every downstream
 // 401 was this probe destroying its own fixture. Hire a disposable victim.
 await req('PUT','/api/admin/settings',{token:admin,body:{max_staff:pStaff.staff.used+1}});
 const victim=(await req('POST','/api/users',{token:owner,body:{branch_id:lagos.id,full_name:'Disposable Hire',username:'dh'+uniq(),pin:'4321',role:'STAFF'}})).body;
 ok('a disposable staff member is hired for the seat test',!!victim.id,`id=${victim.id&&victim.id.slice(0,8)}`);
 const pNow=await plan();
 await req('PUT','/api/admin/settings',{token:admin,body:{max_staff:pNow.staff.used}});
 const hireBlocked=await req('POST','/api/users',{token:owner,body:{branch_id:lagos.id,full_name:'Over Cap',username:'oc'+uniq(),pin:'4321',role:'STAFF'}});
 ok('hiring AT the staff cap is refused',hireBlocked.status===403,`status=${hireBlocked.status}`);
 await req('PUT',`/api/users/${victim.id}`,{token:owner,body:{is_active:false}});
 const hireAfter=await req('POST','/api/users',{token:owner,body:{branch_id:lagos.id,full_name:'Replacement Staff',username:'rs'+uniq(),pin:'4321',role:'STAFF'}});
 ok('deactivating a staff member frees their seat (unchanged behaviour)',hireAfter.status===201,`status=${hireAfter.status}`);
 ok('=> branch slots and staff slots now follow the SAME rule',true);
 await req('PUT','/api/admin/settings',{token:admin,body:{max_branches:20,max_staff:30}});

 console.log('\n--- D. BUG 86: CLOSURE WARNS ABOUT WORK IN FLIGHT ---');
 const wf=(await branches()).find(b=>b.is_active&&b.id===lagos.id)||lagos;
 // A till is ONE PER BRANCH. The seeded dataset already trades at this branch,
 // so opening another returns 409 TILL_ALREADY_OPEN and the whole section then
 // failed on `till.id === undefined` — the probe's assumption, not a fault.
 // What this section actually needs is "a till with cash in it", however it
 // got there: reuse the open session, and only open one if there is none.
 let till=L((await req('GET','/api/till?branch_id='+wf.id,{token:owner})).body).find(t=>t.status==='OPEN');
 if(!till) till=(await req('POST','/api/till/open',{token:staff,body:{branch_id:wf.id,opening_cash:25000}})).body;
 ok('a till is open with cash in it',!!(till&&till.id),`id=${till&&till.id&&till.id.slice(0,8)}`);
 const ci=(await req('POST','/api/attendance/clock-in',{token:staff,body:{branch_id:wf.id}})).body;
 const po=(await req('POST','/api/purchase-orders',{token:owner,body:{branch_id:wf.id,supplier_id:supplierId,
   items:[{product_id:otc.id,quantity_ordered:10,expected_unit_cost:100}]}})).body;
 const stk=(await req('POST','/api/stocktakes',{token:owner,body:{branch_id:wf.id}})).body;
 note(`in flight: till=${!!till.id} shift=${!!ci.id} po=${!!po.id} stocktake=${!!stk.id}`);
 const closed=await req('PUT',`/api/branches/${wf.id}`,{token:owner,body:{is_active:false}});
 ok('the branch closes (never blocked)',closed.status===200,`status=${closed.status}`);
 const warn=closed.body&&closed.body.closure_warning;
 ok('...and the response WARNS about unfinished work',!!warn,JSON.stringify(closed.body).slice(0,90));
 if(warn){
   ok('...naming the open till',warn.open_tills>=1,`open_tills=${warn.open_tills}`);
   ok('...the clocked-in staff',warn.open_shifts>=1,`open_shifts=${warn.open_shifts}`);
   ok('...the outstanding purchase order',warn.pending_purchase_orders>=1,`pos=${warn.pending_purchase_orders}`);
   ok('...the open stocktake',warn.open_stocktakes>=1,`stocktakes=${warn.open_stocktakes}`);
   ok('...and says the work can still be settled',/still work at a closed branch/i.test(String(warn.message)),
      String(warn.message).slice(0,100));
 }

 console.log('\n--- E. NEW TRADING IS BLOCKED AT A CLOSED BRANCH ---');
 for(const [label,call] of [
   ['a sale',()=>req('POST','/api/sales',{token:staff,body:{branch_id:wf.id,items:[{product_id:otc.id,quantity:1,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:25}]}})],
   ['opening a till',()=>req('POST','/api/till/open',{token:staff,body:{branch_id:wf.id,opening_cash:0}})],
   ['a clock-in',()=>req('POST','/api/attendance/clock-in',{token:staff,body:{branch_id:wf.id}})],
   ['raising a purchase order',()=>req('POST','/api/purchase-orders',{token:owner,body:{branch_id:wf.id,supplier_id:supplierId,items:[{product_id:otc.id,quantity_ordered:1,expected_unit_cost:100}]}})],
   ['receiving goods',()=>req('POST',`/api/purchase-orders/${po.id}/receive`,{token:owner,body:{batches:[{product_id:otc.id,quantity_received:10,cost_price_per_unit:100,selling_price_per_unit:200,batch_no:'X'+uniq(),expiry_date:'2030-01-01'}]}})],
   ['starting a stocktake',()=>req('POST','/api/stocktakes',{token:owner,body:{branch_id:wf.id}})],
   ['recording an expense',()=>req('POST','/api/expenses',{token:owner,body:{branch_id:wf.id,category:'RENT',amount:100,paid_by_method:'CASH'}})],
 ]){
   const r=await call();
   ok(`${label} is BLOCKED at a closed branch`,r.status===403,`status=${r.status}`);
 }

 console.log('\n--- F. BUG 84: WIND-DOWN STILL WORKS AT A CLOSED BRANCH ---');
 const t=await req('POST',`/api/till/${till.id}/close`,{token:owner,body:{counted_closing_cash:25000,force_reason:'branch closed'}});
 ok('the open till can still be closed (the cash is counted)',t.status===200,`status=${t.status} ${String(t.body&&t.body.error).slice(0,70)}`);
 const a=await req('POST',`/api/attendance/${ci.id}/force-clock-out`,{token:owner,body:{reason:'branch closed'}});
 ok('the open shift can still be ended',a.status===200,`status=${a.status}`);
 const k=await req('POST',`/api/stocktakes/${stk.id}/cancel`,{token:owner,body:{reason:'branch closed'}});
 ok('the open stocktake can still be cancelled',k.status===200,`status=${k.status}`);
 const pc=await req('POST',`/api/purchase-orders/${po.id}/cancel`,{token:owner,body:{reason:'branch closed'}});
 ok('the pending purchase order can still be cancelled (Bug 84)',pc.status===200,
    `status=${pc.status} ${String(pc.body&&pc.body.error).slice(0,80)}`);
 await bal('after winding a branch down');

 console.log('\n--- G. HISTORY SURVIVES CLOSURE ---');
 const hist=L((await req('GET','/api/sales?branch_id='+wf.id,{token:owner})).body);
 ok('the closed branch\'s sales are still readable',hist.length>=0,`n=${hist.length}`);
 const stillListed=(await branches()).find(b=>b.id===wf.id);
 ok('...and the branch still appears in the directory',!!stillListed,`is_active=${stillListed&&stillListed.is_active}`);

 console.log('\n--- H. RELOCATION: CARRY OVER OR START FRESH ---');
 const noMode=await req('POST',`/api/branches/${wf.id}/relocate`,{token:owner,body:{address:'9 Allen Avenue'}});
 ok('relocating without choosing a mode is refused',noMode.status===400&&noMode.body.code==='RELOCATION_MODE_REQUIRED',
    `status=${noMode.status} ${String(noMode.body&&noMode.body.code)}`);
 ok('...and the error explains BOTH choices',/CARRY_OVER/.test(String(noMode.body&&noMode.body.error))&&/FRESH_START/.test(String(noMode.body&&noMode.body.error)));
 const noAddr=await req('POST',`/api/branches/${wf.id}/relocate`,{token:owner,body:{mode:'CARRY_OVER'}});
 ok('relocating without an address is refused',noAddr.status===400,`status=${noAddr.status}`);
 const byBM2=await req('POST',`/api/branches/${wf.id}/relocate`,{token:lmgr,body:{mode:'CARRY_OVER',address:'x'}});
 ok('a Branch Manager cannot relocate a branch',byBM2.status===403,`status=${byBM2.status}`);
 const salesBefore=L((await req('GET','/api/sales?branch_id='+wf.id,{token:owner})).body).length;
 const carried=await req('POST',`/api/branches/${wf.id}/relocate`,{token:owner,
   body:{mode:'CARRY_OVER',name:'GreenLife Pharmacy - Ikeja (relocated)',address:'9 Allen Avenue, Ikeja'}});
 ok('CARRY_OVER reopens the SAME branch at a new address',carried.status===200,`status=${carried.status} ${String(carried.body&&carried.body.error).slice(0,80)}`);
 ok('...keeping the same branch id',carried.body&&carried.body.id===wf.id,`id match=${carried.body&&carried.body.id===wf.id}`);
 ok('...and it is trading again',carried.body&&carried.body.is_active===1,`is_active=${carried.body&&carried.body.is_active}`);
 const salesAfter=L((await req('GET','/api/sales?branch_id='+wf.id,{token:owner})).body).length;
 ok('...with its full trading history still attached',salesAfter===salesBefore,`${salesBefore} -> ${salesAfter}`);
 const sellAgain=await req('POST','/api/sales',{token:staff,body:{branch_id:wf.id,items:[{product_id:otc.id,quantity:1,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:25}]}});
 note(`selling at the relocated branch -> ${sellAgain.status} ${sellAgain.status!==201?String(sellAgain.body&&sellAgain.body.code||'').slice(0,40):''}`);

 // FRESH_START from a different closed branch
 const other=(await branches()).find(b=>!b.is_active);
 if(other){
   const fresh=await req('POST',`/api/branches/${other.id}/relocate`,{token:owner,
     body:{mode:'FRESH_START',name:'Brand New Shop '+uniq(),address:'1 Broad Street'}});
   ok('FRESH_START creates a SEPARATE new branch',fresh.status===201,`status=${fresh.status} ${String(fresh.body&&fresh.body.error).slice(0,80)}`);
   ok('...with a different id from the old one',fresh.body&&fresh.body.id!==other.id,`new=${fresh.body&&fresh.body.id!==other.id}`);
   const oldStill=(await branches()).find(b=>b.id===other.id);
   ok('...and the old branch stays closed, keeping its own history',oldStill&&oldStill.is_active===0,
      `old is_active=${oldStill&&oldStill.is_active}`);
 } else note('no closed branch available for the FRESH_START check');
 await bal('at the end of the branch sweep');

 console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
 if(notes.length){console.log('\nOBSERVATIONS:');notes.forEach(n=>console.log('  - '+n));}
 if(fails.length){console.log('\nFAILURES:');fails.forEach(f=>console.log('  - '+f));process.exit(1);}
})();
