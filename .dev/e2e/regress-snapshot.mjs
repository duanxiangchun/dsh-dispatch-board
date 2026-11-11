const base = process.argv[2] || 'http://127.0.0.1:3099';
async function call(method, payload={}) {
  const id = 'e2e-' + Math.random().toString(36).slice(2);
  const r = await fetch(base + '/taskboard/' + method, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({type:'client-request', rpcId:id, method, payload}) });
  const j = await r.json();
  return j.result;
}
const s = await call('snapshot');
const v = s.value;
console.log(JSON.stringify({ poll: v.poll, agents: v.agents, presetInstalled: v.preset && v.preset.installed, taskCount: v.tasks.length, pluginVersion: v.pluginVersion }, null, 1));
