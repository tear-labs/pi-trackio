import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { collectModal } from "../src/compute/modal.ts";
import { collectGcp } from "../src/compute/gcp.ts";
import { collectSfcompute } from "../src/compute/sfcompute.ts";
import { collectVast } from "../src/compute/vast.ts";
import { matchProject, suggestProject, linkJobs } from "../src/compute/links.ts";
import { job, report } from "../src/compute/config.ts";
import { __resetComputeCache, collectComputeSnapshot, countSilentJobs, computeSummaryMarkdown } from "../src/compute/snapshot.ts";
import { computePage } from "../src/compute/page.ts";
import { createTrackioRouteHandler } from "../src/web-proxy.ts";
import type { Runner, ComputeSnapshot } from "../src/compute/types.ts";
const now = Date.parse("2026-10-23T00:00:00Z");
const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });
const noRunner: Runner = async () => { throw new Error("Unexpected subprocess"); };
const containers = [1,2,3,4].map(i => ({ container_id: `ta-01M5${i}`, app_id: `ap-${i}`, app_name: `simplexflow-v${i}`, start_time: "2026-10-22 20:31:54+00:00" }));
const apps = Array.from({length:80}, (_, n) => ({ app_id: `ap-${n+1}`, description: `simplexflow-v${n+1}`, state: "ephemeral (detached)", tasks: n < 4 ? "1" : "0", created_at: "2026-10-22 19:46:47+00:00", stopped_at: null }));
test("Modal groups active apps, ignores inactive apps and does not invent GPUs", async () => {
  const runner: Runner = async (_cmd, args) => ok(args[0] === "container" ? containers : apps);
  const r = await collectModal({}, runner, now);
  assert.equal(r.state, "ok"); assert.equal(r.jobs.length, 4);
  for (const j of r.jobs) { assert.equal(j.status, "running"); assert.equal(j.replicas, 1); assert.equal(j.accelerator, null); assert.ok(j.uptimeSeconds! > 0); }
});
test("literal links beat normalized collisions and last versions must agree", () => {
  assert.deepEqual(matchProject("model-ab",["model-a-b","model-ab"]),{project:"model-ab",score:1});
  assert.equal(matchProject("model_ab",["model-a-b","model-ab"]),null);
  assert.equal(matchProject("simplex-v2-backbone-v3-train",["simplex-v2-backbone-v4-train"]),null);
  assert.equal(matchProject("train-simplexflow-v2-ckpt",["train-simplexflow-v3-ckpt"]),null);
  assert.equal(suggestProject("v11-sglang-lfm-perf",["SimplexV2-v11_sglang_lfm_serving"])!.score,0.5);
});
test("Modal terminal app metadata wins and tasks-only allocations are honestly labelled", async () => {
  for(const app of [{...apps[0],stopped_at:"2026-10-22T20:00:00Z"},... ["terminated","failed","cancelled"].map(state=>({...apps[0],state}))]) {
    const r=await collectModal({},async(_cmd,args)=>ok(args[0]==="container"?[containers[0]]:[app]),now);
    assert.equal(r.jobs.length,0);
  }
  const r=await collectModal({},async(_cmd,args)=>ok(args[0]==="container"?[]:[apps[0]]),now);
  assert.equal(r.jobs[0].status,"running"); assert.match(r.jobs[0].detail!,/task/); assert.doesNotMatch(r.jobs[0].detail!,/container/);
  const live=await collectModal({},async(_cmd,args)=>ok(args[0]==="container"?[containers[0]]:[{...apps[0],tasks:"0"}]),now);
  assert.equal(live.jobs[0].status,"running"); assert.match(live.jobs[0].detail!,/container/);
});
test("partial Modal failure survives markdown formatting", async () => {
  const p=await collectModal({},async(_cmd,args)=>args[0]==="container"?ok([]):{code:1,stdout:"",stderr:"auth failed"},now);
  assert.equal(p.state,"ok");
  const s:ComputeSnapshot={checkedAt:new Date(now).toISOString(),refreshSeconds:20,stale:false,providers:[p],logging:[],totals:{running:0,silent:0,jobs:0,providers:3,providersOk:1}};
  assert.match(computeSummaryMarkdown(s),/0 running — Partial/);
});
test("GCP authentication 403 differs from permission 403 and retains successful VMs", async () => {
  for(const [stderr,state] of [
    ["ERROR: (gcloud.compute.instances.list) HTTPError 403: Request had invalid authentication credentials. Expected OAuth 2 access token.","auth_required"],
    ["HTTPError 403: Required compute.instances.list permission","error"],
  ]) {
    const r=await collectGcp({gcp:{projects:["A","B"]}},async(_cmd,args)=>args.includes("A")?ok([{name:"A-vm",status:"RUNNING"}]):{code:1,stdout:"",stderr},now);
    assert.equal(r.state,state); assert.equal(r.jobs[0].name,"A-vm");
  }
});
test("GCP H100 count and explicit-zone TPU discovery", async () => {
  for(const zones of [[],["z"]]) {
    const calls:string[][]=[];
    const r=await collectGcp({gcp:{projects:["A"],zones}},async(_cmd,args)=>{
      calls.push(args); return ok(args.includes("tpus")?[]:[{name:"vm",status:"RUNNING",machineType:"a3-highgpu-8g"}]);
    },now);
    assert.equal(r.jobs[0].accelerator,"~8× H100");
    const tpus=calls.filter(args=>args.slice(0,4).join(" ")==="compute tpus tpu-vm list");
    assert.equal(tpus.length,zones.length);
    if(zones.length) assert.deepEqual(tpus[0].slice(-2),["--zone","z"]);
  }
  assert.ok(computePage().includes(".suggestion{border-style:dashed"));
});
test("composed snapshot redacts credentials in Trackio names and other provider fields", async () => {
  const oldToken=process.env.SFCOMPUTE_API_TOKEN,oldConfig=process.env.PI_TRACKIO_COMPUTE_CONFIG;
  const token='cross-provider-"secret'; process.env.SFCOMPUTE_API_TOKEN=token; process.env.PI_TRACKIO_COMPUTE_CONFIG="/nonexistent/compute-audit-config";
  __resetComputeCache();
  try {
    const project=`project-${token}`,j=job("ap-redact","modal",project,null,now);j.detail=`detail ${token}`;j.status="running";
    const providers=(["modal","gcp","sfcompute"] as const).map(id=>async()=>{const p=report(id,now);if(id==="modal")p.jobs=[j];return p;});
    const s=await collectComputeSnapshot({force:true},{providers,projectData:async()=>[{project,configs:{},logging:{project,lastMetricAt:new Date(now).toISOString(),ageSeconds:0,runs:1,freshness:"live"}}]});
    assert.ok(!JSON.stringify(s).includes(token)); assert.ok(!computeSummaryMarkdown(s).includes(token));
    assert.equal(s.providers[0].jobs[0].detail,"detail [redacted]");
    assert.equal(s.providers[0].jobs[0].trackio!.project,"project-[redacted]"); assert.equal(s.logging[0].project,"project-[redacted]");
    const cached=await collectComputeSnapshot({force:true},{providers,projectData:async()=>[]});
    assert.equal(cached.providers[0].jobs[0].detail,"detail [redacted]");
  } finally {
    if(oldToken===undefined)delete process.env.SFCOMPUTE_API_TOKEN;else process.env.SFCOMPUTE_API_TOKEN=oldToken;
    if(oldConfig===undefined)delete process.env.PI_TRACKIO_COMPUTE_CONFIG;else process.env.PI_TRACKIO_COMPUTE_CONFIG=oldConfig;
    __resetComputeCache();
  }
});
test("composed URLs redact encoded credentials as well as decoded strings", async () => {
  const oldToken=process.env.SFCOMPUTE_API_TOKEN,oldConfig=process.env.PI_TRACKIO_COMPUTE_CONFIG;
  process.env.PI_TRACKIO_COMPUTE_CONFIG="/nonexistent/encoded-redaction-config";
  try {
    for(const token of ['prefix"quoted-secret','prefix\\u0041-secret','prefix\nnewline-secret']) {
      __resetComputeCache();process.env.SFCOMPUTE_API_TOKEN=token;
      const project=`project-${token}`,j=job("ap-url","modal",project,null,now);
      const providers=(["modal","gcp","sfcompute"] as const).map(id=>async()=>{const p=report(id,now);if(id==="modal")p.jobs=[j];return p;});
      const s=await collectComputeSnapshot({force:true},{providers,projectData:async()=>[{project,configs:{},logging:null}]});
      assert.ok(!JSON.stringify(s).includes(token));
      assert.ok(!computeSummaryMarkdown(s).includes(token));
      const decoded=new URL(s.providers[0].jobs[0].url!,"http://x").searchParams.get("project")!;
      assert.ok(!decoded.includes(token));
      assert.equal(decoded,"project-[redacted]");
    }
  } finally {
    if(oldToken===undefined)delete process.env.SFCOMPUTE_API_TOKEN;else process.env.SFCOMPUTE_API_TOKEN=oldToken;
    if(oldConfig===undefined)delete process.env.PI_TRACKIO_COMPUTE_CONFIG;else process.env.PI_TRACKIO_COMPUTE_CONFIG=oldConfig;
    __resetComputeCache();
  }
});
test("normalized containment adds weak suggestions without changing Jaccard decisions", () => {
  const projects=["EnergyUpcycle-v1_ebt","fast-llm-trading"];
  assert.equal(matchProject("energy-upcycle",projects),null);
  const suggestion=suggestProject("energy-upcycle",projects)!;
  assert.equal(suggestion.project,projects[0]);assert.ok(suggestion.score>=0.34&&suggestion.score<=0.59);
  assert.equal(suggestProject("paper-report-bfc3b518bbfd2c29",projects),null);
  assert.equal(suggestProject("energy-upcycle",["EnergyUpcycle-v1_ebt","EnergyUpcycle-v2_ebt"]),null);
  assert.equal(suggestProject("v11-sglang-lfm-perf",["SimplexV2-v11_sglang_lfm_serving"])!.score,0.5);
  assert.deepEqual(matchProject("model-ab",["model-a-b","model-ab"]),{project:"model-ab",score:1});
  assert.equal(matchProject("model_ab",["model-a-b","model-ab"]),null);
  assert.equal(suggestProject("simplexflow-v3",["SimplexFlow-v2"]),null);
  assert.equal(suggestProject("simplex",["simplex-a","simplex-b"]),null);
});
test("snapshot in-flight dedupe and forced throttle expiry", async () => {
  const originalNow=Date.now;let clock=now; Date.now=()=>clock; __resetComputeCache();
  const calls=[0,0,0];let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const deps={providers:(["modal","gcp","sfcompute"] as const).map((id,i)=>async()=>{calls[i]++;await gate;return report(id,clock);}),projectData:async()=>[]};
  try {
    const first=collectComputeSnapshot({force:true},deps),second=collectComputeSnapshot({force:true},deps);
    assert.deepEqual(calls,[1,1,1]);release();
    const [a,b]=await Promise.all([first,second]);assert.equal(a.checkedAt,b.checkedAt);assert.deepEqual(calls,[1,1,1]);
    clock+=5001;
    const fresh=await collectComputeSnapshot({force:true},deps);
    assert.deepEqual(calls,[2,2,2]);assert.notEqual(fresh.checkedAt,a.checkedAt);assert.equal(fresh.stale,false);
  } finally {release();Date.now=originalNow;__resetComputeCache();}
});
test("links reject version conflicts, asymmetric overlap and ambiguous candidates", () => {
  assert.equal(matchProject("simplexflow-v3",["SimplexFlow-v2"]),null);
  assert.equal(matchProject("fast-llm-image",["fast-llm-trading"]),null);
  assert.equal(matchProject("simplex",["simplex-a","simplex-b"]),null);
  assert.deepEqual(matchProject("simplexflow-v2",["SimplexFlow-v2","fast-llm-trading"]),{project:"SimplexFlow-v2",score:1});
  assert.equal(matchProject("jepa-vae",["fast-llm-trading"]),null);
  assert.deepEqual(matchProject("alpha beta gamma",["alpha beta"]),{project:"alpha beta",score:2/3});
});
test("suggestions remain weaker than links, reject conflicts and never count as silent", () => {
  const projects=["SimplexV2-v11_sglang_lfm_serving","fast-llm-trading"];
  const suggestion=suggestProject("v11-sglang-lfm-perf",projects)!;
  assert.equal(suggestion.project,projects[0]); assert.ok(Math.abs(suggestion.score-0.5)<1e-10);
  assert.equal(suggestProject("energy-upcycle",projects),null);
  assert.equal(suggestProject("simplexflow-v3",["SimplexFlow-v2"]),null);
  assert.equal(suggestProject("simplex",["simplex-a","simplex-b"]),null);
  assert.equal(suggestProject("SimplexFlow-v2",["SimplexFlow-v2"]),null);
  const j=job("ap-suggest","modal","v11-sglang-lfm-perf",null,now); j.status="running";
  assert.equal(j.suggestion,null);
  linkJobs([j],projects.map(project=>({project,configs:{},logging:null})),{});
  assert.deepEqual(j.suggestion,suggestion); assert.equal(j.trackio,null); assert.equal(j.url,null); assert.equal(countSilentJobs([j]),0);
  const p=report("modal",now);p.jobs=[j];
  const s:ComputeSnapshot={checkedAt:new Date(now).toISOString(),refreshSeconds:20,stale:false,providers:[p],logging:[],totals:{running:1,silent:0,jobs:1,providers:3,providersOk:1}};
  assert.ok(computeSummaryMarkdown(s).includes('? '+projects[0]+' (0.50)'));
  const elements:Record<string,{innerHTML:string;textContent:string}>={};
  const context={document:{hidden:false,body:{classList:{add(){}}},getElementById:(id:string)=>elements[id]??={innerHTML:"",textContent:""}},location:{search:""},URLSearchParams,setInterval(){},fetch:()=>new Promise(()=>{}),fixture:s};
  runInNewContext(computePage().match(/<script>([\s\S]*?)<\/script>/)![1]+";render(fixture);",context);
  const markup=elements.content.innerHTML;
  assert.match(markup,/<span class="muted">—<\/span><span class="chip suggestion"/);
  assert.ok(markup.includes('title="Possible match (score 0.50). Not reported by the job — confirm it by adding a linkOverrides entry to ~/.config/trackio-compute.json."'));
  assert.ok(!markup.includes('<a '));
  linkJobs([j],[{project:projects[0],configs:{r1:{submission:{app_id:"ap-suggest"}}},logging:null}],{});
  assert.equal(j.trackio!.match,"app_id"); assert.equal(j.suggestion,null);
});
test("Modal stopped apps and terminal containers are omitted", async () => {
  const stopped=await collectModal({},async(_cmd,args)=>ok(args[0]==="container"?[containers[0]]:[{...apps[0],state:" stopped (detached)"}]),now);
  assert.equal(stopped.jobs.length,0);
  for(const terminal of ["STOPPED","TERMINATED","FAILED","EXITED","DONE","COMPLETED"]) {
    const r=await collectModal({},async(_cmd,args)=>ok(args[0]==="container"?[{...containers[0],status:terminal}]:[]),now);
    assert.equal(r.jobs.length,0);
    const s=await collectModal({},async(_cmd,args)=>ok(args[0]==="container"?[{...containers[0],state:terminal}]:[]),now);
    assert.equal(s.jobs.length,0);
  }
});
test("Modal single environment is applied and partial failure is explicit", async () => {
  const calls:string[][]=[];
  const r=await collectModal({modal:{environments:["prod"]}},async(_cmd,args)=>{
    calls.push(args); return args[0]==="container"?ok([]):{code:1,stdout:"",stderr:"upstream unavailable"};
  },now);
  assert.equal(calls.length,2); for(const args of calls) assert.deepEqual(args.slice(-2),["--env","prod"]);
  assert.equal(r.state,"ok"); assert.match(r.message!,/Partial: modal app list failed/); assert.equal(r.jobs.length,0);
});
test("GCP retains healthy jobs with auth failures and classifies discovery auth", async () => {
  const expired={code:1,stdout:"",stderr:"Reauthentication failed"};
  const r=await collectGcp({gcp:{projects:["A","B"]}},async(_cmd,args)=>args.includes("A")?ok([{name:"A-vm",status:"RUNNING"}]):expired,now);
  assert.equal(r.state,"auth_required"); assert.equal(r.jobs[0].name,"A-vm");
  const discovery=await collectGcp({},async()=>expired,now);
  assert.equal(discovery.state,"auth_required"); assert.match(discovery.message!,/gcloud auth login/);
});
test("GCP rejects unknown machine suffixes and prefers reported accelerators", async () => {
  for(const machineType of ["g2-standard-999","a3-highgpu-potato","a2-highgpu-16g"]) {
    const r=await collectGcp({gcp:{projects:["A"]}},async()=>ok([{name:"vm",status:"RUNNING",machineType}]),now);
    assert.equal(r.jobs[0].accelerator,null);
  }
  const r=await collectGcp({gcp:{projects:["A"]}},async()=>ok([{name:"vm",status:"RUNNING",machineType:"a2-highgpu-1g",guestAccelerators:[{acceleratorType:"nvidia-tesla-h100",acceleratorCount:1}]}]),now);
  assert.equal(r.jobs[0].accelerator,"1× H100");
});
test("page distinguishes exact and fuzzy name evidence and shows partial provider messages", () => {
  const elements: Record<string,{innerHTML:string;textContent:string;onclick?:unknown}> = {};
  const get=(id:string)=>elements[id]??=( {innerHTML:"",textContent:""} );
  const j=job("app","modal","alpha beta gamma",null,now);
  linkJobs([j],[{project:"alpha beta",configs:{},logging:null}],{});
  const p=report("modal",now);p.jobs=[j];p.message="Partial: modal app list failed (fixture)";
  const s:ComputeSnapshot={checkedAt:new Date(now).toISOString(),refreshSeconds:20,stale:false,providers:[p],logging:[],totals:{running:0,silent:0,jobs:1,providers:3,providersOk:1}};
  const context={document:{hidden:false,body:{classList:{add(){}}},getElementById:get},location:{search:""},URLSearchParams,setInterval(){},fetch:()=>new Promise(()=>{}),fixture:s};
  const script=computePage().match(/<script>([\s\S]*?)<\/script>/)![1];
  runInNewContext(script+";render(fixture);",context);
  assert.match(get("content").innerHTML,/Inferred from a name match \(score 0.67\), not reported by the job/);
  assert.match(get("content").innerHTML,/Partial: modal app list failed/);
  j.trackio!.score=1;
  runInNewContext("render(fixture)",context);
  assert.match(get("content").innerHTML,/Name match only \(normalized names are equal\), not reported by the job/);
  assert.ok(!get("content").innerHTML.includes("score 1.00"));
});
test("forced snapshots throttle twenty sequential calls without provider work", async () => {
  __resetComputeCache(); const calls=[0,0,0]; let projectCalls=0;
  const deps={providers:(["modal","gcp","sfcompute"] as const).map((id,i)=>async()=>{calls[i]++;return report(id,Date.now());}),projectData:async()=>{projectCalls++;return [];}};
  try {
    const first=await collectComputeSnapshot({force:true},deps); assert.equal(first.stale,false);
    for(let i=1;i<20;i++) { const s=await collectComputeSnapshot({force:true},deps); assert.equal(s.stale,true); assert.equal(s.checkedAt,first.checkedAt); }
    assert.deepEqual(calls,[1,1,1]); assert.equal(projectCalls,1);
  } finally { __resetComputeCache(); }
});
test("Modal missing CLI never rejects", async () => {
  const runner: Runner = async () => { throw Object.assign(new Error("missing"), {code:"ENOENT"}); };
  assert.equal((await collectModal({}, runner, now)).state, "not_configured");
});
test("GCP expired credentials", async () => {
  const runner: Runner = async () => ({code:1, stdout:"", stderr:"There was a problem refreshing your current auth tokens: Reauthentication failed...  $ gcloud auth login"});
  const r = await collectGcp({gcp:{projects:["p1"]}}, runner, now);
  assert.equal(r.state,"auth_required"); assert.match(r.message!, /gcloud auth login/);
});
test("GCP active VM inference and stopped filtering", async () => {
  const instance = {name:"vm1",status:"RUNNING",machineType:"zones/us-central1-a/machineTypes/a2-highgpu-1g",zone:"https://www.googleapis.com/compute/v1/projects/p1/zones/us-central1-a",creationTimestamp:"2026-10-22T19:46:47Z"};
  const r = await collectGcp({gcp:{projects:["p1"]}}, async () => ok([instance, {...instance,name:"stopped",status:"TERMINATED"}]), now);
  assert.equal(r.state,"ok"); assert.equal(r.jobs.length,1); assert.equal(r.jobs[0].region,"us-central1-a"); assert.equal(r.jobs[0].accelerator,"~1× A100 40GB");
});
test("GCP explicit CLI is used for discovery and instance calls", async () => {
  const calls: string[] = [];
  const r = await collectGcp({gcp:{cli:"/fixture/gcloud"}}, async (cmd,args) => {
    calls.push(cmd); return args[0] === "config" ? {code:0,stdout:"p1",stderr:""} : ok([]);
  },now);
  assert.equal(r.state,"ok"); assert.deepEqual(calls,["/fixture/gcloud","/fixture/gcloud"]);
});
test("GCP g2 vCPU suffix maps to actual L4 count", async () => {
  for (const [suffix, count] of [[24,2],[4,1]]) {
    const r = await collectGcp({gcp:{projects:["p1"]}},async()=>ok([{name:"g2",status:"RUNNING",machineType:`g2-standard-${suffix}`}]),now);
    assert.equal(r.jobs[0].accelerator,`~${count}× L4`);
  }
});
test("linked freshness determines silent totals and summary; pending and unlinked jobs do not", () => {
  for (const freshness of ["stale","old","none","live","recent"] as const) {
    const j = job("ap-silent","modal","linked-project",null,now); j.status="running";
    const ageSeconds = {stale:1800,old:86400,none:0,live:12,recent:300}[freshness];
    linkJobs([j],[{project:"linked-project",configs:{},logging:freshness === "none" ? null : {project:"linked-project",lastMetricAt:new Date(now-ageSeconds*1000).toISOString(),ageSeconds,runs:1,freshness}}],{});
    const p = report("modal",now); p.jobs=[j];
    const s: ComputeSnapshot = {checkedAt:new Date(now).toISOString(),refreshSeconds:20,stale:false,providers:[p],logging:[],totals:{running:1,silent:countSilentJobs([j]),jobs:1,providers:3,providersOk:1}};
    const expected = ["stale","old","none"].includes(freshness) ? 1 : 0;
    assert.equal(j.trackio!.freshness,freshness);
    assert.equal(s.totals.silent,expected,`running linked ${freshness}`);
    assert.equal(computeSummaryMarkdown(s).includes(" · 1 silent"),expected === 1,`summary for ${freshness}`);
    j.status="pending"; s.totals.running=0; s.totals.silent=countSilentJobs([j]);
    assert.equal(s.totals.silent,0,`pending linked ${freshness}`);
    assert.ok(!computeSummaryMarkdown(s).includes(" · 1 silent"));
    j.status="running"; j.trackio=null; s.totals.running=1; s.totals.silent=countSilentJobs([j]);
    assert.equal(s.totals.silent,0,`unlinked ${freshness}`);
    assert.ok(!computeSummaryMarkdown(s).includes(" · 1 silent"));
  }
});
test("Markdown logging now excludes day-old projects and summarizes quieter logging", () => {
  const s: ComputeSnapshot = {checkedAt:new Date(now).toISOString(),refreshSeconds:20,stale:false,providers:[],totals:{running:0,silent:0,jobs:0,providers:3,providersOk:0},logging:[
    {project:"fresh-project",lastMetricAt:new Date(now-12000).toISOString(),ageSeconds:12,runs:1,freshness:"live"},
    {project:"day-old-project",lastMetricAt:new Date(now-22*3600000).toISOString(),ageSeconds:22*3600,runs:1,freshness:"old"},
  ]};
  const line = computeSummaryMarkdown(s,false).split("\n").find(l=>l.startsWith("**Logging now:**"))!;
  assert.equal(line,"**Logging now:** fresh-project (12s) + 1 quieter (oldest 22h)");
  assert.ok(!line.includes("day-old-project"));
  s.logging.shift();
  assert.match(computeSummaryMarkdown(s,false),/\*\*Logging now:\*\* — \+ 1 quieter \(oldest 22h\)/);
  const j=job("new","modal","new",new Date(now-30000).toISOString(),now);
  const p=report("modal",now); p.jobs=[j]; s.providers=[p];
  assert.match(computeSummaryMarkdown(s,false),/up just started/);
});
test("SF missing token, envelope, aliases, fallback and credential safety", async () => {
  const previous = process.env.SFCOMPUTE_API_TOKEN; delete process.env.SFCOMPUTE_API_TOKEN;
  try {
    assert.equal((await collectSfcompute({sfcompute:{tokenFile:"/nonexistent/pi-compute-token"}},noRunner,now)).state,"not_configured");
    const token = "secret-test-credential"; const urls: string[] = []; const signals: unknown[] = [];
    const request: typeof fetch = async (input, opts) => {
      const url = String(input); urls.push(url); signals.push(opts?.signal); assert.equal((opts!.headers as Record<string,string>).authorization, `Bearer ${token}`);
      return url.includes("/preview/v2/") ? new Response("",{status:404}) : Response.json({data:[{id:"inst_xxx",name:"test",status:"running",sku_id:"sku_x",pool_id:"dev"},{id:"skip",status:"failed"}]});
    };
    const cfg = {sfcompute:{token,baseUrl:"https://fixture.invalid",workspace:"a b"}};
    const r = await collectSfcompute(cfg,noRunner,now,request);
    assert.equal(r.state,"ok"); assert.equal(r.jobs.length,1); assert.equal(r.jobs[0].status,"running"); assert.equal(r.jobs[0].accelerator,"sku_x"); assert.equal(r.jobs[0].region,"dev"); assert.ok(!JSON.stringify(r).includes(token)); assert.equal(urls.length,2); assert.ok(urls[1].endsWith("/instances?workspace=a%20b"));
    assert.notEqual(signals[0],signals[1]);
    await collectSfcompute(cfg,noRunner,now,request); assert.equal(urls.length,3);
    await collectSfcompute({sfcompute:{...cfg.sfcompute,workspace:"other"}},noRunner,now,request); assert.equal(urls.length,5);
    for (const [status,state] of [[403,"auth_required"],[422,"error"]] as const) assert.equal((await collectSfcompute(cfg,noRunner,now,async()=>new Response("readonly token",{status}))).state,state);
  } finally { if(previous === undefined) delete process.env.SFCOMPUTE_API_TOKEN; else process.env.SFCOMPUTE_API_TOKEN=previous; }
});
test("SF credential redaction covers decoded strings including quotes and literal Unicode escapes", async () => {
  for (const token of ["safe-test-token", 'prefix"quoted-secret', "prefix\\u0041-secret"]) {
    const r = await collectSfcompute({sfcompute:{token}},noRunner,now,async()=>Response.json({data:[{id:token,name:token,status:"running",pool_id:`pool ${token}`,sku_id:`sku ${token}`}]}));
    assert.equal(r.state,"ok");
    assert.equal(r.jobs[0].name,"[redacted]");
    assert.equal(r.jobs[0].id,"[redacted]");
    assert.equal(r.jobs[0].region,"pool [redacted]");
    assert.equal(r.jobs[0].accelerator,"sku [redacted]");
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(token));
    assert.ok(!serialized.includes("prefix"+"-secret"));
    assert.ok(!serialized.includes("prefix"));
  }
});
test("links exact, unrelated, app id and override precedence", () => {
  assert.deepEqual(matchProject("simplexflow-v2",["SimplexFlow-v2","fast-llm-trading"]),{project:"SimplexFlow-v2",score:1});
  assert.equal(matchProject("jepa-vae",["SimplexFlow-v2","fast-llm-trading"]),null);
  const data = [{project:"SimplexFlow-v2",configs:{},logging:null},{project:"IDProject",configs:{r1:{submission:{app_id:"ap-1"}}},logging:null}];
  const j = job("ap-1","modal","simplexflow-v2",null,now);
  linkJobs([j],data,{}); assert.equal(j.trackio!.match,"app_id"); assert.equal(j.trackio!.project,"IDProject"); assert.deepEqual(j.trackio!.runs,["r1"]);
  linkJobs([j],data,{linkOverrides:{"AP-1":{project:"Override",runs:["x,y"]}}}); assert.equal(j.trackio!.match,"override"); assert.equal(j.trackio!.project,"Override"); assert.equal(j.url,"/__trackio/app/?project=Override&runs=x%2Cy");
});
test("compute routes use injected collectors without network or subprocesses", async () => {
  const previous = process.env.PI_WEB_PASSWORD; delete process.env.PI_WEB_PASSWORD;
  try {
    const snapshot: ComputeSnapshot = {checkedAt:new Date(now).toISOString(),refreshSeconds:20,stale:false,totals:{running:0,silent:0,jobs:0,providers:3,providersOk:3},providers:[report("modal",now),report("gcp",now),report("sfcompute",now)],logging:[]};
    const handler = createTrackioRouteHandler({computeSnapshot:async()=>snapshot,computePageHtml:computePage});
    async function call(url:string, method="GET") {
      let status=0, body=""; let headers: Record<string,string> = {};
      const req = {url,method,headers:{host:"127.0.0.1"}} as IncomingMessage;
      const res = {writeHead(s:number,h:Record<string,string>){status=s;headers=h;},end(b:Buffer|string){body=String(b);}} as unknown as ServerResponse;
      assert.equal(await handler(req,res),true); return {status,body,headers};
    }
    const json = await call("/__trackio/compute.json?force=1"); assert.equal(json.status,200); assert.match(json.headers["content-type"],/application\/json/); assert.equal(JSON.parse(json.body).providers.length,3);
    const html = await call("/__trackio/compute"); assert.equal(html.status,200); assert.ok(html.body.startsWith("<!doctype html>")); assert.match(html.body,/Active compute/); assert.equal((html.body.match(/<script>/g)||[]).length,1);
    assert.equal((await call("/__trackio/compute","HEAD")).status,200);
    assert.equal((await call("/__trackio/nope")).status,404);
  } finally { if(previous===undefined) delete process.env.PI_WEB_PASSWORD; else process.env.PI_WEB_PASSWORD=previous; }
});

