import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,stat,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerAgent,saveAgentCredential,validateOwner,apiUrl} from '../tools/agent-self-onboard.mjs';

test('rejects bad namespaces and unsafe API origins',()=>{
  assert.throws(()=>validateOwner('../evil'));
  assert.throws(()=>apiUrl('http://evil.example/api/forge','/v1/accounts'));
  assert.equal(apiUrl('https://kiln.pocketnova.app/api/forge','/v1/accounts/me'),'https://kiln.pocketnova.app/api/forge/v1/accounts/me');
});
test('sponsored agent creation requires verifying its own namespace',async()=>{
  const calls=[];
  const fetcher=async (url,opts)=>{
    calls.push({url,opts});
    if (url.endsWith('/agent-accounts')) return {ok:true,json:async()=>({account:{id:'acct_123',owner:'builder-agent'},token:'kiln_agt_abc123'})};
    return {ok:true,json:async()=>({account:{owner:'builder-agent'}})};
  };
  const result=await registerAgent({base:'https://kiln.pocketnova.app/api/forge',owner:'builder-agent',name:'Builder Agent',sponsorToken:'sponsor-secret',fetcher});
  assert.equal(result.verified,true);
  assert.equal(calls.length,2);
  assert.equal(calls[1].opts.headers.Authorization,'Bearer kiln_agt_abc123');
});
test('credential file is private and creation cannot overwrite it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kiln-onboard-'));
  try {
    const result={account:{id:'acct_123',owner:'builder-agent'},token:'kiln_agt_abc123',apiBase:'https://kiln.pocketnova.app/api/forge'};
    const path=await saveAgentCredential(result,{directory:dir});
    assert.equal((await stat(path)).mode&0o777,0o600);
    assert.equal(JSON.parse(await readFile(path,'utf8')).token,'kiln_agt_abc123');
    await assert.rejects(saveAgentCredential(result,{directory:dir}),{code:'EEXIST'});
  } finally {await rm(dir,{recursive:true,force:true});}
});
