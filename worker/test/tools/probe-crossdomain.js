// CROSS-DOMAIN SEAMS: role change x accounting x branch x every subsystem
// Requires: bash test/devserver.sh 9001
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass=0,fail=0;const fails=[];const notes=[];
function ok(n,c,d){if(c){pass++;console.log('  OK   '+n);}else{fail++;fails.push(n+(d?' — '+d:''));console.log('  FAIL '+n+(d?'  -> '+d:''));}}
function note(m){notes.push(m);console.log('  ..   '+m);}
async function req(m,p,{token,body,idem}={}){const h={'content-type':'application/json'};if(token)h.authorization='Bearer '+token;
 if(idem)h['Idempotency-Key']=idem;
 const r=await fetch(BASE+p,{method:m,headers:h,body:body?JSON.stringify(body):undefined});let j=null;const t=await r.text();
 try{j=t?JSON.parse(t):null}catch{j=t}return{status:r.status,body:j};}
const login=async(u,p='1234')=>(await req('POST','/api/auth/login',{body:{username:u,pin:p}})).body?.token;
const L=b=>Array.isArray(b)?b:[];
// BUG 108: a staff transfer is STAGED and applies only on confirmation.
// Success-path calls must complete both steps or they assert a move that has
// not happened yet. A REFUSAL still comes back from the staging call itself,
// so checks that expect a rejection are unaffected and keep working.
async function xfer(userId, body, token) {
  const staged = await req('POST', `/api/users/${userId}/transfer`, { token, body });
  if (staged.status !== 200 || !staged.body || !staged.body.pending_transfer) return staged;
  return req('POST', `/api/users/transfers/pending/${staged.body.pending_transfer.id}/force`, { token, body: {} });
}
const uniq=()=>Math.random().toString(36).slice(2,8);
const m2=n=>Math.round(n*100)/100;

