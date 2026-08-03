// ATTENDANCE & PAYROLL-EVIDENCE AUDIT
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
 console.log('=== ATTENDANCE / PAYROLL AUDIT ===');
 try{const h=await fetch(BASE+'/api/health');if(!h.ok)throw new Error('health '+h.status);}
 catch(e){console.log('server not reachable: '+e.message);process.exit(3);}
 const owner=await login('owner'), mgr=await login('manager'), lmgr=await login('lagos.mgr');
 const br=L((await req('GET','/api/branches',{token:owner})).body);
 const lagos=br.find(b=>/lagos/i.test(b.name)), minna=br.find(b=>/minna/i.test(b.name));

 console.log('\n--- A. GEOFENCE CLASSIFICATION AT THE EDGES ---');
 note(`Lagos geofence: lat=${lagos.latitude} lng=${lagos.longitude} radius=${lagos.geofence_radius_meters}m mode=${lagos.attendance_mode}`);
 // Make a disposable cashier per case so the one-open-shift index never collides.
 async function hire(branchId){
   const u='att-'+uniq();
   const r=await req('POST','/api/users',{token:owner,body:{full_name:'Att '+u,username:u,pin:'4321',role:'STAFF',branch_id:branchId}});
   if(r.status!==201) return null;
   return {id:r.body.id, username:u, token:await login(u,'4321')};
 }
 const hasGeo = lagos.latitude!=null && lagos.longitude!=null;
 if(hasGeo){
   const cases=[
     ['exactly at the branch',            lagos.latitude, lagos.longitude, 'ON_SITE'],
     ['far away (another city)',          9.05, 7.49, 'OFF_SITE'],
     ['no location supplied',             null, null, 'NO_LOCATION'],
   ];
   for(const [label,lat,lng,expect] of cases){
     const w=await hire(lagos.id); if(!w){note('could not hire for '+label);continue;}
     const body={branch_id:lagos.id};
     if(lat!=null) body.location={lat,lng,accuracy:5};
     const r=await req('POST','/api/attendance/clock-in',{token:w.token,body});
     ok(`clock-in ${label} -> ${expect}`, r.status===201 && r.body.clock_in_status===expect,
        `status=${r.status} got=${r.body&&r.body.clock_in_status}`);
     if(r.status===201&&lat!=null&&expect!=='NO_LOCATION'){
       note(`  distance recorded: ${r.body.clock_in_distance_meters}m`);
     }
   }
 } else note('Lagos has no geofence set — edge cases not exercised');

 console.log('\n--- B. A FLAGGED SHIFT IS RECORDED, NEVER SILENTLY BLOCKED ---');
 const wf=await hire(lagos.id);
 const flagged=await req('POST','/api/attendance/clock-in',{token:wf.token,body:{branch_id:lagos.id,location:{lat:9.05,lng:7.49,accuracy:5}}});
 ok('an off-site clock-in still SUCCEEDS (recorded + flagged, not refused)', flagged.status===201,
    `status=${flagged.status} ${String(flagged.body&&flagged.body.error).slice(0,80)}`);
 ok('...and is marked OFF_SITE for review', flagged.body&&flagged.body.clock_in_status==='OFF_SITE',
    String(flagged.body&&flagged.body.clock_in_status));
 const fl=L((await req('GET',`/api/attendance?branch_id=${lagos.id}&flagged_only=true`,{token:owner})).body);
 ok('...and appears in the flagged review queue', fl.some(a=>a.id===flagged.body.id), `queue=${fl.length}`);

 console.log('\n--- C. DOUBLE CLOCK-IN AND DOUBLE CLOCK-OUT ---');
 const dbl=await req('POST','/api/attendance/clock-in',{token:wf.token,body:{branch_id:lagos.id}});
 ok('a second clock-in while already on shift is refused', dbl.status>=400 && dbl.body.code==='ALREADY_CLOCKED_IN',
    `status=${dbl.status} ${String(dbl.body&&dbl.body.code)}`);
 const out1=await req('POST',`/api/attendance/${flagged.body.id}/clock-out`,{token:wf.token,body:{}});
 ok('clock-out succeeds', out1.status===200, `status=${out1.status}`);
 const out2=await req('POST',`/api/attendance/${flagged.body.id}/clock-out`,{token:wf.token,body:{}});
 ok('a second clock-out on the same shift is refused', out2.status>=400, `status=${out2.status}`);

 console.log('\n--- D. YOU CANNOT CLOCK ANYONE ELSE IN OR OUT ---');
 const a=await hire(lagos.id), b2=await hire(lagos.id);
 const aShift=await req('POST','/api/attendance/clock-in',{token:a.token,body:{branch_id:lagos.id}});
 const steal=await req('POST',`/api/attendance/${aShift.body.id}/clock-out`,{token:b2.token,body:{}});
 ok('a colleague cannot clock someone else out', steal.status===403, `status=${steal.status}`);
 const mgrOut=await req('POST',`/api/attendance/${aShift.body.id}/clock-out`,{token:owner,body:{}});
 ok('...and neither can the owner via the normal clock-out', mgrOut.status===403, `status=${mgrOut.status}`);
 const forced=await req('POST',`/api/attendance/${aShift.body.id}/force-clock-out`,{token:owner,body:{reason:'audit: end shift on their behalf'}});
 ok('...but force-clock-out is the sanctioned path and works', forced.status===200, `status=${forced.status}`);

 console.log('\n--- E. CROSS-BRANCH: CAN SOMEONE CLOCK IN SOMEWHERE THEY DO NOT WORK? ---');
 const lagosWorker=await hire(lagos.id);
 const wrong=await req('POST','/api/attendance/clock-in',{token:lagosWorker.token,body:{branch_id:minna.id}});
 note(`Lagos cashier clocking in AT MINNA -> ${wrong.status} ${String(wrong.body&&(wrong.body.code||wrong.body.branch_id&&'recorded at '+wrong.body.branch_id)).slice(0,60)}`);
 ok('a cashier cannot log a shift at a branch they are not assigned to',
    wrong.status>=400 || (wrong.status===201 && wrong.body.branch_id===lagos.id),
    `status=${wrong.status} branch=${wrong.body&&wrong.body.branch_id} (lagos=${lagos.id})`);

 console.log('\n--- F. MANAGER OVERRIDE: AUTHORITY AND SCOPE ---');
 const w2=await hire(lagos.id);
 const s2=await req('POST','/api/attendance/clock-in',{token:w2.token,body:{branch_id:lagos.id}});
 const noReason=await req('POST',`/api/attendance/${s2.body.id}/override`,{token:owner,body:{}});
 ok('an override with no reason is refused', noReason.status>=400, `status=${noReason.status}`);
 const byStaff=await req('POST',`/api/attendance/${s2.body.id}/override`,{token:w2.token,body:{reason:'approving my own shift'}});
 ok('a cashier cannot approve any flagged shift', byStaff.status===403, `status=${byStaff.status}`);
 const good=await req('POST',`/api/attendance/${s2.body.id}/override`,{token:owner,body:{reason:'confirmed on duty via CCTV'}});
 ok('an owner can approve a flagged shift with a reason', good.status===200, `status=${good.status}`);
 ok('...and the approver is named on the record', !!(good.body&&good.body.manager_override_by), String(good.body&&good.body.manager_override_by).slice(0,10));
 const twice=await req('POST',`/api/attendance/${s2.body.id}/override`,{token:owner,body:{reason:'second look, still fine'}});
 ok('a second override APPENDS rather than erasing the first',
    twice.status===200 && /CCTV/.test(String(twice.body&&twice.body.manager_override_reason)),
    String(twice.body&&twice.body.manager_override_reason).slice(0,80));

 console.log('\n--- G. BRANCH MANAGER IS FENCED TO THEIR OWN BRANCH ---');
 const mw=await hire(minna.id);
 const ms=await req('POST','/api/attendance/clock-in',{token:mw.token,body:{branch_id:minna.id}});
 const xOver=await req('POST',`/api/attendance/${ms.body.id}/override`,{token:lmgr,body:{reason:'signing off another branch'}});
 ok('a Lagos manager cannot sign off a Minna shift', xOver.status===403, `status=${xOver.status}`);
 const xForce=await req('POST',`/api/attendance/${ms.body.id}/force-clock-out`,{token:lmgr,body:{reason:'ending another branch shift'}});
 ok('...nor force-clock-out a Minna shift', xForce.status===403, `status=${xForce.status}`);
 const seen=L((await req('GET','/api/attendance',{token:lmgr})).body);
 ok('...nor even SEE Minna attendance rows', seen.every(r=>r.branch_id===lagos.id), `foreign rows=${seen.filter(r=>r.branch_id!==lagos.id).length}`);

 console.log('\n--- H. DEVICE REGISTRY (REGISTERED_DEVICE MODE) ---');
 const devs=await req('GET',`/api/attendance/devices?branch_id=${lagos.id}`,{token:owner});
 ok('the device registry is readable by a manager', devs.status===200, `status=${devs.status}`);
 const someStaff=await hire(lagos.id);
 const devStaff=await req('GET',`/api/attendance/devices?branch_id=${lagos.id}`,{token:someStaff.token});
 ok('a cashier cannot read the device registry', devStaff.status===403, `status=${devStaff.status}`);
 const reg=await req('POST','/api/attendance/devices',{token:owner,body:{branch_id:lagos.id,device_id:'AUDIT-DEV-'+uniq(),label:'Counter tablet'}});
 ok('a manager can register a device', reg.status===201, `status=${reg.status} ${String(reg.body&&reg.body.error).slice(0,70)}`);
 const xReg=await req('POST','/api/attendance/devices',{token:lmgr,body:{branch_id:minna.id,device_id:'FOREIGN-'+uniq(),label:'planted'}});
 const planted=xReg.status===201 && xReg.body && xReg.body.branch_id===minna.id;
 ok('a Lagos manager cannot plant a device into Minna', !planted, `status=${xReg.status} branch=${xReg.body&&xReg.body.branch_id}`);
 if(reg.status===201){
   const rv=await req('POST',`/api/attendance/devices/${reg.body.id}/revoke`,{token:owner,body:{branch_id:lagos.id}});
   ok('...and revoke it again', rv.status===200, `status=${rv.status}`);
 }

 console.log('\n--- I. PAYROLL RECONSTRUCTION: WHAT CAN AN OWNER ACTUALLY PROVE? ---');
 const all=L((await req('GET','/api/attendance',{token:owner})).body);
 ok('attendance rows carry the worker name', all.every(r=>!!r.user_full_name));
 ok('...the branch', all.every(r=>!!r.branch_name));
 ok('...a clock-in time', all.every(r=>!!r.clock_in_at));
 const closed=all.filter(r=>r.clock_out_at);
 ok('...and closed shifts carry a clock-out time', closed.length>0, `closed=${closed.length}/${all.length}`);
 const forcedRows=all.filter(r=>r.force_closed_by);
 ok('a manager-ended shift is distinguishable from a self-ended one', forcedRows.length>0 && forcedRows.every(r=>!!r.force_closed_reason),
    `forced=${forcedRows.length}`);
 // Can hours be computed? Look for negative or absurd durations.
 const bad=closed.filter(r=>new Date(r.clock_out_at.replace(' ','T')+'Z') < new Date(r.clock_in_at.replace(' ','T')+'Z'));
 ok('no shift ends before it starts (no negative hours)', bad.length===0, `negative=${bad.length}`);
 note(`total attendance rows visible to the owner: ${all.length}`);

 console.log('\n--- J. BUG 78: HOURS WORKED ARE ACTUALLY COMPUTED ---');
 // The module is payroll evidence, yet nothing anywhere turned two timestamps
 // into a duration: 28 fields per row and not one of them a length of time.
 // An owner had to subtract raw UTC strings by hand, per shift, per person.
 {
   const w=await hire(lagos.id);
   const ci=await req('POST','/api/attendance/clock-in',{token:w.token,body:{branch_id:lagos.id}});
   let rows=L((await req('GET','/api/attendance',{token:owner})).body);
   let mine=rows.find(r=>r.id===ci.body.id);
   ok('the API exposes worked_minutes', mine && 'worked_minutes' in mine);
   ok('an OPEN shift reports null, not zero (a running shift has no length yet)',
      mine && mine.worked_minutes===null, String(mine&&mine.worked_minutes));
   // Close it against a known span. The clock-in is "now", so a future
   // clock-out is (correctly) refused — assert that guard, then close normally.
   const future=new Date(Date.now()+3*3600*1000).toISOString().slice(0,19).replace('T',' ');
   const refused=await req('POST',`/api/attendance/${ci.body.id}/force-clock-out`,{token:owner,body:{reason:'audit: future end',clock_out_at:future}});
   ok('a future clock-out is still refused (no manufactured hours)',
      refused.status===400 && refused.body.code==='INVALID_CLOCK_OUT_TIME', `status=${refused.status}`);
   const closed=await req('POST',`/api/attendance/${ci.body.id}/force-clock-out`,{token:owner,body:{reason:'audit: close for duration check'}});
   ok('the shift closes', closed.status===200, `status=${closed.status}`);
   rows=L((await req('GET','/api/attendance',{token:owner})).body);
   mine=rows.find(r=>r.id===ci.body.id);
   ok('a CLOSED shift reports a numeric duration', typeof mine.worked_minutes==='number', String(mine.worked_minutes));
   ok('...that is never negative', mine.worked_minutes>=0, String(mine.worked_minutes));
   ok('...and the manager who ended it is named', mine.force_closed_by_name==='Grace Okonkwo',
      String(mine.force_closed_by_name));
   // The duration must be computed server-side from UTC, so it cannot vary
   // with the viewer's timezone.
   const expected=Math.round((new Date(mine.clock_out_at.replace(' ','T')+'Z') - new Date(mine.clock_in_at.replace(' ','T')+'Z'))/60000);
   ok('...and matches the timestamps exactly', Math.abs(mine.worked_minutes-expected)<=1,
      `api=${mine.worked_minutes} derived=${expected}`);
 }

 console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
 if(notes.length){console.log('\nOBSERVATIONS:');notes.forEach(n=>console.log('  - '+n));}
 if(fails.length){console.log('\nFAILURES:');fails.forEach(f=>console.log('  - '+f));process.exit(1);}
})();
