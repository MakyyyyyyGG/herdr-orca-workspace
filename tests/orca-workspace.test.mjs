import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { exitedAgent, endpoints, portLabel } from "../mods/orca-projects/activity.js";
import { changeAgent, asleep } from "../mods/orca-agent-actions/lifecycle.js";
import { sections, reviewFiles, committedFiles } from "../mods/orca-changes/review.js";
import { pushInfo, pushBranch } from "../mods/orca-changes/push.js";
import { browserHost, webAddress } from "../mods/orca-projects/web-port.js";
import { normalize, key, locations, parseWorktrees, groupProjects } from "../mods/orca-projects/projects.js";

import { repository } from "../mods/orca-add-project/repository.js";

const exec = promisify(execFile);
const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = path.join(process.env.LOCALAPPDATA, "Programs/herdr-core/hc.exe");
const app = path.join(process.env.LOCALAPPDATA, "Programs/herdr-app/herdr-app.exe");
const gitExe = path.join(process.env.ProgramFiles, "Git/cmd/git.exe");
const run = async (cmd,args,opts={}) => (await exec(cmd,args,{ windowsHide:true,maxBuffer:8<<20,...opts })).stdout;
const git = (cwd,...args) => run(gitExe,["-C",cwd,...args]);
const call = args => run(core,[...args,"--json"]);
const temp = name => mkdtemp(path.join(tmpdir(),"herdr-"+name+"-"));
async function waitFor(fn, name) {
  for (let i=0; i<70; i++) { const value=await fn(); if(value) return value; await delay(120); }
  throw Error("Timed out waiting for "+name);
}
async function modSource(file, relPath, seen = new Map()) {
  const full = path.resolve(home, "mods", file, relPath);
  if (seen.has(full)) return seen.get(full);
  const raw = await readFile(full, "utf8");
  const dir = path.dirname(full);
  const relImports = [...raw.matchAll(/from\s+"(\.\/[^"]+)"/g)];
  let source = raw
    .replace(/import \{([^}]+)\} from "(?:gpui-kit|gpui-base)";/g, (_, names) => "const {" + names + "}=globalThis.__gpuiTest;")
    .replace(/import \{([^}]+)\} from "herdr";/g, (_, names) => "const {" + names + "}=globalThis.__herdrTest;");
  for (const m of relImports) {
    const childRel = path.relative(path.join(home, "mods", file), path.resolve(dir, m[1]));
    const childUrl = await modSource(file, childRel, seen);
    source = source.replaceAll(`"${m[1]}"`, `"${childUrl}"`);
  }
  const url = "data:text/javascript;base64," + Buffer.from(source).toString("base64") + "#" + Math.random();
  seen.set(full, url);
  return url;
}
async function modImport(file, relPath, herdr, gpuiExtra = {}) {
  globalThis.__herdrTest = herdr;
  const inputStub = () => ({ on(){}, value: () => "", set_value(){}, focus(){} });
  const editorStub = () => ({ release(){} });
  globalThis.__gpuiTest = {
    View: class {},
    div: element,
    v_flex: element,
    h_flex: element,
    svg: element,
    image: element,
    ScrollHandle: { new: () => ({ scroll_to_item(){} }) },
    Scrollbar: { vertical: element },
    v_virtual_list: element,
    InputState: { new: inputStub },
    Input: { new: element },
    EditorState: { new: editorStub },
    Editor: { new: element },
    ...gpuiExtra
  };
  return import(await modSource(file, relPath));
}
async function filesModel(file, herdr, gpuiExtra = {}) {
  return (await modImport(file, "main.js", herdr, gpuiExtra)).default;
}

function element() {
  const node={content:[]};
  const view=new Proxy(node,{get(obj,prop){
    if(prop in obj) return obj[prop];
    return (...args)=>{
      if(prop==="id") node.key=args[0];
      if(prop==="on_click") node.click=args[0];
      if(prop==="child") node.content.push(args[0]);
      if(prop==="children") node.content.push(...args[0]);
      if(prop==="when" && args[0]) args[1](view);
      return view;
    };
  }});
  return view;
}
const flatten = node => typeof node==="object" ? [node,...node.content.flatMap(flatten)] : [node];
async function commandResult(cmd,args,options={}) {
  try {return {code:0,...await exec(cmd,args,{windowsHide:true,...options})};}
  catch(e){return {code:e.code,stdout:e.stdout || "",stderr:e.stderr || e.message};}
}