(async()=>{
 console.log('=== CROSS-DOMAIN SEAM AUDIT ===');
 try{const h=await fetch(BASE+'/api/health');if(!h.ok)throw new Error('health '+h.status);}
 catch(e){console.log('server not reachable: '+e.message);process.exit(3);}
 let owner=await login('owner'); const admin=await login('admin'), gm=await login('manager'), lmgr=await login('lagos.mgr');
 const br=L((await req('GET','/api/branches',{token:owner})).body);
 // Earlier suites may rename or relocate branches, so never assume a name is
 // still present — pick two ACTIVE branches and fail loudly if there are not two.
 const active=br.filter(b=>b.is_active);
 const lagos=active.find(b=>/lagos/i.test(b.name)) || active[0];
 const minna=active.find(b=>b.id!==(lagos&&lagos.id));
 ok('two active branches exist for the cross-branch checks',!!lagos&&!!minna,
    `active=${active.length} names=${active.map(b=>b.name).join(' | ').slice(0,80)}`);
 if(!lagos||!minna){console.log('\nRESULT: '+pass+' passed, '+(fail+1)+' failed');process.exit(1);}
 const prods=L((await req('GET','/api/products',{token:owner})).body);
 const pmap=new Map(prods.map(p=>[p.id,p]));
 const pick=async(bid)=>L((await req('GET','/api/stock?branch_id='+bid,{token:owner})).body)
   .find(x=>x.quantity_remaining>40&&x.selling_price_per_unit>0&&pmap.get(x.product_id)&&pmap.get(x.product_id).dispensing_type!=='POM');
 const batch=await pick(lagos.id);
 // TRAP 18: the supplier-projection checks below silently asserted nothing on a
 // fresh database ("keys=none"). Seed a supplier so the projection is real.
 {
   const sups=L((await req('GET','/api/suppliers',{token:owner})).body);
   if(!sups.length){
     await req('POST','/api/suppliers',{token:owner,
       body:{name:'CrossDomain Supplier '+uniq(),phone:'08031234567',address:'12 Ikeja Road'}});
   }
   const check=L((await req('GET','/api/suppliers',{token:owner})).body);
   ok('a supplier exists for the projection checks',check.length>0,`n=${check.length}`);
 }
 async function bal(l){const tb=L((await req('GET','/api/gl/trial-balance',{token:owner})).body);
  const dr=tb.reduce((a,x)=>a+ +(x.total_debits||0),0),cr=tb.reduce((a,x)=>a+ +(x.total_credits||0),0);
  ok('books balance '+l,Math.abs(dr-cr)<0.005,`dr=${dr.toFixed(2)} cr=${cr.toFixed(2)}`);}
 const hire=async(role,bid,name)=>{
   const u=(name||'x')+'-'+uniq();
   const r=await req('POST','/api/users',{token:owner,body:{branch_id:bid,full_name:name||'Test',username:u,pin:'4321',role}});
   return r.status===201?{...r.body,username:u,token:await login(u,'4321')}:null;
 };
 const openTill=async(tok,bid,cash=0)=>{
   const tl=L((await req('GET','/api/till?branch_id='+bid,{token:owner})).body).filter(t=>t.status==='OPEN');
   for(const t of tl){const e=(await req('GET',`/api/till/${t.id}/expected`,{token:owner})).body;
     await req('POST',`/api/till/${t.id}/close`,{token:owner,body:{counted_closing_cash:e.expected_closing_cash,force_reason:'probe reset'}});}
   return (await req('POST','/api/till/open',{token:tok,body:{branch_id:bid,opening_cash:cash}})).body;
 };

 console.log('\n--- A. A PROMOTION DOES NOT REWRITE PAST MONEY ---');
 const c1=await hire('STAFF',lagos.id,'Ladder');
 ok('a cashier is hired',!!c1);
 await openTill(c1.token,lagos.id,0);
 const sale=await req('POST','/api/sales',{token:c1.token,body:{branch_id:lagos.id,
   items:[{product_id:batch.product_id,quantity:2,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:m2(2*batch.selling_price_per_unit)}]}});
 ok('they record a sale as STAFF',sale.status===201,`status=${sale.status}`);
 const before=(await req('GET',`/api/sales/${sale.body.id}`,{token:owner})).body;
 // settle the till so the transfer guard does not block
 const t0=L((await req('GET','/api/till?branch_id='+lagos.id,{token:owner})).body).find(t=>t.status==='OPEN');
 if(t0){const e=(await req('GET',`/api/till/${t0.id}/expected`,{token:owner})).body;
   await req('POST',`/api/till/${t0.id}/close`,{token:owner,body:{counted_closing_cash:e.expected_closing_cash,force_reason:'settling before promotion'}});}
 const promo=await xfer(c1.id,{role:'MANAGER',branch_id:lagos.id,reason:'Promoted to Branch Manager'},owner);
 ok('they are promoted to Branch Manager',promo.status===200,`status=${promo.status} ${String(promo.body&&promo.body.error).slice(0,70)}`);
 const after=(await req('GET',`/api/sales/${sale.body.id}`,{token:owner})).body;
 ok('the old sale keeps its original branch',after.branch_id===before.branch_id);
 ok('...its original server (attribution unchanged)',after.served_by===before.served_by&&after.served_by_name===before.served_by_name,
    `${before.served_by_name} -> ${after.served_by_name}`);
 ok('...and its total is untouched',m2(after.total)===m2(before.total),`${before.total} -> ${after.total}`);
 await bal('after a promotion');

 console.log('\n--- B. NEW AUTHORITY IS IMMEDIATE, OLD TOKENS INCLUDED ---');
 const stale=c1.token; // minted while they were STAFF
 const usersNow=await req('GET','/api/users',{token:stale});
 ok('a token minted BEFORE the promotion now passes manager gates',usersNow.status===200,`status=${usersNow.status}`);
 const vat=await req('PUT','/api/settings/vat',{token:stale,body:{vat_rate_percent:7.5,vat_enabled:true}});
 ok('...but still cannot do owner-only things',vat.status===403,`status=${vat.status}`);
 const supp=L((await req('GET','/api/suppliers',{token:stale})).body)[0];
 ok('...and now sees the FULL supplier record (manager projection)',supp&&('phone' in supp),`keys=${supp?Object.keys(supp).join(','):'none'}`);

 console.log('\n--- C. DEMOTION REVOKES INSTANTLY ---');
 const demo=await xfer(c1.id,{role:'STAFF',branch_id:lagos.id,reason:'Stepped back to the counter'},owner);
 ok('they are demoted to STAFF',demo.status===200,`status=${demo.status}`);
 const usersAfter=await req('GET','/api/users',{token:stale});
 ok('the SAME token loses manager access immediately',usersAfter.status===403,`status=${usersAfter.status}`);
 const supp2=L((await req('GET','/api/suppliers',{token:stale})).body)[0];
 ok('...and the supplier projection narrows back to id+name',supp2&&!('phone' in supp2),`keys=${supp2?Object.keys(supp2).join(','):'none'}`);
 const adj=await req('POST','/api/adjustments',{token:stale,body:{branch_id:lagos.id,stock_batch_id:batch.id,quantity_change:-500,adjustment_type:'DAMAGE',reason:'over the cap now'}});
 ok('...and the STAFF write-off cap applies again',adj.status>=400,`status=${adj.status} ${String(adj.body&&adj.body.code)}`);

 console.log('\n--- D. A BRANCH MOVE RE-SCOPES EVERY SUBSYSTEM AT ONCE ---');
 const mv=await xfer(c1.id,{branch_id:minna.id,reason:'Moved to Minna'},owner);
 ok('they are moved to Minna',mv.status===200,`status=${mv.status} ${String(mv.body&&mv.body.error).slice(0,70)}`);
 const tok=await login(c1.username,'4321');
 for(const [label,path] of [['stock','/api/stock?branch_id='+lagos.id],['sales','/api/sales?branch_id='+lagos.id],
                            ['till','/api/till?branch_id='+lagos.id],['attendance','/api/attendance?branch_id='+lagos.id],
                            ['customers','/api/customers']]){
   const r=await req('GET',path,{token:tok});
   const rows=L(r.body).filter(x=>x.branch_id===lagos.id);
   ok(`${label}: no OLD-branch rows leak after the move`,rows.length===0,`leaked=${rows.length}`);
 }
 const oldSale=await req('GET',`/api/sales/${sale.body.id}`,{token:tok});
 ok('...and their own old sale is now out of reach',oldSale.status===403,`status=${oldSale.status}`);
 // "Can they trade here now?" — asserted on AUTHORISATION, not on winning a
 // race for the branch's single till. The seeded dataset already trades at
 // Minna, so opening a second session correctly returns 409 TILL_ALREADY_OPEN;
 // reading that as a scope refusal was this probe's error, not the app's. A
 // 403/BRANCH_SCOPE_VIOLATION would be the real failure.
 const newTill=await req('POST','/api/till/open',{token:tok,body:{branch_id:minna.id,opening_cash:0}});
 const admitted=newTill.status===201||(newTill.status===409&&String(newTill.body&&newTill.body.code)==='TILL_ALREADY_OPEN');
 ok('...while they can trade at the NEW branch immediately',admitted,
   `status=${newTill.status} ${String(newTill.body&&newTill.body.code||'')}`);
 if(newTill.status===201) await req('POST',`/api/till/${newTill.body.id}/close`,{token:owner,body:{counted_closing_cash:0,force_reason:'probe cleanup'}});

 console.log('\n--- E. THE ACCOUNTING TRAIL SURVIVES THE PERSON MOVING ---');
 const lagosSales=L((await req('GET','/api/sales?branch_id='+lagos.id,{token:owner})).body).filter(s=>s.id===sale.body.id);
 ok('the old branch still reports the sale',lagosSales.length===1,`n=${lagosSales.length}`);
 ok('...still naming the person who served it',lagosSales[0]&&!!lagosSales[0].served_by_name,String(lagosSales[0]&&lagosSales[0].served_by_name));
 const hist=await req('GET',`/api/users/${c1.id}/assignment-history`,{token:owner});
 ok('every move is on the permanent record',hist.status===200&&L(hist.body).length>=3,`n=${L(hist.body).length}`);
 ok('...each naming who authorised it and why',L(hist.body).every(h=>!!h.changed_by_name&&!!h.reason));
 await bal('after a full promote/demote/move cycle');

 console.log('\n--- F. OPEN WORK BLOCKS OR FOLLOWS THE RIGHT WAY ---');
 const c2=await hire('STAFF',lagos.id,'Holder');
 const till2=await openTill(c2.token,lagos.id,7000);
 const blocked=await xfer(c2.id,{branch_id:minna.id,reason:'move holding cash'},owner);
 ok('an open TILL blocks a branch move',blocked.status===409&&blocked.body.code==='OPEN_TILL_BLOCKS_TRANSFER',
    `status=${blocked.status} ${String(blocked.body&&blocked.body.code)}`);
 await req('POST',`/api/till/${till2.id}/close`,{token:owner,body:{counted_closing_cash:7000,force_reason:'settling before move'}});
 const ci=await req('POST','/api/attendance/clock-in',{token:c2.token,body:{branch_id:lagos.id}});
 const moved2=await xfer(c2.id,{branch_id:minna.id,reason:'moved mid-shift'},owner);
 ok('an open SHIFT does not block the move',moved2.status===200,`status=${moved2.status}`);
 ok('...it is closed at the OLD branch instead',moved2.body&&moved2.body.transfer&&moved2.body.transfer.shift_auto_closed===true,
    String(JSON.stringify(moved2.body&&moved2.body.transfer)).slice(0,110));
 const att=L((await req('GET','/api/attendance',{token:owner})).body).find(a=>a.id===(ci.body&&ci.body.id));
 ok('...keeping the shift recorded against the OLD branch',att&&att.branch_id===lagos.id,`branch=${att&&att.branch_id===lagos.id?'lagos':'MOVED'}`);
 ok('...and the hours are computed',att&&att.worked_minutes!==null&&att.worked_minutes!==undefined,`mins=${att&&att.worked_minutes}`);

 console.log('\n--- G. AN OPEN STOCKTAKE IS RECOVERABLE AFTER A MOVE ---');
 const c3=await hire('STAFF',lagos.id,'Counter');
 const stk=await req('POST','/api/stocktakes',{token:c3.token,body:{branch_id:lagos.id}});
 ok('they open a stocktake at Lagos',stk.status===201,`status=${stk.status}`);
 const mv3=await xfer(c3.id,{branch_id:minna.id,reason:'moved mid-count'},owner);
 ok('the move succeeds',mv3.status===200,`status=${mv3.status}`);
 const t3=await login(c3.username,'4321');
 const selfClose=await req('POST',`/api/stocktakes/${stk.body.id}/close`,{token:t3,body:{}});
 ok('they can no longer close it from the new branch (correct scoping)',selfClose.status===403,`status=${selfClose.status}`);
 // BUG 88: the move must SAY SO. An orphaned count blocks the old branch from
 // ever starting another one (idx_stocktake_one_open_per_branch), and the
 // person who left it can no longer see it from their new branch.
 ok('the transfer WARNS that work was left behind',!!(mv3.body&&mv3.body.work_left_behind),
    JSON.stringify(mv3.body&&mv3.body.transfer).slice(0,80));
 const wlb=mv3.body&&mv3.body.work_left_behind;
 if(wlb){
   ok('...counting the open stocktake',wlb.open_stocktakes===1,`n=${wlb.open_stocktakes}`);
   ok('...and explaining that the branch cannot count again until it is cleared',
      /cannot start another count/i.test(String(wlb.message)),String(wlb.message).slice(0,110));
 }
 const blockedCount=await req('POST','/api/stocktakes',{token:owner,body:{branch_id:lagos.id}});
 ok('...and the old branch really IS blocked',blockedCount.status===409,`status=${blockedCount.status}`);
 const rescue=await req('POST',`/api/stocktakes/${stk.body.id}/cancel`,{token:owner,body:{reason:'operator transferred away'}});
 ok('...but an owner CAN cancel it — no work is stranded',rescue.status===200,`status=${rescue.status}`);
 const freed=await req('POST','/api/stocktakes',{token:owner,body:{branch_id:lagos.id}});
 ok('...and the branch can count again once cleared',freed.status===201,`status=${freed.status}`);
 if(freed.status===201) await req('POST',`/api/stocktakes/${freed.body.id}/cancel`,{token:owner,body:{reason:'probe cleanup'}});
 // A clean move must not raise a false alarm.
 const c3b=await hire('STAFF',lagos.id,'CleanMove');
 const mvClean=await xfer(c3b.id,{branch_id:minna.id,reason:'nothing outstanding'},owner);
 ok('a CLEAN move raises no false warning',mvClean.status===200&&!mvClean.body.work_left_behind,
    `warned=${!!(mvClean.body&&mvClean.body.work_left_behind)}`);

 console.log('\n--- H. THE OWNER SEAT CANNOT BE EMPTIED BY ANY ROUTE ---');
 const ownerRow=L((await req('GET','/api/users',{token:owner})).body).find(u=>u.role==='OWNER');
 const byTransfer=await xfer(ownerRow.id,{role:'MANAGER',reason:'demote the only owner'},admin);
 ok('the last owner cannot be DEMOTED',byTransfer.status===400&&byTransfer.body.code==='LAST_OWNER_PROTECTED',
    `status=${byTransfer.status} ${String(byTransfer.body&&byTransfer.body.code)}`);
 const byDeact=await req('PUT',`/api/users/${ownerRow.id}`,{token:admin,body:{is_active:false}});
 ok('...nor DEACTIVATED',byDeact.status===400&&byDeact.body.code==='LAST_OWNER_PROTECTED',`status=${byDeact.status}`);
 const byDelete=await req('DELETE',`/api/users/${ownerRow.id}`,{token:admin});
 ok('...nor DELETED',byDelete.status===400,`status=${byDelete.status}`);
 const selfMove=await xfer(ownerRow.id,{role:'MANAGER',reason:'self demote'},owner);
 ok('...and an owner cannot transfer THEMSELVES',selfMove.status===403,`status=${selfMove.status}`);

 console.log('\n--- I. A MANAGER CANNOT ESCALATE VIA TRANSFER ---');
 const victim=await hire('STAFF',lagos.id,'Pawn');
 const toOwner=await xfer(victim.id,{role:'OWNER',reason:'escalate'},lmgr);
 ok('a Branch Manager cannot promote anyone to OWNER',toOwner.status===403,`status=${toOwner.status}`);
 const toOrgWide=await xfer(victim.id,{role:'MANAGER',branch_id:null,reason:'make org-wide'},lmgr);
 ok('...nor create an org-wide manager (escaping their own scope)',toOrgWide.status===403,`status=${toOrgWide.status}`);
 const gmToOwner=await xfer(victim.id,{role:'OWNER',reason:'escalate'},gm);
 ok('a General Manager cannot mint an OWNER either',gmToOwner.status===403,`status=${gmToOwner.status}`);
 const selfPromote=await req('POST',`/api/users/${(L((await req('GET','/api/users',{token:owner})).body).find(u=>u.username==='lagos.mgr')).id}/transfer`,
   {token:lmgr,body:{role:'MANAGER',branch_id:null,reason:'promote myself'}});
 ok('...and no one can transfer themselves',selfPromote.status===403,`status=${selfPromote.status}`);

 console.log('\n--- J. DEACTIVATION CASCADES CLEANLY ACROSS SUBSYSTEMS ---');
 const c4=await hire('STAFF',lagos.id,'Leaver');
 const ci4=await req('POST','/api/attendance/clock-in',{token:c4.token,body:{branch_id:lagos.id}});
 const deact=await req('PUT',`/api/users/${c4.id}`,{token:owner,body:{is_active:false}});
 ok('a clocked-in employee can be deactivated',deact.status===200,`status=${deact.status}`);
 const att4=L((await req('GET','/api/attendance',{token:owner})).body).find(a=>a.id===(ci4.body&&ci4.body.id));
 ok('...their open shift is auto-closed (Bug 74)',att4&&!!att4.clock_out_at,`out=${att4&&att4.clock_out_at}`);
 ok('...recorded as a manager intervention',att4&&!!att4.force_closed_by);
 const login4=await login(c4.username,'4321');
 ok('...and their login stops working immediately',!login4,`token=${login4?'ISSUED':'refused'}`);
 const plan=(await req('GET','/api/dashboard/plan',{token:owner})).body;
 const activeUsers=L((await req('GET','/api/users',{token:owner})).body).filter(u=>u.is_active&&u.role!=='ADMIN').length;
 ok('...and their paid seat is released',Number(plan.staff.used)===activeUsers,`plan=${plan.staff.used} active=${activeUsers}`);

 console.log('\n--- K. A CLOSED BRANCH AND ITS PEOPLE ---');
 const tmp=await req('POST','/api/branches',{token:owner,body:{name:'Temp Branch '+uniq(),address:'x',phone:'0803'}});
 ok('a temporary branch is created',tmp.status===201,`status=${tmp.status}`);
 const c5=await hire('STAFF',tmp.body.id,'Stranded');
 ok('...with a cashier assigned',!!c5);
 const closeTmp=await req('PUT',`/api/branches/${tmp.body.id}`,{token:owner,body:{is_active:false}});
 ok('the branch closes',closeTmp.status===200,`status=${closeTmp.status}`);
 const t5=await login(c5.username,'4321');
 ok('...their login still works (they are not fired)',!!t5,`token=${t5?'issued':'refused'}`);
 const sellClosed=await req('POST','/api/sales',{token:t5,body:{branch_id:tmp.body.id,
   items:[{product_id:batch.product_id,quantity:1,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:25}]}});
 ok('...but they cannot trade at the closed branch',sellClosed.status===403,`status=${sellClosed.status}`);
 const rescue5=await xfer(c5.id,{branch_id:lagos.id,reason:'branch closed, moved to Lagos'},owner);
 ok('...and they CAN be moved to a working branch',rescue5.status===200,`status=${rescue5.status} ${String(rescue5.body&&rescue5.body.error).slice(0,70)}`);
 const t5b=await login(c5.username,'4321');
 const sellNow=await req('POST','/api/till/open',{token:t5b,body:{branch_id:lagos.id,opening_cash:0}});
 ok('...where they can trade again',sellNow.status===201,`status=${sellNow.status}`);
 if(sellNow.status===201) await req('POST',`/api/till/${sellNow.body.id}/close`,{token:owner,body:{counted_closing_cash:0,force_reason:'cleanup'}});

 console.log('\n--- K2. AN ALL-CLOSED ESTATE MUST NOT LOCK THE OWNER OUT ---');
 // The worst-case estate state: a pharmacy closes every branch (winding down,
 // relocating everything at once, or simply a mistake). The owner must never be
 // locked out of their own system, and must be able to recover.
 {
   const all=L((await req('GET','/api/branches',{token:owner})).body);
   const wasActive=all.filter(b=>b.is_active);
   for(const b of wasActive) await req('PUT',`/api/branches/${b.id}`,{token:owner,body:{is_active:false}});
   const nowActive=L((await req('GET','/api/branches',{token:owner})).body).filter(b=>b.is_active);
   ok('every branch can be closed',nowActive.length===0,`still active=${nowActive.length}`);
   const stillIn=await login('owner');
   ok('...the OWNER can still sign in (never locked out)',!!stillIn,`token=${stillIn?'issued':'REFUSED'}`);
   // A successful owner re-login deliberately replaces the old device token.
   // Continue with the new session, otherwise this test would mistake the
   // single-session boundary for a branch-closure failure.
   if (stillIn) owner=stillIn;
   const planNow=(await req('GET','/api/dashboard/plan',{token:owner})).body;
   ok('...no branch slots are consumed',Number(planNow.branches.used)===0,`used=${planNow.branches.used}`);
   const revive=await req('PUT',`/api/branches/${all[0].id}`,{token:owner,body:{is_active:true}});
   ok('...a closed branch can be reopened',revive.status===200,`status=${revive.status}`);
   const fresh=await req('POST','/api/branches',{token:owner,body:{name:'Recovery '+uniq(),address:'x',phone:'0803'}});
   ok('...and a brand-new branch can be opened',fresh.status===201,`status=${fresh.status}`);
   // Restore the estate for the checks that follow.
   for(const b of wasActive) await req('PUT',`/api/branches/${b.id}`,{token:owner,body:{is_active:true}});
 }

 console.log('\n--- L. THE BOOKS ARE UNMOVED BY ALL OF IT ---');
 await bal('at the end of the cross-domain sweep');
 const tb=L((await req('GET','/api/gl/trial-balance',{token:owner})).body);
 ok('the trial balance still returns per-account rows',tb.length>0,`n=${tb.length}`);
 const bs=(await req('GET','/api/gl/balance-sheet',{token:owner})).body;
 ok('the balance sheet still balances',bs&&(bs.balances===true||Math.abs(Number(bs.total_assets||0)-(Number(bs.total_liabilities||0)+Number(bs.total_equity||0)))<0.005),
    JSON.stringify(bs&&{a:bs.total_assets,l:bs.total_liabilities,e:bs.total_equity}));

 console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
 if(notes.length){console.log('\nOBSERVATIONS:');notes.forEach(n=>console.log('  - '+n));}
 if(fails.length){console.log('\nFAILURES:');fails.forEach(f=>console.log('  - '+f));process.exit(1);}
})();