const vastFetch = (instances: unknown[], user: Record<string, unknown>, status = 200) => (async (url: string) => new Response(JSON.stringify(url.includes("/users/current") ? user : { instances }), { status })) as unknown as typeof fetch;
test("Vast.ai reports credit, burn, runway and per-instance utilization", async () => {
  const old = process.env.VAST_AI_API_KEY, oldKey = process.env.VAST_API_KEY;
  process.env.VAST_AI_API_KEY = "vast-test-key"; delete process.env.VAST_API_KEY;
  try {
    const r = await collectVast({}, null, now, vastFetch([
      { id: 1, cur_state: "running", actual_status: "running", gpu_name: "RTX 5090", num_gpus: 4, gpu_util: 50, cpu_util: 1, dph_total: 2.4, uptime_mins: 60, ssh_host: "ssh1.vast.ai", ssh_port: 1234, geolocation: "FI" },
      { id: 2, cur_state: "running", actual_status: "loading", gpu_name: "H100 NVL", num_gpus: 1, gpu_util: 0, dph_total: 2.4 },
    ], { username: "lev", credit: 50 }));
    assert.equal(r.state, "ok");
    assert.equal(r.jobs.length, 2);
    assert.equal(r.jobs[0].status, "running"); assert.equal(r.jobs[1].status, "pending");
    assert.equal(r.jobs[0].accelerator, "4× RTX 5090");
    assert.equal(r.jobs[0].region, "FI");
    assert.equal(r.jobs[0].utilization!.gpu, 50);
    assert.equal(r.jobs[0].uptimeSeconds, 3600);
    assert.equal(r.stats!.find(s => s.label === "credit")!.value, "$50.00");
    assert.equal(r.stats!.find(s => s.label === "burn")!.value, "$2.40/hr");
    assert.equal(r.stats!.find(s => s.label === "runway")!.value, "20.8h");
    assert.equal(r.stats!.find(s => s.label === "gpus")!.value, "4");
  } finally {
    if (old === undefined) delete process.env.VAST_AI_API_KEY; else process.env.VAST_AI_API_KEY = old;
    if (oldKey === undefined) delete process.env.VAST_API_KEY; else process.env.VAST_API_KEY = oldKey;
  }
});
test("Vast.ai distinguishes missing key from a rejected key and never leaks it", async () => {
  const old = process.env.VAST_AI_API_KEY, oldKey = process.env.VAST_API_KEY;
  delete process.env.VAST_AI_API_KEY; delete process.env.VAST_API_KEY;
  try {
    const missing = await collectVast({ vast: { tokenFile: "/nonexistent/vast_key" } }, null, now, vastFetch([], {}));
    assert.equal(missing.state, "not_configured");
    const secret = "vast-secret-token-value";
    const rejected = await collectVast({ vast: { token: secret } }, null, now, vastFetch([], {}, 401));
    assert.equal(rejected.state, "auth_required");
    assert.ok(!JSON.stringify(rejected).includes(secret));
  } finally {
    if (old === undefined) delete process.env.VAST_AI_API_KEY; else process.env.VAST_AI_API_KEY = old;
    if (oldKey === undefined) delete process.env.VAST_API_KEY; else process.env.VAST_API_KEY = oldKey;
  }
});
