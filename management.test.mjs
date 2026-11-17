import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.mjs';
import { SessionTokenManager } from './session.mjs';
import { verifyPassword } from './password.mjs';
import { DatabaseRequestError } from './supabase.mjs';

async function fixture(t) {
  const manager = new SessionTokenManager(); const issued = manager.issueSuperAdmin(1); const claims = manager.verify(issued.token);
  const state = {active:true,revoked:false,fail:false,calls:[],status:'active',adminActive:true};
  const db = async (table,query,options) => {
    state.calls.push({table,query:String(query),options});
    if(state.fail) throw new DatabaseRequestError({status:503,retryable:true});
    if(table==='cloud_accounts') return state.active ? [{id:1,username:'root',session_version:1}] : [];
    if(table==='cloud_admin_sessions') return state.revoked ? [] : [{session_id:claims.jti,credential_version:1,expires_at:new Date(issued.expiresAt).toISOString()}];
    if(table==='cloud_pharmacies') {const all=state.rows??[{shop_id:'CLOUD',name:'Cloud pharmacy',address:'Address',phone:'1',status:state.status,is_lifetime:true,archived_at:null,license_expiry_date:null,updated_at:'2026-11-17T00:00:00Z',cloud_accounts:[{username:'owner',active:state.adminActive,role:'admin'}]}];const params=new URLSearchParams(query);return all.slice(Number(params.get('offset')??0),Number(params.get('offset')??0)+Number(params.get('limit')??100));}
    if(table==='rpc/manage_cloud_shop') {const args=JSON.parse(options.body);state.lastArgs=args;return {shopId:args.p_shop_id,status:args.p_payload.status??state.status};}
    throw Error('Unexpected table');
  };
  const server=createApp({db,tokenManager:manager,logger:{error(){}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,body,token=issued.token)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {state,request};
}

test('cloud list and every management action require a live Super Admin session',async t=>{
  const {state,request}=await fixture(t);
  assert.equal((await request('/api/admin/shops',undefined,null)).status,401);
  for(const action of ['status','update','license','archive','restore','account','delete']) assert.equal((await request('/api/admin/shops/manage',{shopId:'CLOUD',action,payload:{}},null)).status,401);
  state.active=false;assert.equal((await request('/api/admin/shops')).status,403);
  state.active=true;state.revoked=true;assert.equal((await request('/api/admin/shops/manage',{shopId:'CLOUD',action:'archive',payload:{confirmationShopId:'CLOUD'}})).status,401);
  assert.equal(state.calls.some(c=>c.table==='rpc/manage_cloud_shop'),false);
});

test('cloud list returns authoritative status and selected account metadata without hashes',async t=>{
  const {state,request}=await fixture(t);const res=await request('/api/admin/shops');assert.equal(res.status,200);const data=await res.json();
  assert.deepEqual(data.shops[0],{shopId:'CLOUD',name:'Cloud pharmacy',address:'Address',phone:'1',status:'active',isLifetime:true,archived:false,updatedAt:'2026-11-17T00:00:00Z',username:'owner',adminActive:true,adminCount:1,licenseExpiryDate:null});
  const query=state.calls.find(c=>c.table==='cloud_pharmacies').query;assert.ok(query.includes('cloud_accounts!cloud_accounts_pharmacy_shop_fk(username,active,role)'));assert.equal(query.includes('password_hash'),false);
});

test('management binds authenticated actor, hashes passwords and ignores client password hashes',async t=>{
  const {state,request}=await fixture(t);
  let res=await request('/api/admin/shops/manage',{shopId:'CLOUD',action:'update',actorId:999,payload:{name:'New',address:'Address',phone:'0',username:'new-owner',password:'a-new-password-123',passwordHash:'attacker-hash'}});
  assert.equal(res.status,200);assert.equal(state.lastArgs.p_actor_id,1);assert.equal('password' in state.lastArgs.p_payload,false);assert.equal(await verifyPassword('a-new-password-123',state.lastArgs.p_payload.passwordHash),true);
  res=await request('/api/admin/shops/manage',{shopId:'CLOUD',action:'update',payload:{passwordHash:'attacker-hash'}});assert.equal(res.status,200);assert.equal('passwordHash' in state.lastArgs.p_payload,false);
  for(const active of [false,true]) {assert.equal((await request('/api/admin/shops/manage',{shopId:'CLOUD',action:'account',payload:{active}})).status,200);assert.equal(state.lastArgs.p_payload.active,active);}
});

test('invalid management inputs do not call RPC and database failures remain failures',async t=>{
  const {state,request}=await fixture(t);
  for(const [action,payload] of [['status',{}],['status',{status:'deleted'}],['account',{active:'false'}],['license',{isLifetime:false}],['update',{password:''}],['purge',{}]]) assert.equal((await request('/api/admin/shops/manage',{shopId:'CLOUD',action,payload})).status,400);
  assert.equal(state.calls.some(c=>c.table==='rpc/manage_cloud_shop'),false);
  state.fail=true;assert.equal((await request('/api/admin/shops')).status,503);
});

test('cloud list traverses explicit pages rather than silently truncating shops',async t=>{
 const {state,request}=await fixture(t);
 state.rows=Array.from({length:205},(_,n)=>({shop_id:`S${n}`,name:'Pharmacy',address:'Address',phone:'0',status:'active',is_lifetime:true,license_expiry_date:null,updated_at:'2026-11-17T00:00:00Z',cloud_accounts:[]}));
 const response=await request('/api/admin/shops');assert.equal(response.status,200);
 assert.equal((await response.json()).shops.length,205);
 assert.equal(state.calls.filter(c=>c.table==='cloud_pharmacies').length,3);
});

test('one-character Shop Admin passwords are accepted and deletion only archives',async t=>{
 const {state,request}=await fixture(t);
 const updated=await request('/api/admin/shops/manage',{shopId:'CLOUD',action:'update',payload:{password:'x'}});
 assert.equal(updated.status,200);assert.equal(await verifyPassword('x',state.lastArgs.p_payload.passwordHash),true);
 const deleted=await request('/api/admin/shops/manage',{shopId:'CLOUD',action:'delete',payload:{confirmationShopId:'CLOUD'}});
 assert.equal(deleted.status,200);assert.equal(state.lastArgs.p_action,'archive');assert.equal(state.lastArgs.p_shop_id,'CLOUD');
});