test("All changed Herdr mods load and the layout references one inspector switch and one usage strip",async()=>{
  for(const mod of ["orca-tabs","orca-projects","orca-project-actions","orca-add-project","orca-agent-actions","orca-files","orca-changes","orca-inspector","orca-usage"]) {
    const out=await run(app,["check",path.join(home,"mods",mod)]); assert.match(out,/check passed/);
  }
  const layout=JSON.parse(await readFile(path.join(home,"layouts/orca.json")));
  const mods=[]; function visit(n){if(n.content?.mod)mods.push(n.content.mod);(n.children||[]).forEach(visit)}visit(layout);
  assert.ok(mods.includes("orca-tabs"));assert.equal(mods.filter(m=>m==="orca-usage").length,1);assert.ok(mods.includes("orca-inspector"));
});

test("Provider detection and listening endpoint identity",()=>{
  const cases=[
    ["antigravity",["powershell"],true],["codex",["powershell","node"],true],
    ["codex",["powershell","codex"],false],["antigravity",["powershell","agy"],false],
    ["claude-code",["cmd","node","claude-code"],false],["codex",["powershell","wsl"],false],
    ["other",["powershell","unknown-host"],false],["other",["powershell"],true],["codex",[],false]
  ];
  for(const [app,names,gone] of cases)assert.equal(exitedAgent({key:app},app,names),gone,JSON.stringify([app,names]));
  const p={bind:"127.0.0.1",port:3000,pid:1};const result=endpoints([{ports:[p,p]},{ports:[{...p,bind:"[::1]"},{...p,port:4000}]}]);
  assert.equal(result.length,3);assert.equal(portLabel(result),":3000 +1");assert.equal(portLabel([]),"");
});

test("Left sidebar keeps creation working while the project list fails and recovers", async () => {
  const commands = [];
  let offline = true, folder = null, closed = 0, redraws = 0, pending;
  const host = {
    theme: () => ({}), layout: () => null, checking: () => false, props: () => ({}),
    spaces: () => { if (offline) throw Error("Core reconnecting"); return []; },
    panes: () => [], terminals: () => [], agents: () => [], shared: () => null,
    home: () => "D:/work", window: () => ({ platform: "linux" }), setAgentOrder() {},
    exec: async () => { throw Error("Git unavailable"); },
    pickFolder: async () => folder, closeOverlay: () => { closed++; },
    run: (name, args) => commands.push([name, args])
  };
  const cx = { timer: { after() {}, every() {} }, focus_handle: () => ({}),
    notify: () => { redraws++; }, spawn: fn => { pending = fn(cx); } };
  const item = (view, id) => flatten(view.render(cx)).find(node => node?.key === id);
  const Projects = await filesModel("orca-projects", host), projects = new Projects();
  projects.init(null, cx);
  const retry = item(projects, "retry-projects");
  assert.ok(retry);
  const Actions = await filesModel("orca-project-actions", host), actions = new Actions();
  item(actions, "new-space").click();
  item(actions, "open-project").click();
  assert.deepEqual(commands, [["space.new", { machine: "" }], ["mod.open", { name: "orca-add-project" }]]);

  const Add = await filesModel("orca-add-project", host), dialog = new Add();
  dialog.init(null, cx);
  item(dialog, "folder").click(null, cx);
  await pending;
  assert.equal(closed, 0);
  assert.equal(commands.length, 2);
  folder = "D:/My projects";
  item(dialog, "folder").click(null, cx);
  await pending;
  assert.deepEqual(commands[2], ["space.new", { folder, machine: "" }]);
  assert.equal(closed, 1);
  offline = false;
  const before = redraws;
  retry.click(null, cx);
  assert.ok(redraws > before);
  assert.ok(item(projects, "projects-empty"));
});

