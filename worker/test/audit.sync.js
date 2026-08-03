// OFFLINE / SYNC / CONFLICT RESOLUTION
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
const uniq=()=>Math.random().toString(36).slice(2,8);
const iso=(offsetMs=0)=>new Date(Date.now()+offsetMs).toISOString();

(async()=>{
 console.log('=== OFFLINE / SYNC / CONFLICT AUDIT ===');
 try{const h=await fetch(BASE+'/api/health');if(!h.ok)throw new Error('health '+h.status);}
 catch(e){console.log('server not reachable: '+e.message);process.exit(3);}
 const owner=await login('owner'), staff=await login('lagos.staff'), lmgr=await login('lagos.mgr'), mstaff=await login('minna.staff');
 const br=L((await req('GET','/api/branches',{token:owner})).body);
 const lagos=br.find(b=>/lagos/i.test(b.name)), minna=br.find(b=>/minna/i.test(b.name));
 const prods=L((await req('GET','/api/products',{token:owner})).body);
 const pmap=new Map(prods.map(p=>[p.id,p]));
 const batch=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body)
   .find(x=>x.quantity_remaining>50&&x.selling_price_per_unit>0&&pmap.get(x.product_id)&&pmap.get(x.product_id).dispensing_type!=='POM');
 const newCust=async(name,branch=lagos.id,tok=owner)=>(await req('POST','/api/customers',{token:tok,
   body:{branch_id:branch,name:name+' '+uniq(),phone:'0803'+uniq()}})).body;
 const push=(rows,tok=staff,branch=lagos.id,dev='dev-A',key)=>req('POST','/api/sync/push',{token:tok,idem:key||('k'+uniq()),
   body:{branch_id:branch,device_id:dev,app_version:'1.0.0',changes:{customers:rows}}});
 async function bal(l){const tb=L((await req('GET','/api/gl/trial-balance',{token:owner})).body);
  const dr=tb.reduce((a,x)=>a+ +(x.total_debits||0),0),cr=tb.reduce((a,x)=>a+ +(x.total_credits||0),0);
  ok('books balance '+l,Math.abs(dr-cr)<0.005,`dr=${dr.toFixed(2)} cr=${cr.toFixed(2)}`);}

 console.log('\n--- A. THE PUSH CONTRACT ---');
 const noBranch=await req('POST','/api/sync/push',{token:owner,idem:'nb'+uniq(),body:{device_id:'d',changes:{customers:[]}}});
 ok('a push with no branch is refused for an org-wide caller',noBranch.status===400,`status=${noBranch.status}`);
 const noChanges=await req('POST','/api/sync/push',{token:staff,idem:'nc'+uniq(),body:{branch_id:lagos.id,device_id:'d'}});
 ok('a push with no changes object is refused',noChanges.status===400,`status=${noChanges.status}`);
 const c1=await newCust('Push Target');
 const good=await push([{id:c1.id,name:'Edited Offline',phone:'0899',updated_at:iso(60000)}]);
 ok('a legitimate offline edit is accepted',good.status===200,`status=${good.status}`);
 ok('...and the summary reports what it did',good.body&&good.body.summary&&good.body.summary.customers
    &&good.body.summary.customers.updated===1,JSON.stringify(good.body&&good.body.summary));
 const applied=L((await req('GET','/api/customers',{token:owner})).body).find(x=>x.id===c1.id);
 ok('...and the change really landed',applied&&applied.name==='Edited Offline',`name=${applied&&applied.name}`);

 console.log('\n--- B. BUG 45: THE ALLOW-LIST STOPS FIELD SMUGGLING ---');
 await req('PUT',`/api/customers/${c1.id}`,{token:owner,body:{credit_limit:5000}});
 const attack=await push([{id:c1.id,name:'Smuggler',credit_limit:99999999,is_deleted:1,branch_id:minna.id,updated_at:iso(120000)}]);
 ok('the smuggling push is accepted for its ALLOWED fields',attack.status===200,`status=${attack.status}`);
 const after=L((await req('GET','/api/customers',{token:owner})).body).find(x=>x.id===c1.id);
 ok('...the allowed field (name) changed',after&&after.name==='Smuggler',`name=${after&&after.name}`);
 ok('...but credit_limit was IGNORED (no self-granted credit)',after&&Number(after.credit_limit)===5000,
    `credit_limit=${after&&after.credit_limit}`);
 ok('...is_deleted was IGNORED (a device cannot erase a debtor)',!!after);
 ok('...and branch_id was FORCE-SCOPED, not moved',after&&after.branch_id===lagos.id,`branch=${after&&after.branch_id}`);

 console.log('\n--- C. A DEVICE CANNOT PUSH INTO ANOTHER BRANCH ---');
 const mc=await newCust('Minna Person',minna.id);
 // BUG 87: force-scoping protected INSERTS but silently REPARENTED an existing
 // row — a Lagos device could overwrite a Minna customer and move them into
 // Lagos, taking a debtor away from the branch they owe.
 const cross=await push([{id:mc.id,name:'Reached Across',updated_at:iso(60000)}],staff,lagos.id,'dev-A');
 ok('a cross-branch push is accepted at the HTTP level',cross.status===200,`status=${cross.status}`);
 ok('...but the row is REFUSED, not applied',cross.body&&cross.body.summary&&cross.body.summary.customers
    &&cross.body.summary.customers.skipped_other_branch===1,JSON.stringify(cross.body&&cross.body.summary));
 const mcAfter=L((await req('GET','/api/customers',{token:owner})).body).find(x=>x.id===mc.id);
 ok('...the Minna row is NOT overwritten',mcAfter&&mcAfter.name!=='Reached Across',`name=${mcAfter&&mcAfter.name}`);
 ok('...and the customer is NOT moved into Lagos',mcAfter&&mcAfter.branch_id===minna.id,
    `branch=${mcAfter&&mcAfter.branch_id===minna.id?'minna':'MOVED'}`);
 const stolenView=L((await req('GET','/api/customers',{token:staff})).body).find(x=>x.id===mc.id);
 ok('...so a Lagos cashier still cannot see them',!stolenView);
 const claimOther=await push([{id:c1.id,name:'Claimed',updated_at:iso(180000)}],staff,minna.id,'dev-A');
 note(`a pinned Lagos cashier CLAIMING branch_id=minna -> ${claimOther.status} (resolveMutationBranchId forces Lagos)`);

 console.log('\n--- D. UNKNOWN TABLES ARE REFUSED (deny-by-default) ---');
 for(const t of ['users','sales','stock_batches','products','branches']){
   const r=await req('POST','/api/sync/push',{token:staff,idem:'t'+uniq(),
     body:{branch_id:lagos.id,device_id:'dev-A',changes:{[t]:[{id:'x',name:'y'}]}}});
   const summary=r.body&&r.body.summary&&r.body.summary[t];
   ok(`pushing to "${t}" applies nothing`,!summary||summary.updated===0&&summary.inserted===0,
      `status=${r.status} ${JSON.stringify(summary||'not processed')}`);
 }

 console.log('\n--- E. IDEMPOTENCY: A REPLAYED PUSH MUST NOT DOUBLE-APPLY ---');
 const c2=await newCust('Replay Target');
 // A genuine retry is the SAME key with the SAME body — that is what a device
 // does when the network drops after the server committed but before the
 // response arrived.
 const key='replay-'+uniq();
 const payload=[{id:c2.id,name:'First Write',updated_at:iso(60000)}];
 const first=await push(payload,staff,lagos.id,'dev-A',key);
 ok('the first push succeeds',first.status===200,`status=${first.status}`);
 const retry=await push(payload,staff,lagos.id,'dev-A',key);
 ok('an identical retry replays the ORIGINAL response, not a second write',retry.status===200,`status=${retry.status}`);
 // MY TEST WAS WRONG, NOT THE APP: reusing one key for a DIFFERENT body is key
 // ABUSE, not a retry, and 409 is the correct answer — silently applying the
 // second payload under the first key would be the actual bug.
 const abuse=await push([{id:c2.id,name:'SHOULD NOT APPLY',updated_at:iso(600000)}],staff,lagos.id,'dev-A',key);
 ok('reusing a key for a DIFFERENT payload is refused 409',abuse.status===409,`status=${abuse.status}`);
 const c2After=L((await req('GET','/api/customers',{token:owner})).body).find(x=>x.id===c2.id);
 ok('...and the different payload was NOT applied',c2After&&c2After.name==='First Write',`name=${c2After&&c2After.name}`);

 console.log('\n--- F. AN OFFLINE SALE REPLAYS EXACTLY ONCE ---');
 const tl=L((await req('GET','/api/till?branch_id='+lagos.id,{token:owner})).body);
 if(!tl.some(x=>x.status==='OPEN')) await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:0}});
 const saleKey='sale-'+uniq();
 const saleBody={branch_id:lagos.id,items:[{product_id:batch.product_id,quantity:2,unit_type:'BASE_UNIT'}],
   payments:[{method:'CASH',amount:Math.round(2*batch.selling_price_per_unit*100)/100}]};
 const s1=await req('POST','/api/sales',{token:staff,idem:saleKey,body:saleBody});
 ok('a queued offline sale is accepted',s1.status===201,`status=${s1.status} ${String(s1.body&&s1.body.error).slice(0,80)}`);
 const qtyAfter1=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.id===batch.id).quantity_remaining;
 const s2=await req('POST','/api/sales',{token:staff,idem:saleKey,body:saleBody});
 ok('replaying it with the same key does NOT create a second sale',s2.status===201||s2.status===200,`status=${s2.status}`);
 ok('...returning the SAME sale id',s2.body&&s1.body&&s2.body.id===s1.body.id,`${s1.body&&s1.body.id}=${s2.body&&s2.body.id}`);
 const qtyAfter2=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.id===batch.id).quantity_remaining;
 ok('...and stock was deducted only ONCE',qtyAfter1===qtyAfter2,`${qtyAfter1} -> ${qtyAfter2}`);
 const allSales=L((await req('GET','/api/sales?branch_id='+lagos.id,{token:owner})).body).filter(x=>x.id===s1.body.id);
 ok('...with exactly one sale row on record',allSales.length===1,`n=${allSales.length}`);
 await bal('after a replayed offline sale');

 console.log('\n--- G. A DIFFERENT KEY IS A DIFFERENT SALE ---');
 const s3=await req('POST','/api/sales',{token:staff,idem:'sale-'+uniq(),body:saleBody});
 ok('the same cart under a NEW key is a genuinely new sale',s3.status===201&&s3.body.id!==s1.body.id,
    `status=${s3.status} distinct=${s3.body&&s3.body.id!==s1.body.id}`);
 const qtyAfter3=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.id===batch.id).quantity_remaining;
 ok('...and it DID deduct stock again',qtyAfter3<qtyAfter2,`${qtyAfter2} -> ${qtyAfter3}`);

 console.log('\n--- H. LAST-WRITE-WINS AND THE CONFLICT LOG ---');
 const c3=await newCust('Conflict Target');
 await push([{id:c3.id,name:'Device A version',phone:'0111',updated_at:iso(300000),last_write_device_id:'dev-A'}],staff,lagos.id,'dev-A');
 await push([{id:c3.id,name:'Device B version',phone:'0222',updated_at:iso(600000),last_write_device_id:'dev-B'}],staff,lagos.id,'dev-B');
 const winner=L((await req('GET','/api/customers',{token:owner})).body).find(x=>x.id===c3.id);
 ok('the LATER timestamp wins',winner&&winner.name==='Device B version',`name=${winner&&winner.name}`);
 const stale=await push([{id:c3.id,name:'Stale Device A retry',phone:'0333',updated_at:iso(60000),last_write_device_id:'dev-A'}],staff,lagos.id,'dev-A');
 ok('a STALE push is accepted without error',stale.status===200,`status=${stale.status}`);
 const stillWinner=L((await req('GET','/api/customers',{token:owner})).body).find(x=>x.id===c3.id);
 ok('...but does NOT overwrite the newer version',stillWinner&&stillWinner.name==='Device B version',
    `name=${stillWinner&&stillWinner.name}`);
 const conflicts=await req('GET','/api/sync/conflicts',{token:owner});
 ok('the conflict log is readable by a manager',conflicts.status===200,`status=${conflicts.status}`);
 const logged=L(conflicts.body).filter(x=>x.row_id===c3.id);
 ok('...and the discarded version was RECORDED, not silently lost',logged.length>0,`n=${logged.length}`);
 if(logged.length){
   const cf=logged[0];
   ok('...with both the losing and winning versions kept',!!cf.losing_version&&!!cf.winning_version,
      JSON.stringify({lose:cf.losing_version&&cf.losing_version.name,win:cf.winning_version&&cf.winning_version.name}));
   ok('...so a human can retype what was lost',/Stale Device A retry|Device A version/.test(JSON.stringify(cf.losing_version)),
      JSON.stringify(cf.losing_version).slice(0,90));
   const rev=await req('POST',`/api/sync/conflicts/${cf.id}/review`,{token:owner,body:{}});
   ok('a manager can mark a conflict reviewed',rev.status===200,`status=${rev.status}`);
   const again=L((await req('GET','/api/sync/conflicts',{token:owner})).body).filter(x=>x.id===cf.id);
   ok('...and it leaves the unreviewed queue',again.length===0,`still listed=${again.length}`);
 }
 const cfStaff=await req('GET','/api/sync/conflicts',{token:staff});
 ok('a cashier cannot read the conflict log',cfStaff.status===403,`status=${cfStaff.status}`);

 console.log('\n--- I. OVERSIZED PUSHES ARE REFUSED, NOT TRUNCATED ---');
 const many=[];for(let i=0;i<150;i++)many.push({id:'bulk-'+uniq(),name:'Bulk '+i,updated_at:iso(60000)});
 const big=await push(many);
 ok('a push above the row cap is refused with 413',big.status===413&&big.body.code==='PUSH_BATCH_TOO_LARGE',
    `status=${big.status} ${String(big.body&&big.body.code)}`);
 ok('...rather than silently truncating',/at most|too large|batch/i.test(String(big.body&&big.body.error)),
    String(big.body&&big.body.error).slice(0,90));

 console.log('\n--- J. HEARTBEAT AND SYNC HEALTH ---');
 const hb=await req('POST','/api/sync/heartbeat',{token:staff,body:{branch_id:lagos.id,device_id:'dev-A',app_version:'1.0.0',pending_push_count:7}});
 ok('a device can report its health',hb.status===200,`status=${hb.status}`);
 ok('...and the pending backlog is recorded',hb.body&&Number(hb.body.pending_push_count)===7,
    `pending=${hb.body&&hb.body.pending_push_count}`);
 const ov=await req('GET','/api/sync/overview',{token:owner});
 ok('a manager sees the fleet overview',ov.status===200&&L(ov.body).length>0,`n=${L(ov.body).length}`);
 const ovStaff=await req('GET','/api/sync/overview',{token:staff});
 ok('a cashier cannot read the fleet overview',ovStaff.status===403,`status=${ovStaff.status}`);
 const row=L(ov.body).find(x=>x.branch_id===lagos.id);
 ok('...showing connectivity per branch',row&&!!row.connectivity_status,`status=${row&&row.connectivity_status}`);

 console.log('\n--- K. A SALE REJECTED BY THE SERVER MUST NOT VANISH ---');
 // An offline sale for stock that no longer exists must fail CLEANLY so the
 // client can quarantine it for review, not disappear.
 const gone=await req('POST','/api/sales',{token:staff,idem:'gone-'+uniq(),
   body:{branch_id:lagos.id,items:[{product_id:batch.product_id,quantity:999999,unit_type:'BASE_UNIT'}],
         payments:[{method:'CASH',amount:1}]}});
 ok('an unfulfillable queued sale is rejected cleanly (4xx, not 500)',gone.status>=400&&gone.status<500,
    `status=${gone.status}`);
 ok('...with a message a cashier could act on',!!(gone.body&&gone.body.error),String(gone.body&&gone.body.error).slice(0,90));
 await bal('at the end of the sync sweep');

 console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
 if(notes.length){console.log('\nOBSERVATIONS:');notes.forEach(n=>console.log('  - '+n));}
 if(fails.length){console.log('\nFAILURES:');fails.forEach(f=>console.log('  - '+f));process.exit(1);}
})();
