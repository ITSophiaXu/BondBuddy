#!/usr/bin/env bash
# Proves the worker container's egress policy from inside the container:
#  1. direct TCP to the internet fails (internal network, no gateway);
#  2. via the proxy, a host outside the allow-list is refused (403);
#  3. via the proxy, the allow-listed provider host gets a CONNECT tunnel (200). The tunnel is
#     closed immediately; no TLS handshake or model request is sent.
source "$(dirname "$0")/lib.sh"
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
compose exec -T worker node --input-type=module -e '
import net from "node:net";
const tryConnect=(host,port)=>new Promise(r=>{const s=net.connect({host,port,timeout:4000});s.on("connect",()=>{s.destroy();r("connected")});s.on("timeout",()=>{s.destroy();r("timeout")});s.on("error",e=>r(e.code||"error"));});
const viaProxy=(host)=>new Promise(r=>{const s=net.connect(3128,"egress",()=>s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));let b="";s.setTimeout(8000,()=>{s.destroy();r("timeout")});s.on("data",d=>{b+=d;if(b.includes("\r\n")){s.destroy();r(b.split("\r\n")[0])}});s.on("error",e=>r(e.code||"error"));});
const results={
  direct_1_1_1_1_443: await tryConnect("1.1.1.1",443),
  direct_example_com_443: await tryConnect("example.com",443),
  proxy_example_com: await viaProxy("example.com"),
  proxy_github_com: await viaProxy("github.com"),
  proxy_allowlisted_api_deepseek_com: await viaProxy("api.deepseek.com"),
};
console.log(JSON.stringify(results,null,1));
const ok=results.direct_1_1_1_1_443!=="connected" && results.direct_example_com_443!=="connected"
  && /\s403\s/.test(results.proxy_example_com) && /\s403\s/.test(results.proxy_github_com)
  && /\s200\s/.test(results.proxy_allowlisted_api_deepseek_com);
console.log(ok?"EGRESS POLICY OK":"EGRESS POLICY FAILED"); process.exit(ok?0:1);'