test("Process ownership, live listeners, clear screen, sleep, wake, stale report, close and delete on an isolated terminal",async()=>{
  const dir=await temp("lifecycle"), name="orca-test-"+Date.now().toString(36);
  const script=path.join(dir,"codex.js"), fixture=path.join(dir,"fixture.ps1"), portFile=path.join(dir,"port"), stop=path.join(dir,"stop"), exit=path.join(dir,"finish");
  await writeFile(script,[
    'const fs=require("node:fs"), net=require("node:net");',
    'const [port,stop,exit]=process.argv.slice(2);',
    'const report=s=>process.stdout.write("\\x1b]7501;state="+s+":app=codex\\x07");',
    'if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.resume();',
    'process.stdin.on("data",()=>report("idle"));process.on("SIGINT",()=>report("idle"));',
    'const server=net.createServer();server.listen(0,"127.0.0.1",()=>{report("working");process.stdout.write("\\x1b[2J");fs.writeFileSync(port,String(server.address().port));});',
    'setInterval(()=>{if(server.listening&&fs.existsSync(stop))server.close();if(fs.existsSync(exit))process.exit(0);},80);'
  ].join("\n"));
  await writeFile(fixture,"param($Node,$Script,$PortFile,$StopFile,$ExitFile)\r\n& $Node $Script $PortFile $StopFile $ExitFile\r\nStart-Sleep -Seconds 90\r\n");
  const other=createServer();await new Promise(ok=>other.listen(0,"127.0.0.1",ok));
  let address,created;
  const get=async()=>JSON.parse(await call(["get",address]));
  try{
    const args=["run","--json","--bg","--no-parent","--no-notify","--keep","--name",name,"--","powershell.exe","-NoProfile","-ExecutionPolicy","Bypass","-File",fixture,process.execPath,script,portFile,stop,exit];
    address=JSON.parse(await run(core,args)).address; assert.ok(address);
    await waitFor(async()=>{try{return Number(await readFile(portFile))}catch{return 0}},"test listener");
    const t=await waitFor(async()=>{const r=await get();return r.status?.state==="working"&&r},"OSC working report");
    created=t.created_ms;assert.equal(t.name,name);const target={address,created,app:"codex"};
    const scan=async()=>JSON.parse(await run("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(home,"mods/orca-projects/listeners.ps1"),String(t.pid)]))[0];
    const port=Number(await readFile(portFile));let row=await scan();
    assert.ok(row.ports.some(p=>p.port===port&&p.bind==="127.0.0.1"));assert.ok(!row.ports.some(p=>p.port===other.address().port));
    assert.equal(exitedAgent({key:"codex"},"codex",row.names),false,"clearing the screen keeps the running agent");
    await changeAgent("sleep",target,get,call);assert.equal(asleep(await get()),true);
    await changeAgent("wake",target,get,call);assert.equal(asleep(await get()),false);
    await writeFile(stop,""); await waitFor(async()=>!(await scan()).ports.some(p=>p.port===port),"listener removal");
    await writeFile(exit,"");row=await waitFor(async()=>{const r=await scan();return r.names.every(x=>x==="powershell"||x==="conhost")&&r},"shell return");
    assert.equal(exitedAgent({key:"codex"},"codex",row.names),true);
    await changeAgent("close",{address,created},get,call);assert.equal((await get()).state,"finished");
    await changeAgent("delete",{address,created},get,call);await assert.rejects(get);address=null;
  } finally {
    other.close();
    if(address){const t=await get().catch(()=>null);if(t?.name===name && (created===undefined||t.created_ms===created)){
      if(t.state==="live")await call(["kill",address]);await call(["rm",address]).catch(()=>{});
    }}
  }
});

test("Unsafe or failed lifecycle transitions do not mark a running agent asleep or remove another terminal",async()=>{
  const t={state:"live",status:{state:"working",app:"codex"},created_ms:81,foreground:{pid:10},labels:{},turn:4};
  const target={address:"fixture",created:81,app:"codex",foreground:10};
  const ops=[];const call=async a=>ops.push(a[0]);
  await assert.rejects(changeAgent("sleep",target,async()=>t,call),/did not report/);assert.deepEqual(ops,["interrupt"]);
  for(const diff of [{created:82},{app:"other"},{foreground:11}])await assert.rejects(changeAgent("delete",{...target,...diff},async()=>t,call),/changed/);
  await assert.rejects(changeAgent("sleep", {...target,app:null},async()=>({...t,status:null}),call),/not reported/);
  assert.ok(!ops.includes("kill")&&!ops.includes("rm"));
});

test("Real Git conflict, filename-only staged and unstaged groups, untracked file, filename index, linked and detached worktrees",async()=>{
  const root=await temp("git-review"),repo=path.join(root,"repo");await mkdir(repo);
  await git(repo,"init","-q","-b","main");await git(repo,"config","user.name","Fixture");await git(repo,"config","user.email","fixture@example.test");
  const put=(p,text)=>writeFile(path.join(repo,p),text);
  await mkdir(path.join(repo,"src"));await put("src/auth.ts","base\n");await put("conflict.txt","base\n");await put(".gitignore","ignored.log\n");
  await git(repo,"add",".");await git(repo,"commit","-qm","base");await git(repo,"switch","-qc","feature");
  await put("conflict.txt","feature\n");await git(repo,"commit","-qam","feature");await git(repo,"switch","-q","main");
  await put("conflict.txt","main\n");await git(repo,"commit","-qam","main");await assert.rejects(git(repo,"merge","feature"));
  await put("src/auth.ts","staged\n");await git(repo,"add","src/auth.ts");await put("src/auth.ts","unstaged\n");await put("new file.txt","fresh\n");await put("ignored.log","ignore\n");
  const status=(await git(repo,"status","--porcelain=v1","-z","--no-renames","--untracked-files=all")).split("\0").filter(Boolean);
  const files=reviewFiles(status);
  assert.equal(new Set(files.map(f=>f.path)).size,3);assert.ok(files.find(f=>f.path==="conflict.txt" && f.section==="Uncommitted" && f.conflict));
  assert.deepEqual(files.filter(f=>f.path==="src/auth.ts").map(f=>f.section),["Uncommitted","Staged"]);
  const host={spaces:()=>[{active:true,folder:repo}],focused:()=>null,panes:()=>[],window:()=>({platform:"windows"}),
    exec:async (cmd,args,opt)=>{try{return{code:0,stdout:await run(cmd,args,{cwd:opt.cwd})}}catch(e){return{code:e.code,stderr:e.stderr}}},
    readTextFile:async f=>readFile(f,"utf8")};
  const Changes=await filesModel("orca-changes",host),changes=new Changes();Object.assign(changes,{files,root:repo,on:null,folds:new Set()});
  const ctx=JSON.stringify({cwd:repo,on:null});
  const text=changes.fileRows({}).flatMap(flatten).filter(n=>typeof n==="string");
  assert.equal(text.filter(n=>n==="auth.ts").length,2);
  assert.ok(!text.includes("src") && !text.includes("src/auth.ts"));
  assert.ok(!text.includes("staged") && !text.includes("unstaged") && !text.some(n=>/^[-+−]\d+$/.test(n)));
  const Files=await filesModel("orca-files",host),browser=new Files(),context={cwd:repo,on:null,key:ctx};browser.context=context;
  browser.current=()=>true;let pending;browser.indexFiles(context,{spawn:fn=>pending=fn({notify(){}})});await pending;
  assert.ok(browser.index.includes("src/auth.ts")&&browser.index.includes("new file.txt"));assert.ok(!browser.index.includes("ignored.log"));
  const link=path.join(root,"worktree"),detached=path.join(root,"detached");await git(repo,"worktree","add","-q",link,"feature");await git(repo,"worktree","add","-q","--detach",detached);
  const trees=parseWorktrees(await git(repo,"worktree","list","--porcelain","-z"));assert.equal(trees.length,3);assert.ok(trees.some(x=>x.detached));
  const s={id:"s",machine:null,tabs:[{id:"tab"}]}, ps=[{tab:"tab",pane:"p1",terminal:"t1",cwd:repo},{tab:"tab",pane:"p2",terminal:"t2",cwd:link}];
  const agents=ps.map(p=>({address:p.terminal,pane:p.pane,space:"s",status:"idle"})),live=ps.map(p=>({address:p.terminal,state:"live"}));
  live.push({address:"kid",parent:"t2",state:"live",cwd:link});
  const items=locations([s],ps,agents,live,{t1:{exited:true},t2:{exited:false,ports:[{port:3000,pid:7,bind:"::1"}]}});
  const repos=new Map(items.map(i=>[key(null,i.path),{main:normalize(repo),top:i.path,trees}]));
  const groups=groupProjects(items,repos);assert.equal(groups.length,1);assert.equal(groups[0].checkouts.size,3);
  assert.deepEqual(items.filter(i=>i.agent).map(i=>i.agent.address),["t2","kid"]);assert.equal(endpoints(items)[0].port,3000);
});

test("Only validated HTTP and HTTPS rows offer a browser action, including after changes to a listener",async t=>{
  const dir=await temp("web-ports"), cert=path.join(dir,"cert.pem"), keyFile=path.join(dir,"key.pem");
  await run(path.join(process.env.ProgramFiles,"Git/usr/bin/openssl.exe"),["req","-x509","-newkey","rsa:2048","-keyout",keyFile,"-out",cert,"-sha256","-days","1","-nodes","-subj","/CN=localhost"]);
  const sockets=new Set(), servers=[];
  const listen=async server=>{
    servers.push(server);
    server.on("connection",s=>{
      sockets.add(s);
      s.on("close",()=>sockets.delete(s));
      // The fixture intentionally receives probes using the wrong protocol.
      s.on("error", error => { if (error.code !== "ECONNRESET") throw error; });
    });
    await new Promise((ok,fail)=>server.once("error",fail).listen(0,"127.0.0.1",ok));
    return {pid:process.pid,process:"test",bind:"127.0.0.1",port:server.address().port};
  };
  t.after(()=>{for(const s of sockets)s.destroy();for(const server of servers)if(server.listening)server.close();});
  const web=await listen(http.createServer((req,res)=>{assert.equal(req.method,"HEAD");res.writeHead(405);res.end();}));
  const tls=await listen(https.createServer({key:await readFile(keyFile),cert:await readFile(cert)},(req,res)=>{res.writeHead(200);res.end();}));
  const raw=await listen(createServer(s=>s.end("database ready\r\n")));
  const stoppedServer=createServer(), stopped=await listen(stoppedServer);await new Promise(ok=>stoppedServer.close(ok));
  let ports=[web,tls,raw,stopped],pending,opened=[];
  const host={checking:()=>false,shared:()=>({qa:{ports}}),props:()=>({portProject:"test",addresses:["qa"]}),theme:()=>({}),
    terminals:()=>[],spaces:()=>[],panes:()=>[],agents:()=>[],exec:commandResult};
  const cx={timer:{every(){}},notify(){},spawn:fn=>{pending=fn(cx);},open_url:url=>opened.push(url)};
  const Projects=await filesModel("orca-projects",host), sheet=new Projects();sheet.init(null,cx);
  const controls=()=>flatten(sheet.render(cx)).filter(n=>typeof n==="object"&&typeof n.key==="string"&&n.key.startsWith("browse-"));
  const id=p=>"browse-"+p.bind+p.port+p.pid;
  assert.deepEqual(controls(),[],"No actions while protocol is unknown");
  await pending;
  assert.deepEqual(controls().map(x=>x.key).sort(),[id(web),id(tls)].sort());
  for(const p of [web,tls]){
    controls().find(n=>n.key===id(p)).click(null,cx);await pending;
  }
  assert.deepEqual(opened,["http://127.0.0.1:"+web.port+"/","https://127.0.0.1:"+tls.port+"/"]);
  sheet.browse(raw,cx);assert.equal(opened.length,2);
  const staleControl=controls().find(n=>n.key===id(web));
  ports=[{...web,pid:web.pid+1},tls,raw,stopped];staleControl.click(null,cx);await pending;
  assert.equal(opened.length,2);assert.ok(!controls().some(n=>n.key===id(web)));await pending;
  assert.equal(browserHost({port:3000,bind:"0.0.0.0"}),"127.0.0.1");assert.equal(browserHost({port:3000,bind:"::"}),"[::1]");
  assert.equal(browserHost({port:3000,bind:"[::1]"}),"[::1]");assert.throws(()=>browserHost({port:3000,bind:"invalid.host"}));
  for(const port of [80,443,3000,8080]) await assert.rejects(webAddress({...raw,port},async()=>({code:1,stdout:"000"}),()=>true),/did not answer/);
});

test("Three status groups show only pending work and pushing clears committed files",async()=>{
  const root=await temp("push"), repo=path.join(root,"repo"), bare=path.join(root,"remote.git"), peer=path.join(root,"peer");
  await mkdir(repo);await git(repo,"init","-q","-b","main");
  const identity=async dir=>{await git(dir,"config","user.name","Fixture");await git(dir,"config","user.email","fixture@example.test");};
  await identity(repo);
  const read=a=>commandResult(gitExe,["-C",repo,...a]), put=s=>writeFile(path.join(repo,"file.txt"),s);
  assert.deepEqual(await committedFiles(read,await pushInfo(read)),[]);assert.match((await pushInfo(read)).message,/first commit/);
  await put("first\n");await git(repo,"add",".");await git(repo,"commit","-qm","First commit");
  assert.match((await pushInfo(read)).message,/remote/);
  assert.deepEqual((await committedFiles(read,await pushInfo(read))).map(f=>f.path),["file.txt"]);
  await git(root,"init","--bare","-q","-b","main",bare);await git(repo,"remote","add","origin",bare);
  let state=await pushInfo(read);assert.ok(state.ready && state.track);assert.equal(await pushBranch(read,state),"Pushed to origin/main");
  assert.equal((await pushInfo(read)).ready,false);
  await writeFile(path.join(repo,"earlier.txt"),"earlier outgoing commit");await git(repo,"add","earlier.txt");await git(repo,"commit","-qm","Earlier outgoing");
  await put("second\n");await git(repo,"commit","-qam","Second commit");
  await put("staged edit\n");await git(repo,"add","file.txt");await put("working edit\n");await writeFile(path.join(repo,"extra.txt"),"extra\n");
  const dirty=await git(repo,"status","--porcelain=v1","-z");const oid=(await git(repo,"rev-parse","HEAD")).trim();
  state=await pushInfo(read);assert.equal(state.ahead,2);
  const host={spaces:()=>[{active:true,folder:repo}],panes:()=>[],focused:()=>null,window:()=>({platform:"windows"}),theme:()=>({}),settings:()=>({}),shared:()=>null,
    exec:(cmd,args,opts)=>commandResult(cmd,args,{cwd:opts.cwd}),readTextFile:f=>readFile(f,"utf8")};
  const Changes=await filesModel("orca-changes",host), panel=new Changes();
  let pending;const cx={notify(){},timer:{every(){}},spawn:fn=>{pending=fn(cx);}};panel.watch=()=>{};panel.init(null,cx);await pending;
  const labels=()=>flatten(panel.render(cx)).filter(n=>typeof n==="string");
  for(const name of [...sections,"Push branch"]) assert.ok(labels().includes(name),name);
  for(const name of ["Recent commits","First commit","Second commit","Latest commit","Commits","Conflicts"]) assert.ok(!labels().includes(name),name);
  const committed=()=>panel.files.filter(f=>f.section==="Committed").map(f=>f.path);
  assert.deepEqual(committed(),["earlier.txt","file.txt"]);
  assert.deepEqual((await committedFiles(read,{})).map(f=>f.path),["earlier.txt","file.txt"]);
  const view = flatten(panel.render(cx));
  assert.deepEqual(view.filter(n=>typeof n?.key==="string" && n.key.startsWith("group-")).map(n=>n.key),sections.map(s=>"group-"+s));
  assert.ok(!view.some(n=>n?.key==="review-commits" || n?.key==="changes-diff-x"));
  assert.equal(await pushBranch(read,state),"Pushed to origin/main");assert.equal((await git(bare,"rev-parse","refs/heads/main")).trim(),oid);
  assert.equal((await git(repo,"rev-parse","HEAD")).trim(),oid);assert.equal(await git(repo,"status","--porcelain=v1","-z"),dirty);
  panel.refresh(cx);await pending;assert.deepEqual(committed(),[]);assert.ok(labels().includes("Committed"));
  assert.deepEqual(await committedFiles(read,{}),[]);
  await git(root,"clone","-q",bare,peer);await identity(peer);await git(peer,"commit","--allow-empty","-qm","Remote advanced");await git(peer,"push","-q");
  const remoteHead=(await git(bare,"rev-parse","main")).trim();
  await git(repo,"commit","--allow-empty","-qm","Local changes");state=await pushInfo(read);assert.ok(state.ready);
  await git(repo,"commit","--allow-empty","-qm","New local commit");await assert.rejects(pushBranch(read,state),/changed/);
  await assert.rejects(pushBranch(read,await pushInfo(read)),/rejected/);assert.equal((await git(bare,"rev-parse","main")).trim(),remoteHead);
  await git(repo,"fetch","-q");state=await pushInfo(read);assert.ok(state.behind>0&&!state.ready);
  await git(repo,"switch","-q","--detach");assert.match((await pushInfo(read)).message,/Switch to a branch/);
  panel.refresh(cx);await pending;assert.deepEqual(committed(),["file.txt"]);assert.ok(labels().includes("Uncommitted"));
});

test("The inspector's GitHub menu links to the selected repository without forwarding credentials",async()=>{
  let url="git@github.com:octocat/example.git", prop={},pending;
  const opened=[];
  const host={props:()=>prop,theme:()=>({}),checking:()=>false,closeOverlay(){},window:()=>({platform:"windows"}),
    exec:async(_,args)=>({code:0,stdout:args.includes("rev-parse")?"C:/fixture":args.includes("symbolic-ref")?"feature":args.includes("config")?"upstream":url})};
  const cx={notify(){},spawn(fn){pending=fn(cx);},open_url:u=>opened.push(u)};
  const Inspector=await filesModel("orca-inspector",host), panel=new Inspector(), loc={cwd:"C:/fixture",on:null,branch:"feature"};
  for(const candidate of [url,"https://example-user:example-password@github.com/octocat/example.git","ssh://git@github.com/octocat/example.git"]){
    url=candidate;panel.lookup(loc,cx);await pending;assert.equal(panel.github,"https://github.com/octocat/example");
  }
  prop={github:panel.github};const menu=flatten(panel.render(cx));for(const id of ["pulls","issues"])menu.find(n=>typeof n==="object"&&n.key===id).click(null,cx);
  assert.deepEqual(opened,["https://github.com/octocat/example/pulls","https://github.com/octocat/example/issues"]);
  url="https://github.com.example.test/octocat/example.git";prop={};panel.lookup(loc,cx);await pending;assert.equal(panel.github,null);
});

test("Shared host.js stays identical across mods and every mod survives window() returning null",async()=>{
  const hostMods=["orca-projects","orca-changes","orca-files","orca-inspector","orca-add-project","orca-usage"];
  const contents=await Promise.all(hostMods.map(m=>readFile(path.join(home,"mods",m,"host.js"),"utf8")));
  for(const text of contents) assert.equal(text,contents[0]);

  const nullHerdr={
    agents:()=>[],appHome:()=>home,checking:()=>true,closeOverlay(){},exec:async()=>({code:1,stdout:"",stderr:""}),
    focused:()=>null,hc:async()=>({code:1,stdout:"",stderr:""}),home:()=>home,layout:()=>null,
    nextCommand:()=>new Promise(()=>{}),notify(){},openOverlay(){},panes:()=>[],pickFolder:async()=>null,
    props:()=>({}),readTextFile:async()=>null,run(){},setAgentOrder(){},setShared(){},settings:()=>({}),
    shared:()=>null,spaces:()=>[],terminals:()=>[],theme:()=>({}),watchFolder:()=>Object.assign(new Promise(()=>{}),{cancel(){}}),
    window:()=>null,writeTextFile:async()=>null
  };
  const cx={timer:{every(){},after(){}},notify(){},spawn(){},focus_handle:()=>({focus(){}})};
  for(const mod of ["orca-projects","orca-changes","orca-files","orca-inspector","orca-tabs","orca-add-project","orca-agent-actions"]){
    const Mod=await filesModel(mod,nullHerdr);
    const view=new Mod();
    view.init(null,cx);
    assert.ok(view.render(cx),mod+" rendered cleanly when window() returned null");
  }
});

test("Files marks match Windows backslash paths and watchFolder handles cancel cleanly",async()=>{
  const root=await temp("files-marks"),repo=path.join(root,"repo");
  await mkdir(repo);
  await git(repo,"init","-q","-b","main");
  await git(repo,"config","user.name","Fixture");
  await git(repo,"config","user.email","fixture@example.test");
  await writeFile(path.join(repo,"tracked.txt"),"one\n");
  await git(repo,"add","tracked.txt");
  await git(repo,"commit","-qm","init");
  await writeFile(path.join(repo,"tracked.txt"),"two\n");
  await writeFile(path.join(repo,"untracked.txt"),"fresh\n");

  const cancelled=[];
  const pendingOps=[];
  const herdr={
    spaces:()=>[{active:true,id:"s1",folder:repo,machine:null}],
    focused:()=>null,panes:()=>[],home:()=>root,settings:()=>({}),theme:()=>({}),
    window:()=>({platform:"windows"}),
    exec:(cmd,args,opts)=>commandResult(cmd,args,{cwd:opts?.cwd}),
    readTextFile:f=>readFile(f,"utf8"),
    watchFolder:dir=>{
      const p=new Promise(()=>{});
      p.cancel=()=>cancelled.push(dir);
      return p;
    }
  };
  const cx={notify(){},timer:{every(){}},spawn:fn=>{const p=fn(cx);pendingOps.push(p);return p;}};
  const Files=await filesModel("orca-files",herdr),browser=new Files();
  browser.init(null,cx);
  await Promise.all(pendingOps);
  const trackedKey=Object.keys(browser.marks).find(k=>k.endsWith("/tracked.txt"));
  const untrackedKey=Object.keys(browser.marks).find(k=>k.endsWith("/untracked.txt"));
  assert.equal(browser.marks[trackedKey],"M");
  assert.equal(browser.marks[untrackedKey],"A");
  const rendered=flatten(browser.render(cx)).filter(n=>typeof n==="string");
  assert.ok(rendered.includes("M")&&rendered.includes("A"));
  await browser.close();
  assert.equal(cancelled.length,1);
});

test("Changes opens inline diff preview, returns on closePreview, and cancels watchFolder on close",async()=>{
  const root=await temp("changes-diff"),repo=path.join(root,"repo");
  await mkdir(repo);
  await git(repo,"init","-q","-b","main");
  await git(repo,"config","user.name","Fixture");
  await git(repo,"config","user.email","fixture@example.test");
  await writeFile(path.join(repo,"app.js"),"console.log(1);\n");
  await git(repo,"add","app.js");
  await git(repo,"commit","-qm","init");
  await writeFile(path.join(repo,"app.js"),"console.log(2);\n");

  const cancelled=[];
  const openedEditors=[];
  const herdr={
    spaces:()=>[{active:true,folder:repo,machine:null}],
    panes:()=>[],focused:()=>null,window:()=>({platform:"windows"}),
    theme:()=>({}),settings:()=>({}),shared:()=>null,
    exec:(cmd,args,opts)=>commandResult(cmd,args,{cwd:opts?.cwd}),
    readTextFile:f=>readFile(f,"utf8"),
    watchFolder:dir=>{
      const p=new Promise(()=>{});
      p.cancel=()=>cancelled.push(dir);
      return p;
    }
  };
  let lastSpawn;
  const cx={notify(){},timer:{every(){}},spawn:fn=>{lastSpawn=fn(cx);return lastSpawn;}};
  const Changes=await filesModel("orca-changes",herdr,{EditorState:{new:opts=>{openedEditors.push(opts);return{release(){}};}}});
  const panel=new Changes();
  panel.init(null,cx);
  await lastSpawn;
  const file=panel.files.find(f=>f.path==="app.js"&&f.section==="Uncommitted");
  assert.ok(file);
  panel.openFile(file,cx);
  await lastSpawn;
  assert.equal(openedEditors.length,1);
  assert.equal(openedEditors[0].language,"diff");
  assert.match(openedEditors[0].value,/\+console\.log\(2\);/);
  const previewText=flatten(panel.render(cx)).filter(n=>typeof n==="string");
  assert.ok(previewText.includes("app.js")&&previewText.includes("Uncommitted"));
  panel.closePreview(cx);
  assert.equal(panel.preview,null);
  await panel.close();
  assert.equal(cancelled.length,1);
});

test("Repository URL parser strips git clone prefix and rejects credentials and invalid paths",()=>{
  assert.deepEqual(repository("git clone https://github.com/owner/repo.git"),{url:"https://github.com/owner/repo.git",name:"repo"});
  assert.deepEqual(repository("git@github.com:owner/my-app.git/"),{url:"git@github.com:owner/my-app.git",name:"my-app"});
  assert.throws(()=>repository("https://user@github.com/owner/repo.git"),/without embedded credentials/);
  assert.throws(()=>repository("https://user:pass@github.com/owner/repo.git"),/host and port/);
  assert.throws(()=>repository("https://github.com/owner/con.git"),/folder/);
  assert.throws(()=>repository("not a url"),/HTTPS or SSH/);
});

test("Usage renders cleanly when provider CLIs are unavailable",async()=>{
  let sharedMap={};
  const herdr={
    appHome:()=>home,checking:()=>false,closeOverlay(){},
    exec:async()=>({code:1,stdout:"",stderr:"not installed"}),
    home:()=>home,nextCommand:()=>new Promise(()=>{}),openOverlay(){},
    props:()=>({}),readTextFile:async()=>null,run(){},
    shared:k=>sharedMap[k],setShared:(k,v)=>{sharedMap[k]=v;},
    theme:()=>({}),window:()=>({platform:"windows"}),writeTextFile:async()=>null
  };
  const { snapshot } = await modImport("orca-usage", "account.js", herdr);
  const snap=await snapshot();
  assert.deepEqual(snap.groups,[]);
  assert.equal(snap.codex.available,false);
  assert.equal(snap.google.available,false);
  sharedMap["orca.account.summary"]=snap;
  const Usage=await filesModel("orca-usage",herdr),bar=new Usage();
  let refreshed;
  const refreshDone = new Promise(resolve => { refreshed = resolve; });
  const cx={timer:{every(){},after(){}},notify(){if (!bar.busy) refreshed();},spawn:fn=>fn(cx)};
  bar.init(null,cx);
  await refreshDone;
  const labels=flatten(bar.render(cx)).filter(n=>typeof n==="string");
  assert.ok(labels.includes("No provider CLIs signed in"));
  assert.ok(labels.includes("Usage"));
});
