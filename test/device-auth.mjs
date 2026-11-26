import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { realpath, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(root,'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const folder = await mkdtemp(join(await realpath(tmpdir()),'harbor-mcp-auth-fixture-'));
for (const command of ['open', 'xdg-open']) {
  await writeFile(join(folder, command), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
}

let polls=0;
let codes=0;
let origin;
const server=createServer((req,res)=>{
  if(req.url==='/api/auth/device/code') {
    codes++;
    res.end(JSON.stringify({deviceCode:'fixture-device-secret', userCode:'12345678', verificationUri:origin+'/skillharbor/authorize?user_code=12345678', expiresIn:60, interval:1}));
  } else if(req.url==='/api/auth/device/token') {
    if(++polls===1) return req.socket.destroy();
    res.end(JSON.stringify({accessToken:'fixture-account-secret',expiresAt:new Date(Date.now()+60_000).toISOString()}));
  } else if(req.url==='/api/me' && req.headers.authorization==='Bearer fixture-account-secret') {
    res.end(JSON.stringify({user:{name:'Fixture'}}));
  } else {
    res.writeHead(401,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'unauthorized'}}));
  }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
origin='http://127.0.0.1:'+server.address().port;
const client=new Client({name:'harbor-auth-fixture',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[join(root,'dist/mcp.js'),'--url',origin],env:{...process.env,PATH:folder+delimiter+process.env.PATH,SKILLHARBOR_CONFIG_DIR:folder}});
try {
  await client.connect(transport);
  const invoke=async name=>{
    const result=await client.callTool({name,arguments:{}});
    assert(!JSON.stringify(result).includes('fixture-device-secret'));
    assert(!JSON.stringify(result).includes('fixture-account-secret'));
    return {data:JSON.parse(result.content[0].text),error:result.isError};
  };
  const request=await invoke('connect_account');
  assert.equal(request.data.status,'pending');
  assert.equal(request.data.userCode,'12345678');
  const duplicate=await invoke('connect_account');
  assert.equal(codes,1);
  assert.equal(duplicate.data.userCode,request.data.userCode);
  await delay(request.data.pollAfterSeconds*1000+100);
  const retry=await invoke('connection_status');
  assert(!retry.error,JSON.stringify(retry));
  assert.equal(retry.data.status,'pending');
  assert.equal(retry.data.retrying,true);
  await delay(retry.data.pollAfterSeconds*1000+100);
  assert.equal((await invoke('connection_status')).data.status,'connected');
  assert.equal((await invoke('account_status')).data.user.name,'Fixture');
  console.log('PASS same device code survives network interruption and authorizes without exposing credentials');
} finally {
  await client.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  await rm(folder,{recursive:true,force:true});
}
