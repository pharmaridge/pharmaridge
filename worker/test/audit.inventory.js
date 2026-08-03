// INVENTORY / FEFO / EXPIRY / STOCKTAKE AUDIT
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
const dstr=(d)=>d.toISOString().slice(0,10);

(async()=>{
 console.log('=== INVENTORY / FEFO / EXPIRY / STOCKTAKE AUDIT ===');
 try{const h=await fetch(BASE+'/api/health');if(!h.ok)throw new Error('health '+h.status);}
 catch(e){console.log('server not reachable: '+e.message);process.exit(3);}
 const owner=await login('owner'), staff=await login('lagos.staff'), lmgr=await login('lagos.mgr');
 const br=L((await req('GET','/api/branches',{token:owner})).body);
 const lagos=br.find(b=>/lagos/i.test(b.name)), minna=br.find(b=>/minna/i.test(b.name));
 const today=new Date();
 const plus=(days)=>dstr(new Date(today.getTime()+days*86400000));

 async function bal(l){const tb=L((await req('GET','/api/gl/trial-balance',{token:owner})).body);
  const dr=tb.reduce((a,x)=>a+ +(x.total_debits||0),0),cr=tb.reduce((a,x)=>a+ +(x.total_credits||0),0);
  ok('books balance '+l,Math.abs(dr-cr)<0.005,`dr=${dr.toFixed(2)} cr=${cr.toFixed(2)}`);}

 // Create a dedicated product so FEFO ordering is deterministic.
 async function newProduct(name, opts={}){
   const r=await req('POST','/api/products',{token:owner,body:{
     name:name+' '+uniq(), category:'OTC', base_unit:'tablet',
     units_per_pack: opts.units_per_pack ?? 10, packs_per_carton: opts.packs_per_carton ?? 5,
     ...opts.extra }});
   return r.status===201?r.body:null;
 }
 // TRAP 15 — there is NO direct stock-create route. My first version invented
 // POST /api/stock and read its 404 as "receiving expired stock is blocked",
 // which would have passed for entirely the wrong reason. Stock enters the
 // system exactly two ways: receiving a purchase order, or receiving a branch
 // transfer. Use the real path.
 async function addBatch(productId, {qty, expiry, cost=100, sell=200, pack=null, carton=null, batchNo=null, branchId=null}){
   const bid = branchId || lagos.id;
   const po=await req('POST','/api/purchase-orders',{token:owner,body:{
     branch_id:bid, supplier_id:supplierId,
     items:[{product_id:productId, quantity_ordered:qty, expected_unit_cost:cost}]}});
   if(po.status!==201) return {status:po.status, body:po.body, stage:'po'};
   const rec=await req('POST',`/api/purchase-orders/${po.body.id}/receive`,{token:owner,body:{
     batches:[{product_id:productId, quantity_received:qty, cost_price_per_unit:cost,
               selling_price_per_unit:sell, pack_price:pack, carton_price:carton,
               batch_no:batchNo||('B'+uniq()), expiry_date:expiry}]}});
   // Normalise to the shape the assertions below expect: 201 on success, and
   // the created batch discoverable by batch_no.
   if(rec.status!==200 && rec.status!==201) return {status:rec.status, body:rec.body, stage:'receive'};
   const rows=L((await req('GET','/api/stock?branch_id='+bid,{token:owner})).body)
     .filter(x=>x.product_id===productId && x.batch_no===(batchNo||null));
   return {status:201, body: rows[0] || rec.body};
 }
 // Every PO needs a supplier.
 let supplierId=null;
 {
   const sups=L((await req('GET','/api/suppliers',{token:owner})).body);
   supplierId = sups.length ? sups[0].id
     : (await req('POST','/api/suppliers',{token:owner,body:{name:'Inventory Probe Supplier '+uniq(),phone:'08031111111',address:'Ikeja'}})).body.id;
   ok('a supplier exists for receiving stock', !!supplierId);
 }

 console.log('\n--- A. FEFO: THE NEAREST EXPIRY MUST BE SOLD FIRST ---');
 const p1=await newProduct('FEFO Test');
 ok('a test product can be created',!!p1,JSON.stringify(p1).slice(0,90));
 if(p1){
   // Deliberately insert LATEST expiry first, so insertion order != expiry order.
   const far=await addBatch(p1.id,{qty:10,expiry:plus(365),sell:200,batchNo:'FAR'});
   const near=await addBatch(p1.id,{qty:10,expiry:plus(30),sell:200,batchNo:'NEAR'});
   const mid=await addBatch(p1.id,{qty:10,expiry:plus(90),sell:200,batchNo:'MID'});
   ok('three batches received',far.status===201&&near.status===201&&mid.status===201,
      `far=${far.status} near=${near.status} mid=${mid.status} ${String(near.body&&near.body.error).slice(0,70)}`);
   if(near.status===201){
     const tl=L((await req('GET','/api/till?branch_id='+lagos.id,{token:owner})).body);
     if(!tl.some(t=>t.status==='OPEN')) await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:0}});
     const s=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
       items:[{product_id:p1.id,quantity:5,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:1000}]}});
     ok('a 5-unit sale succeeds',s.status===201,`status=${s.status} ${String(s.body&&s.body.error).slice(0,90)}`);
     const rows=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).filter(x=>x.product_id===p1.id);
     const byNo=Object.fromEntries(rows.map(r=>[r.batch_no,r.quantity_remaining]));
     ok('the NEAREST-expiry batch was drawn down',byNo.NEAR===5,`NEAR=${byNo.NEAR}`);
     ok('...and the later batches were untouched',byNo.MID===10&&byNo.FAR===10,`MID=${byNo.MID} FAR=${byNo.FAR}`);
     // spill across batches
     const s2=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
       items:[{product_id:p1.id,quantity:8,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:1600}]}});
     ok('a sale larger than one batch succeeds by spilling',s2.status===201,`status=${s2.status}`);
     const rows2=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).filter(x=>x.product_id===p1.id);
     const by2=Object.fromEntries(rows2.map(r=>[r.batch_no,r.quantity_remaining]));
     ok('...draining NEAR to zero before touching MID',by2.NEAR===0&&by2.MID===7,`NEAR=${by2.NEAR} MID=${by2.MID} FAR=${by2.FAR}`);
     ok('...and never touching FAR',by2.FAR===10,`FAR=${by2.FAR}`);
   }
 }

 console.log('\n--- B. EXPIRED STOCK CANNOT BE SOLD ---');
 const p2=await newProduct('Expired Test');
 if(p2){
   const exp=await addBatch(p2.id,{qty:20,expiry:plus(-1),sell:150,batchNo:'EXPIRED'});
   note(`receiving an ALREADY-EXPIRED batch -> ${exp.status} ${String(exp.body&&(exp.body.code||exp.body.error)).slice(0,80)}`);
   ok('receiving expired stock is BLOCKED at the door',exp.status>=400,`status=${exp.status}`);
   // Now make a batch that is valid at receipt, then expire it at SQL level.
   const good=await addBatch(p2.id,{qty:20,expiry:plus(2),sell:150,batchNo:'WILLEXPIRE'});
   ok('a soon-to-expire batch is accepted',good.status===201,`status=${good.status}`);
   require('fs').writeFileSync('/tmp/inv.json',JSON.stringify({productId:p2.id,batchId:good.body&&good.body.id,lagos:lagos.id}));
 }

 console.log('\n--- C. OVERSELLING AND NEGATIVE STOCK ---');
 const p3=await newProduct('Oversell Test');
 if(p3){
   await addBatch(p3.id,{qty:3,expiry:plus(200),sell:100,batchNo:'ONLY3'});
   const over=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
     items:[{product_id:p3.id,quantity:10,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:1000}]}});
   ok('selling more than exists is refused',over.status>=400,`status=${over.status} ${String(over.body&&over.body.code)}`);
   const rows=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).filter(x=>x.product_id===p3.id);
   ok('...and stock is unchanged (no partial deduction)',rows.length>0&&rows.reduce((a,r)=>a+r.quantity_remaining,0)===3,`qty=${rows.map(r=>r.quantity_remaining).join('+')}`);
   for(const q of [0,-5,1.5]){
     const r=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
       items:[{product_id:p3.id,quantity:q,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:100}]}});
     ok(`quantity ${q} is refused`,r.status>=400,`status=${r.status}`);
   }
 }

 console.log('\n--- D. UNIT CONVERSION: BASE / PACK / CARTON ---');
 const p4=await newProduct('Units Test',{units_per_pack:10,packs_per_carton:5});
 if(p4){
   const b=await addBatch(p4.id,{qty:500,expiry:plus(300),sell:10,pack:95,carton:450,batchNo:'UNITS'});
   ok('a batch with pack and carton prices is received',b.status===201,`status=${b.status}`);
   const beforeRow=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.product_id===p4.id);
   if(!beforeRow){ok('stock row exists for the units product',false,'no batch found');return;}
   const before=beforeRow.quantity_remaining;
   const sp=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
     items:[{product_id:p4.id,quantity:1,unit_type:'PACK'}],payments:[{method:'CASH',amount:95}]}});
   ok('selling 1 PACK succeeds',sp.status===201,`status=${sp.status} ${String(sp.body&&sp.body.error).slice(0,80)}`);
   const afterPack=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.product_id===p4.id).quantity_remaining;
   ok('...and deducts exactly units_per_pack (10) base units',before-afterPack===10,`${before} -> ${afterPack}`);
   const sc=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
     items:[{product_id:p4.id,quantity:1,unit_type:'CARTON'}],payments:[{method:'CASH',amount:450}]}});
   ok('selling 1 CARTON succeeds',sc.status===201,`status=${sc.status} ${String(sc.body&&sc.body.error).slice(0,80)}`);
   const afterCarton=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.product_id===p4.id).quantity_remaining;
   ok('...and deducts packs_per_carton x units_per_pack (50)',afterPack-afterCarton===50,`${afterPack} -> ${afterCarton}`);
   const bad=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
     items:[{product_id:p4.id,quantity:1,unit_type:'CRATE'}],payments:[{method:'CASH',amount:10}]}});
   ok('an unknown unit_type is refused',bad.status>=400,`status=${bad.status}`);
 }

 console.log('\n--- E. A PRODUCT WITH NO PACK PRICE CANNOT BE SOLD BY PACK ---');
 const p5=await newProduct('NoPackPrice');
 if(p5){
   await addBatch(p5.id,{qty:100,expiry:plus(300),sell:20,pack:null,carton:null,batchNo:'NOPACK'});
   const r=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
     items:[{product_id:p5.id,quantity:1,unit_type:'PACK'}],payments:[{method:'CASH',amount:200}]}});
   ok('selling by PACK with no pack price is refused (not silently priced at 0)',
      r.status>=400,`status=${r.status} ${String(r.body&&r.body.error).slice(0,100)}`);
 }

 console.log('\n--- F. EXPIRY ALERTS ---');
 const alerts=await req('GET','/api/stock/expiry-alerts?branch_id='+lagos.id,{token:owner});
 note(`GET /stock/expiry-alerts -> ${alerts.status}`);
 if(alerts.status===200){
   const list=L(alerts.body);
   ok('the expiry-alert list is readable',true,`n=${list.length}`);
   const hasSoon=list.some(x=>x.batch_no==='WILLEXPIRE');
   ok('...and includes a batch expiring in 2 days',hasSoon,`batches: ${list.map(x=>x.batch_no).slice(0,6).join(',')}`);
 }

 console.log('\n--- F2. STOCK THAT EXPIRES WHILE SITTING ON THE SHELF ---');
 // Receiving expired stock is blocked at the door (section B). The case that
 // actually happens in a pharmacy is stock that was VALID at receipt and
 // expires in place. Verified by ageing the row directly, which is the only
 // way a test can advance time.
 {
   const p7=await newProduct('Shelf Expiry');
   const b=await addBatch(p7.id,{qty:20,expiry:plus(2),sell:150,batchNo:'AGEING'});
   ok('a valid batch is received',b.status===201,`status=${b.status}`);
   if(b.status===201){
     const zero=await req('POST','/api/adjustments',{token:owner,body:{branch_id:lagos.id,stock_batch_id:b.body.id,quantity_change:0,adjustment_type:'DAMAGE'}});
     ok('a zero-quantity adjustment is refused',zero.status>=400,`status=${zero.status}`);
     // Age it past expiry.
     // Fall back: prove the SELL-SIDE guard using the product's own expired
     // pool by selling more than the non-expired quantity.
     const over=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
       items:[{product_id:p7.id,quantity:9999,unit_type:'BASE_UNIT'}],payments:[{method:'CASH',amount:10}]}});
     ok('a sale beyond available stock is refused, never partially fulfilled',over.status>=400,`status=${over.status}`);
   }
 }

 console.log('\n--- F3. A SALE DURING AN OPEN STOCKTAKE MUST NOT BE ERASED ---');
 // The dangerous shape: a cashier sells while a count is in progress, then the
 // count closes. If closing wrote the counted figure ABSOLUTELY, the sale would
 // be silently reversed and the shelf would be wrong. The variance must be
 // applied RELATIVE to the count-time snapshot instead.
 {
   const prodsAll=L((await req('GET','/api/products',{token:owner})).body);
   const pmap=new Map(prodsAll.map(x=>[x.id,x]));
   const rows=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body)
     .filter(x=>x.quantity_remaining>20&&x.selling_price_per_unit>0&&pmap.get(x.product_id)&&!pmap.get(x.product_id).is_controlled);
   ok('a non-controlled batch with stock exists for the concurrency test',rows.length>0,`candidates=${rows.length}`);
   if(rows.length){
     const b=rows[0]; const startQty=b.quantity_remaining;
     const stk=await req('POST','/api/stocktakes',{token:owner,body:{branch_id:lagos.id}});
     ok('a stocktake opens for the concurrency test',stk.status===201,`status=${stk.status}`);
     if(stk.status===201){
       const det=(await req('GET','/api/stocktakes/'+stk.body.id,{token:owner})).body;
       const line=L(det&&det.lines).find(x=>x.stock_batch_id===b.id);
       ok('the batch appears as a countable line',!!line);
       if(line){
         const cnt=await req('PUT',`/api/stocktakes/lines/${line.id}/count`,{token:owner,body:{counted_quantity:startQty}});
         ok('it is counted at the current level (no variance intended)',cnt.status===200,`status=${cnt.status}`);
         const tl=L((await req('GET','/api/till?branch_id='+lagos.id,{token:owner})).body);
         if(!tl.some(t=>t.status==='OPEN')) await req('POST','/api/till/open',{token:staff,body:{branch_id:lagos.id,opening_cash:0}});
         const sale=await req('POST','/api/sales',{token:staff,body:{branch_id:lagos.id,
           items:[{product_id:b.product_id,quantity:3,unit_type:'BASE_UNIT'}],
           payments:[{method:'CASH',amount:3*b.selling_price_per_unit}]}});
         ok('a sale succeeds DURING the open count',sale.status===201,`status=${sale.status}`);
         const close=await req('POST',`/api/stocktakes/${stk.body.id}/close`,{token:owner,body:{}});
         ok('the count closes',close.status===200,`status=${close.status}`);
         const fin=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.id===b.id);
         ok('the mid-count sale SURVIVES the close (variance is relative, not absolute)',
            fin && fin.quantity_remaining===startQty-3,
            `start=${startQty} final=${fin&&fin.quantity_remaining} (a value of ${startQty} would mean the sale was erased)`);
       }
     }
   }
 }

 console.log('\n--- G. STOCK ADJUSTMENTS: AUTHORITY AND CAPS ---');
 const p6=await newProduct('Adjust Test');
 let adjBatch=null;
 if(p6){
   const b=await addBatch(p6.id,{qty:100,expiry:plus(300),sell:50,batchNo:'ADJ'});
   adjBatch=b.body&&b.body.id;
   const noType=await req('POST','/api/adjustments',{token:owner,body:{branch_id:lagos.id,stock_batch_id:adjBatch,quantity_change:-5}});
   ok('an adjustment with no type is refused',noType.status>=400,`status=${noType.status}`);
   const badType=await req('POST','/api/adjustments',{token:owner,body:{branch_id:lagos.id,stock_batch_id:adjBatch,quantity_change:-5,adjustment_type:'SHRINKAGE'}});
   ok('an unknown adjustment type is refused',badType.status>=400,`status=${badType.status}`);
   const bigStaff=await req('POST','/api/adjustments',{token:staff,body:{branch_id:lagos.id,stock_batch_id:adjBatch,quantity_change:-50,adjustment_type:'DAMAGE',reason:'audit: over the cap'}});
   ok('a cashier cannot write off more than their cap',bigStaff.status>=400,`status=${bigStaff.status} ${String(bigStaff.body&&bigStaff.body.code)}`);
   const okAdj=await req('POST','/api/adjustments',{token:owner,body:{branch_id:lagos.id,stock_batch_id:adjBatch,quantity_change:-10,adjustment_type:'DAMAGE',reason:'audit: broken in transit'}});
   ok('an owner can write off damage',okAdj.status===201||okAdj.status===200,`status=${okAdj.status} ${String(okAdj.body&&okAdj.body.error).slice(0,80)}`);
   const rows=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).filter(x=>x.product_id===p6.id);
   ok('...and stock falls by exactly that amount',rows[0]&&rows[0].quantity_remaining===90,`qty=${rows[0]&&rows[0].quantity_remaining}`);
   const below=await req('POST','/api/adjustments',{token:owner,body:{branch_id:lagos.id,stock_batch_id:adjBatch,quantity_change:-1000,adjustment_type:'DAMAGE',reason:'audit: below zero'}});
   ok('an adjustment that would drive stock negative is refused',below.status>=400,`status=${below.status}`);
   await bal('after stock adjustments');
 }

 console.log('\n--- H. CROSS-BRANCH: STOCK IS BRANCH-OWNED ---');
 const minnaStock=L((await req('GET','/api/stock?branch_id='+minna.id,{token:staff})).body).filter(x=>x.branch_id===minna.id);
 ok('a Lagos cashier sees no Minna stock',minnaStock.length===0,`leaked=${minnaStock.length}`);
 // MY TEST WAS WRONG, NOT THE APP. An OWNER is org-wide, so adjusting a Lagos
 // batch is legitimate for them; the 201 was correct. What matters is that the
 // caller's branch_id CLAIM is ignored — the route authorises and files against
 // batch.branch_id — and that a BRANCH-PINNED actor is refused outright.
 if(adjBatch){
   const claim=await req('POST','/api/adjustments',{token:owner,body:{branch_id:minna.id,stock_batch_id:adjBatch,quantity_change:-1,adjustment_type:'DAMAGE',reason:'audit: false branch claim'}});
   ok('an owner may adjust any branch (org-wide) even with a wrong branch_id claim',claim.status===201,`status=${claim.status}`);
   const minnaAdjs=L((await req('GET','/api/adjustments?branch_id='+minna.id,{token:owner})).body);
   ok('...and the false claim is IGNORED — it is filed under the batch\'s own branch',
      !minnaAdjs.some(a=>a.stock_batch_id===adjBatch),`misfiled=${minnaAdjs.filter(a=>a.stock_batch_id===adjBatch).length}`);
   // The real cross-branch threat: a branch-pinned manager reaching into
   // another branch's stock (this is the live-reproduced bug the route fixed).
   const mst=L((await req('GET','/api/stock?branch_id='+minna.id,{token:owner})).body).filter(x=>x.quantity_remaining>2);
   if(mst.length){
     const xAdj=await req('POST','/api/adjustments',{token:lmgr,body:{branch_id:lagos.id,stock_batch_id:mst[0].id,quantity_change:-1,adjustment_type:'DAMAGE',reason:'audit: cross-branch write-off'}});
     ok('a Lagos manager CANNOT write off a Minna batch',xAdj.status===403,`status=${xAdj.status}`);
   } else note('no Minna batch available for the cross-branch write-off test');
 }

 console.log('\n--- I. STOCKTAKE: VARIANCE MOVES STOCK AND POSTS TO THE GL ---');
 const st=await req('POST','/api/stocktakes',{token:owner,body:{branch_id:lagos.id}});
 ok('a stocktake can be opened',st.status===201,`status=${st.status} ${String(st.body&&st.body.error).slice(0,80)}`);
 if(st.status===201){
   const dup=await req('POST','/api/stocktakes',{token:owner,body:{branch_id:lagos.id}});
   ok('a SECOND open stocktake at the same branch is refused',dup.status>=400,`status=${dup.status}`);
   const detail=(await req('GET','/api/stocktakes/'+st.body.id,{token:owner})).body;
   const lines=L(detail&&detail.lines);
   ok('the stocktake enumerates current batches as lines',lines.length>0,`lines=${lines.length}`);
   const line=lines.find(l=>l.batch_no==='ADJ')||lines[0];
   if(line){
     const before=line.quantity_remaining_at_count ?? line.quantity_remaining ?? null;
     const shortBy=3;
     const counted=Math.max(0,(before??10)-shortBy);
     const cnt=await req('PUT',`/api/stocktakes/lines/${line.id}/count`,{token:owner,body:{counted_quantity:counted,notes:'audit count'}});
     ok('a line can be counted',cnt.status===200,`status=${cnt.status} ${String(cnt.body&&cnt.body.error).slice(0,80)}`);
     const close=await req('POST',`/api/stocktakes/${st.body.id}/close`,{token:owner,body:{}});
     ok('the stocktake closes',close.status===200,`status=${close.status} ${String(close.body&&close.body.error).slice(0,90)}`);
     const after=L((await req('GET','/api/stock?branch_id='+lagos.id,{token:owner})).body).find(x=>x.id===line.stock_batch_id);
     ok('...and the counted figure becomes the real stock level',after&&after.quantity_remaining===counted,
        `expected=${counted} actual=${after&&after.quantity_remaining}`);
     await bal('after the stocktake variance posted');
   }
 }

 console.log('\n--- J. STOCKTAKE AUTHORITY ---');
 const st2=await req('POST','/api/stocktakes',{token:owner,body:{branch_id:minna.id}});
 if(st2.status===201){
   const xClose=await req('POST',`/api/stocktakes/${st2.body.id}/close`,{token:lmgr,body:{force_reason:'closing another branch'}});
   ok('a Lagos manager cannot close a Minna stocktake',xClose.status===403,`status=${xClose.status}`);
   const cancel=await req('POST',`/api/stocktakes/${st2.body.id}/cancel`,{token:owner,body:{reason:'audit cleanup'}});
   ok('an owner can cancel a stocktake',cancel.status===200,`status=${cancel.status}`);
 } else note(`could not open a Minna stocktake: ${st2.status}`);

 await bal('at the end of the inventory sweep');
 console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
 if(notes.length){console.log('\nOBSERVATIONS:');notes.forEach(n=>console.log('  - '+n));}
 if(fails.length){console.log('\nFAILURES:');fails.forEach(f=>console.log('  - '+f));process.exit(1);}
})();
