const URL='http://127.0.0.1:18099/v1/chat/completions';
const filler=(tok)=>'The quarterly report covers revenue, churn and hiring in detail. '.repeat(Math.ceil(tok/12));
async function call(tok, label){
  const t0=Date.now();
  const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:filler(tok)+'\nSummarise in one line.'}],max_tokens:64,temperature:0.1,chat_template_kwargs:{enable_thinking:false}})});
  const body=await r.text();
  return `${label}: HTTP ${r.status} ${Date.now()-t0}ms ${r.ok?'ok':body.slice(0,300)}`;
}
const mode=process.argv[2];
if (mode==='overflow') console.log(await call(20000,'single 20k request'));
if (mode==='concurrent') {
  const res=await Promise.all([call(3500,'bg1 3.5k'),call(3500,'bg2 3.5k'),call(3500,'bg3 3.5k'),call(8000,'agent 8k')]);
  console.log(res.join('\n'));
}
