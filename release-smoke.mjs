// Release-only verification. Inert unless explicitly enabled for this release.
if (process.env.PHARMACY_RUN_RELEASE_CHECK !== '1') process.exit(0);
const {createHmac}=await import('node:crypto');
const base='https://qodra-pharmacy-api.onrender.com';
if(process.env.SUPABASE_URL?.replace(/\/$/,'')!=='https://viaptmtfxfizysejrliy.supabase.co')throw Error('Release check refused: unexpected Supabase project');
const releaseId=process.env.PHARMACY_RELEASE_CHECK_ID;
if(!/^[A-Za-z0-9-]{8,40}$/.test(releaseId??''))throw Error('Release check ID missing');
const passed=[];const record=(name)=>passed.push(name);
const shops=[`RELEASE-${releaseId}-A`,`RELEASE-${releaseId}-B`];
const password=(id,suffix='')=>createHmac('sha256',process.env.SESSION_SECRET).update(`pharmacy-release-test:${id}:${suffix}`).digest('base64url');
let token;const created=[];
async function call(path,{body,auth=token,key}={}){
 const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${auth}`} : {}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
 let data={};try{data=await res.json();}catch{}return {status:res.status,data};
}
function expect(response,status,label){if(response.status!==status)throw Error(`${label}: expected ${status}, received ${response.status}`);return response.data;}
const adminLogin=()=>call('/api/login',{auth:null,body:{username:process.env.SUPER_ADMIN_USERNAME,password:process.env.SUPER_ADMIN_PASSWORD,shopId:''}});
const shopLogin=(id,username='release-owner',pass=password(id))=>call('/api/login',{auth:null,body:{shopId:id,username,password:pass}});
const manage=(id,action,payload)=>call('/api/admin/shops/manage',{body:{shopId:id,action,payload}});
try{
 const version=expect(await call('/version',{auth:null}),200,'public version');if(version.version!=='4')throw Error('Unexpected API version');
 expect(await call('/ready',{auth:null}),200,'public readiness');record('public_routes');
 const login=expect(await adminLogin(),200,'existing Super Admin login');if(login.role!=='superAdmin'||!login.accessToken)throw Error('Unexpected Super Admin session');token=login.accessToken;record('existing_super_admin_login');
 const second=expect(await adminLogin(),200,'second Super Admin login').accessToken;
 expect(await call('/api/logout',{auth:second,body:{}}),200,'second session logout');expect(await call('/api/admin/shops',{auth:second}),401,'revoked session');expect(await call('/api/admin/shops'),200,'independent session remains valid');record('individual_session_revocation');
 const before=expect(await call('/api/admin/shops'),200,'cloud list').shops;
 for(const id of shops){if(before.some(s=>s.shopId===id&&s.name!=='Pharmacy release verification (test only)'))throw Error('Test Shop ID belongs to a non-test record; stopped');}
 const bodies=shops.map(id=>({shopId:id,name:'Pharmacy release verification (test only)',address:'Designated release verification; no customer data',phone:'',username:'release-owner',password:password(id),isLifetime:true,licenseExpiryDate:null}));
 for(let i=0;i<shops.length;i++){
  expect(await call('/api/admin/shops',{body:bodies[i],key:`pharmacy-${releaseId}-${i}`}),201,'atomic shop provisioning');created.push(shops[i]);
  const listed=expect(await call('/api/admin/shops'),200,'created shop list').shops.find(s=>s.shopId===shops[i]);
  if(listed?.archived)expect(await manage(shops[i],'restore',{confirmationShopId:shops[i]}),200,'restore previous test attempt');
  expect(await manage(shops[i],'account',{active:true}),200,'test admin activity');
 }
 record('atomic_shop_admin_provisioning');
 const retries=await Promise.all(Array.from({length:3},()=>call('/api/admin/shops',{body:bodies[0],key:`pharmacy-${releaseId}-0`})));
 retries.forEach(r=>expect(r,201,'idempotent concurrent replay'));record('idempotent_concurrent_retries');
 const accounts=await fetch(process.env.SUPABASE_URL+'/rest/v1/cloud_accounts?select=id,shop_id,role,active&shop_id=eq.'+encodeURIComponent(shops[0]),{headers:{apikey:process.env.SUPABASE_SECRET_KEY},signal:AbortSignal.timeout(30000)});
 if(!accounts.ok)throw Error('Supabase account verification failed');const accountRows=await accounts.json();if(accountRows.length!==1||accountRows[0].role!=='admin')throw Error('Unexpected Shop Admin association');record('supabase_account_association');
 expect(await shopLogin(shops[0]),200,'Shop Admin first client');expect(await shopLogin(shops[0]),200,'Shop Admin independent client');record('shop_admin_independent_clients');
 expect(await shopLogin(shops[0],'release-owner','incorrect-release-password'),401,'wrong password');expect(await shopLogin(shops[1],'release-owner',password(shops[0])),401,'cross-shop password');expect(await shopLogin('WRONG-'+shops[0]),401,'incorrect Shop ID');record('credential_and_shop_isolation');
 expect(await manage(shops[0],'status',{status:'suspended'}),200,'suspension');expect(await shopLogin(shops[0]),403,'suspended login');expect(await manage(shops[0],'status',{status:'active'}),200,'reactivation');expect(await shopLogin(shops[0]),200,'reactivated login');record('suspension_reactivation');
 expect(await manage(shops[0],'account',{active:false}),200,'disable account');expect(await shopLogin(shops[0]),401,'disabled account login');expect(await manage(shops[0],'account',{active:true}),200,'enable account');record('shop_admin_activity');
 expect(await manage(shops[0],'update',{name:bodies[0].name,address:bodies[0].address,phone:'',username:'release-updated',password:password(shops[0],'updated')}),200,'Shop Admin credentials update');expect(await shopLogin(shops[0]),401,'old credentials rejected');expect(await shopLogin(shops[0],'release-updated',password(shops[0],'updated')),200,'updated credentials login');
 expect(await manage(shops[0],'update',{name:bodies[0].name,address:bodies[0].address,phone:'',username:'release-owner',password:password(shops[0])}),200,'restore test credentials');record('shop_admin_credentials');
 const expired=await fetch(process.env.SUPABASE_URL+'/rest/v1/cloud_pharmacies?shop_id=eq.'+encodeURIComponent(shops[0]),{method:'PATCH',headers:{apikey:process.env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify({is_lifetime:false,license_expiry_date:'2000-01-01T00:00:00Z'}),signal:AbortSignal.timeout(30000)});if(!expired.ok)throw Error('Designated test license setup failed');
 expect(await shopLogin(shops[0]),403,'expired license login');expect(await manage(shops[0],'license',{isLifetime:true,licenseExpiryDate:null}),200,'license renewal');expect(await shopLogin(shops[0]),200,'renewed license login');record('expiry_and_renewal');
 expect(await manage(shops[0],'archive',{confirmationShopId:shops[0]}),200,'archive');expect(await shopLogin(shops[0]),403,'archived login');expect(await manage(shops[0],'restore',{confirmationShopId:shops[0]}),200,'restore');record('safe_archive_restore');
 for(const id of created)expect(await manage(id,'archive',{confirmationShopId:id}),200,'test cleanup archive');
 expect(await call('/api/logout',{body:{}}),200,'primary session logout');expect(await call('/api/admin/shops'),401,'primary revoked session');record('logout_and_cleanup');
 console.log('PHARMACY_RELEASE_CHECK_RESULT '+JSON.stringify({success:true,releaseId,apiBuild:version.build,passed,testShops:shops,cleanup:'archived; no hard deletion; no existing customer/financial records changed'}));
}catch(error){
 if(token)for(const id of created){try{await manage(id,'archive',{confirmationShopId:id});}catch{}}
 console.error('PHARMACY_RELEASE_CHECK_FAILED '+String(error.message).slice(0,180));process.exitCode=1;
}
