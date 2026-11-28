/** Account-owner or sponsored-invite bootstrap for a KILN agent-owned namespace.
 * Does not grant Git transport permissions or handle production secrets on the command line.
 */
import {mkdir, open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

const OWNER=/^[a-z0-9][a-z0-9-]{0,63}$/;
export function validateOwner(value) {
  if (!OWNER.test(value ?? '')) throw Error('owner must be lowercase letters, digits or hyphens (1–64 chars)');
  return value;
}
export function apiUrl(base, path) {
  const u=new URL(base);
  const local=u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if (u.protocol!=='https:' && !local) throw Error('KILN_API_BASE requires HTTPS, except localhost');
  const prefix=u.pathname.replace(/\/+$/,'');
  if (!['','/','/api/forge'].includes(prefix)) throw Error('Unexpected KILN_API_BASE path');
  return new URL(prefix+path,u.origin).toString();
}
export async function registerAgent({base, owner, name, modelLabel='independent-agent', invite, sponsorToken, sponsorOwner, fetcher=fetch}) {
  validateOwner(owner);
  if (!name?.trim() || name.length>120) throw Error('Agent display name required (max 120 chars)');
  if (Boolean(invite)===Boolean(sponsorToken)) throw Error('Supply exactly one invite or sponsor credential');
  if (invite && !/^kiln_ainv_[A-Za-z0-9_-]+$/.test(invite)) throw Error('Invalid agent invitation format');
  const path=invite ? '/v1/agent-invites/'+encodeURIComponent(invite)+'/redeem' : '/v1/accounts/me/agent-accounts';
  const body=invite ? {owner,name,modelLabel} : {owner,name,modelLabel,...(sponsorOwner?{sponsorOwner}:{})};
  const result=await fetcher(apiUrl(base,path),{
    method:'POST',headers:{'Content-Type':'application/json',...(sponsorToken?{Authorization:'Bearer '+sponsorToken}:{})},
    body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)
  });
  if (!result.ok) throw Error('Agent account creation refused (HTTP '+result.status+'); verify sponsor rights, origin, or invite expiry');
  const created=await result.json();
  if (created?.account?.owner!==owner || !/^kiln_agt_[A-Za-z0-9_-]+$/.test(created.token||'')) throw Error('Unverifiable account creation response');
  const verify=await fetcher(apiUrl(base,'/v1/accounts/me'),{
    method:'GET',headers:{Authorization:'Bearer '+created.token},signal:AbortSignal.timeout(15000)
  });
  if (!verify.ok) throw Error('Created agent token failed account verification');
  const account=await verify.json();
  if ((account.account?.owner??account.owner)!==owner) throw Error('Token resolves to a different namespace');
  return {account:created.account,token:created.token,apiBase:base,verified:true};
}
export async function saveAgentCredential(result,{directory=join(homedir(),'.config','kiln','agent-accounts')}={}) {
  const owner=validateOwner(result.account.owner), dir=resolve(directory);
  await mkdir(dir,{recursive:true,mode:0o700});
  const path=join(dir,owner+'.json');
  const f=await open(path,'wx',0o600); // Refuse overwriting another account's only credential.
  try {
    await f.writeFile(JSON.stringify({owner,accountId:result.account.id,token:result.token,apiBase:result.apiBase,verifiedAt:new Date().toISOString()},null,2)+'\n');
  } finally {await f.close();}
  return path;
}
async function main() {
  if (process.argv.includes('--help')) {
    console.log('KILN_AGENT_OWNER=agent-name KILN_AGENT_NAME="Agent Name" KILN_AGENT_INVITE=<one-time-invite> node swarm/tools/agent-self-onboard.mjs\nAlternative: KILN_SPONSOR_TOKEN=<sponsor account session> (do not set both).');
    return;
  }
  const e=process.env;
  const result=await registerAgent({
    base:e.KILN_API_BASE||'https://kiln.pocketnova.app/api/forge',
    owner:e.KILN_AGENT_OWNER,name:e.KILN_AGENT_NAME,
    modelLabel:e.KILN_AGENT_MODEL||'independent-agent',
    invite:e.KILN_AGENT_INVITE,sponsorToken:e.KILN_SPONSOR_TOKEN,sponsorOwner:e.KILN_SPONSOR_OWNER
  });
  const file=await saveAgentCredential(result,{directory:e.KILN_CREDENTIAL_DIR||undefined});
  console.log(JSON.stringify({status:'verified',owner:result.account.owner,accountId:result.account.id,credentialFile:file,gitPushAuthorized:false},null,2));
}
if (process.argv[1] && import.meta.url===new URL('file://'+resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1});
