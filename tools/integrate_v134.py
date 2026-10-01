from pathlib import Path
import re

APP = Path("app.js")
INDEX = Path("index.html")
STYLES = Path("styles.css")
SW = Path("sw.js")


def replace_function(source: str, start_marker: str, end_marker: str, replacement: str) -> str:
    start = source.find(start_marker)
    if start < 0:
        raise RuntimeError(f"Start marker not found: {start_marker}")
    end = source.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"End marker not found: {end_marker}")
    return source[:start] + replacement.rstrip() + "\n\n" + source[end:]


s = APP.read_text(encoding="utf-8")

# -----------------------------------------------------------------------------
# 1. Shared state and team-hour helpers
# -----------------------------------------------------------------------------
if "projectSpend: {}" not in s:
    s = s.replace(
        "pendingReceiptItems: [], editingExpenseId: null, existingReceiptUrl: null",
        "pendingReceiptItems: [], editingExpenseId: null, existingReceiptUrl: null, projectSpend: {}",
    )

if "const crewCount =" not in s:
    needle = '  const hoursLabel = mins => { const h=Math.floor((mins||0)/60),m=Math.round((mins||0)%60); return m?`${h} h ${String(m).padStart(2,"0")}`:`${h} h`; };\n'
    if needle not in s:
        raise RuntimeError("hoursLabel helper not found")
    s = s.replace(
        needle,
        needle
        + '  const crewCount = x => Math.min(5,Math.max(1,Number(x?.crew_count||1)));\n'
        + '  const effectiveMinutes = x => Number(x?.minutes||0)*crewCount(x);\n',
        1,
    )

# Old local records count as one person.
if "state.workLogs=(state.workLogs||[]).map" not in s:
    needle = '    state.expenses=(state.expenses||[]).map(x=>({...x,items:Array.isArray(x.items)?x.items:[],paid_by_user_id:x.paid_by_user_id||x.user_id||"demo"}));\n'
    if needle not in s:
        raise RuntimeError("local migration marker not found")
    s = s.replace(
        needle,
        needle + '    state.workLogs=(state.workLogs||[]).map(x=>({...x,crew_count:crewCount(x)}));\n',
        1,
    )

# -----------------------------------------------------------------------------
# 2. Load the spent amount for every visible project
# -----------------------------------------------------------------------------
s = replace_function(
    s,
    "  async function loadCloudData(){",
    "  async function loadCurrentProjectData(){",
    '''  async function loadCloudData(){
    const [projectsResult,expensesResult]=await Promise.all([
      sb.from("projects_visible").select("*").order("created_at",{ascending:true}),
      sb.from("expenses").select("project_id,amount")
    ]);
    const {data:projects,error}=projectsResult;
    if(error){toast("Impossible de charger les projets");console.error(error);return;}
    if(expensesResult.error)console.error(expensesResult.error);
    state.projects=projects||[];
    state.projectSpend=(expensesResult.data||[]).reduce((g,x)=>{g[x.project_id]=(g[x.project_id]||0)+Number(x.amount||0);return g;},{});
    if(!state.currentProjectId||!state.projects.some(p=>p.id===state.currentProjectId))state.currentProjectId=state.projects[0]?.id||null;
    if(!state.currentProjectId){ await createProjectCloud({name:"Mon premier chantier",address:"",budget:0}); return loadCloudData(); }
    await loadCurrentProjectData();
  }''',
)

needle = '    state.workLogs=w.data||[]; state.team=t.data||[]; state.lots=(state.lots||[]).filter(x=>x.project_id!==pid).concat(l.data||[]);\n'
if needle not in s:
    raise RuntimeError("loadCurrentProjectData tail not found")
replacement = needle + '    state.projectSpend=state.projectSpend||{};state.projectSpend[pid]=state.expenses.reduce((sum,x)=>sum+Number(x.amount||0),0);\n'
if replacement not in s:
    s = s.replace(needle, replacement, 1)

# -----------------------------------------------------------------------------
# 3. Effective hours = duration x crew_count, including theoretical labor cost
# -----------------------------------------------------------------------------
s = replace_function(
    s,
    "  function totals(){",
    "  function expenseBreakdownByLot(){",
    '''  function totals(){
    const expenses=projectExpenses().reduce((sum,x)=>sum+Number(x.amount||0),0);
    const minutes=projectLogs().reduce((sum,x)=>sum+effectiveMinutes(x),0);
    const labor=projectLogs().reduce((sum,x)=>sum+(effectiveMinutes(x)/60)*Number(x.hourly_rate||0),0);
    return {expenses,minutes,labor,total:expenses+labor};
  }''',
)

s = re.sub(
    r'  function timeBreakdownByLot\(\)\{.*?\n',
    '  function timeBreakdownByLot(){ const g={};projectLogs().forEach(x=>g[x.lot||"Divers"]=(g[x.lot||"Divers"]||0)+effectiveMinutes(x)/60);return g; }\n',
    s,
    count=1,
)
s = re.sub(
    r'  function laborBreakdownByLot\(\)\{.*?\n',
    '  function laborBreakdownByLot(){ const g={};projectLogs().forEach(x=>g[x.lot||"Divers"]=(g[x.lot||"Divers"]||0)+(effectiveMinutes(x)/60)*Number(x.hourly_rate||0));return g; }\n',
    s,
    count=1,
)

# Time list shows effective hours and, when useful, the detail 8h x 2 people.
s = replace_function(
    s,
    "  function renderTime(){",
    "  function renderBilan(){",
    '''  function renderTime(){
    const start=weekStart(state.weekOffset),end=new Date(start);end.setDate(end.getDate()+6);$("#weekLabel").textContent=`${fmtDate(dateISO(start))} — ${fmtDate(dateISO(end))}`;const today=dateISO();
    $("#weekDays").innerHTML=[0,1,2,3,4,5,6].map(i=>{const d=new Date(start);d.setDate(d.getDate()+i);const iso=dateISO(d);return `<div class="day-chip ${iso===today?"active":""}"><span>${["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"][i]}</span><strong>${d.getDate()}</strong></div>`}).join("");
    const startIso=dateISO(start),endIso=dateISO(end),logs=projectLogs().filter(x=>x.date>=startIso&&x.date<=endIso).sort((a,b)=>a.date.localeCompare(b.date)||String(a.start_time).localeCompare(String(b.start_time)));
    $("#timeList").innerHTML=logs.length?logs.map(x=>{const c=crewCount(x),eff=effectiveMinutes(x),detail=c>1?`<small class="v13-crew-detail">${hoursLabel(x.minutes)} × ${c} personnes</small>`:"";return `<div class="list-card"><div class="list-icon">◷</div><div class="list-main"><strong>${escapeHtml(x.task)}</strong><small>${fmtDate(x.date)} · ${escapeHtml(x.lot)} · ${x.start_time?.slice(0,5)||""}${x.end_time?` → ${x.end_time.slice(0,5)}`:""} · ${money(x.hourly_rate)}/h</small>${detail}</div><div class="list-value">${hoursLabel(eff)}<br><button class="text-btn danger delete-time" data-id="${x.id}">Suppr.</button></div></div>`}).join(""):`<div class="empty-state">Aucune heure cette semaine.</div>`;
    $$(".delete-time").forEach(b=>b.onclick=()=>deleteTime(b.dataset.id));
  }''',
)

# -----------------------------------------------------------------------------
# 4. Project cards: spent amount + delete action
# -----------------------------------------------------------------------------
s = replace_function(
    s,
    "  function renderProjects(){",
    "  function lotUsage(name){",
    '''  function renderProjects(){
    const localSpend=(state.expenses||[]).reduce((g,x)=>{g[x.project_id]=(g[x.project_id]||0)+Number(x.amount||0);return g;},{});
    $("#projectList").innerHTML=state.projects.map(p=>{
      const isCurrent=p.id===state.currentProjectId;
      const currentSpent=isCurrent?projectExpenses().reduce((sum,x)=>sum+Number(x.amount||0),0):null;
      const spent=currentSpent??(mode==="cloud"?Number(state.projectSpend?.[p.id]||0):Number(localSpend[p.id]||0));
      const canDelete=mode!=="cloud"||["owner","admin"].includes(p.role);
      return `<article class="project-card ${isCurrent?"active":""}"><div><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.address||"Adresse non renseignée")}</p></div><div class="project-meta"><div><small>Dépensé</small><br><strong>${money(spent)}</strong></div><div class="v13-project-actions"><button class="btn secondary compact choose-project" data-id="${p.id}">${isCurrent?"Actif":"Ouvrir"}</button>${canDelete?`<button class="btn compact v13-danger delete-project" data-id="${p.id}">Supprimer</button>`:""}</div></div></article>`;
    }).join("");
    $$(".choose-project").forEach(b=>b.onclick=()=>switchProject(b.dataset.id));
    $$(".delete-project").forEach(b=>b.onclick=()=>deleteProject(b.dataset.id));
  }''',
)

# Core delete function. Supabase RPC remains the security boundary.
switch_marker = '  async function switchProject(id){state.currentProjectId=id;if(mode==="cloud")await loadCurrentProjectData();else localSave();renderAll();navigate("home");}\n'
if switch_marker not in s:
    raise RuntimeError("switchProject marker not found")
if "async function deleteProject(id)" not in s:
    delete_fn = '''  async function deleteProject(id){
    const p=state.projects.find(x=>x.id===id),name=p?.name||"ce projet";
    if(!confirm(`Supprimer définitivement « ${name} » ?\\n\\nDépenses, heures, lots, membres et tickets seront supprimés. Cette action est irréversible.`))return;
    if(mode==="cloud"){
      const {data:receipts,error:receiptError}=await sb.from("expenses").select("receipt_path").eq("project_id",id);
      if(receiptError)console.error(receiptError);
      const paths=(receipts||[]).map(x=>x.receipt_path).filter(Boolean);
      if(paths.length){const storageResult=await sb.storage.from("receipts").remove(paths);if(storageResult.error)console.warn(storageResult.error);}
      const {data:result,error}=await sb.rpc("delete_project",{p_project_id:id});
      if(error)return toast(error.message);
      if(result!=="deleted")return toast(result||"Suppression impossible.");
      if(state.currentProjectId===id)state.currentProjectId=null;
      await loadCloudData();
    }else{
      state.projects=state.projects.filter(x=>x.id!==id);state.expenses=state.expenses.filter(x=>x.project_id!==id);state.workLogs=state.workLogs.filter(x=>x.project_id!==id);state.lots=state.lots.filter(x=>x.project_id!==id);
      if(state.currentProjectId===id)state.currentProjectId=state.projects[0]?.id||null;
      if(!state.projects.length){const newId=uid();state.projects=[{id:newId,name:"Mon chantier",address:"",budget:0,role:"owner",created_at:new Date().toISOString()}];state.currentProjectId=newId;state.lots=DEFAULT_LOTS.map(name=>({id:uid(),project_id:newId,name,budget:0,hourly_rate:45}));}
      localSave();
    }
    renderAll();navigate("projects");toast("Projet supprimé.");
  }
'''
    s = s.replace(switch_marker, switch_marker + delete_fn, 1)

# -----------------------------------------------------------------------------
# 5. Manual time entry + timer store crew_count
# -----------------------------------------------------------------------------
old_time = '$("#timeForm").onsubmit=async e=>{e.preventDefault();const start=$("#timeStart").value,end=$("#timeEnd").value,override=Number($("#timeDurationOverride").value||0),mins=override?Math.round(override*60):minutesBetween(start,end);if(mins<=0)return toast("La durée doit être supérieure à zéro.");const ok=await addTime({date:$("#timeDate").value,start_time:start||null,end_time:end||null,minutes:mins,lot:$("#timeLot").value,task:$("#timeTask").value.trim(),hourly_rate:Number($("#timeRate").value||0),notes:$("#timeNotes").value.trim()});if(ok){e.currentTarget.reset();setFormDefaults();closeOverlays();toast("Temps enregistré.");}};'
new_time = '$("#timeForm").onsubmit=async e=>{e.preventDefault();const start=$("#timeStart").value,end=$("#timeEnd").value,override=Number($("#timeDurationOverride").value||0),mins=override?Math.round(override*60):minutesBetween(start,end),crew=Math.min(5,Math.max(1,Number($("#timeCrewCount")?.value||1)));if(mins<=0)return toast("La durée doit être supérieure à zéro.");const ok=await addTime({date:$("#timeDate").value,start_time:start||null,end_time:end||null,minutes:mins,crew_count:crew,lot:$("#timeLot").value,task:$("#timeTask").value.trim(),hourly_rate:Number($("#timeRate").value||0),notes:$("#timeNotes").value.trim()});if(ok){e.currentTarget.reset();setFormDefaults();closeOverlays();toast(`${hoursLabel(mins*crew)} enregistrées (${hoursLabel(mins)} × ${crew}).`);}};'
if old_time not in s:
    raise RuntimeError("time form submit block not found")
s = s.replace(old_time, new_time, 1)

s = replace_function(
    s,
    "  function startTimer(){",
    "  function updateTimer(){",
    '''  function startTimer(){
    if(state.timer){stopTimer();return;}const lots=projectLots();if(!lots.length)return toast("Ajoute d'abord un lot au projet.");const list=lots.map((l,i)=>`${i+1}. ${l.name}`).join("\\n");const choice=Number(prompt(`Choisis le numéro du lot :\\n${list}`,"1"));const lotObj=lots[choice-1];if(!lotObj)return toast("Lot invalide.");const task=prompt("Tâche réalisée :","Travaux chantier");if(!task)return;const crew=Math.min(5,Math.max(1,Number(prompt("Combien de personnes ? (1 à 5)","1")||1))),rate=Number(lotObj.hourly_rate??45);state.timer={startedAt:Date.now(),lot:lotObj.name,task,rate,date:dateISO(),crew_count:crew};$("#timerTaskLabel").textContent=`${lotObj.name} · ${task} · ${crew} pers. · ${money(rate)}/h`;$("#timerToggle").textContent="■";updateTimer();state.timerInterval=setInterval(updateTimer,1000);closeOverlays();navigate("time");
  }''',
)

s = replace_function(
    s,
    "  async function stopTimer(){",
    "  function navigate(view){",
    '''  async function stopTimer(){if(!state.timer)return;clearInterval(state.timerInterval);const mins=Math.max(1,Math.round((Date.now()-state.timer.startedAt)/60000)),t=state.timer;state.timer=null;$("#timerToggle").textContent="▶";$("#timerDisplay").textContent="00:00:00";$("#timerTaskLabel").textContent="Sélectionne une tâche puis démarre.";await addTime({date:t.date,start_time:null,end_time:null,minutes:mins,crew_count:t.crew_count||1,lot:t.lot,task:t.task,hourly_rate:t.rate,notes:"Chronométré avec Bati'Coût"});toast(`Chrono enregistré : ${hoursLabel(mins*(t.crew_count||1))}`);}''',
)

old_defaults = '  function setFormDefaults(){$("#expenseDate").value=dateISO();$("#timeDate").value=dateISO();$("#timeStart").value="08:00";$("#timeEnd").value="12:00";renderLotControls();renderPayerControl();applyLotRate(true);}'
new_defaults = '  function setFormDefaults(){$("#expenseDate").value=dateISO();$("#timeDate").value=dateISO();$("#timeStart").value="08:00";$("#timeEnd").value="12:00";if($("#timeCrewCount"))$("#timeCrewCount").value="1";renderLotControls();renderPayerControl();applyLotRate(true);}'
if old_defaults in s:
    s = s.replace(old_defaults, new_defaults, 1)

old_csv = 'projectLogs().forEach(x=>rows.push(["TEMPS",x.date,x.lot,x.task,x.notes||"","","",(x.minutes/60).toFixed(2),x.hourly_rate,((x.minutes/60)*x.hourly_rate).toFixed(2),lotByName(x.lot)?.budget||0]));'
new_csv = 'projectLogs().forEach(x=>rows.push(["TEMPS",x.date,x.lot,x.task,`${x.notes||""}${crewCount(x)>1?` · ${crewCount(x)} personnes`:""}`,"","",(effectiveMinutes(x)/60).toFixed(2),x.hourly_rate,((effectiveMinutes(x)/60)*x.hourly_rate).toFixed(2),lotByName(x.lot)?.budget||0]));'
if old_csv not in s:
    raise RuntimeError("CSV time row not found")
s = s.replace(old_csv, new_csv, 1)

APP.write_text(s, encoding="utf-8")

# -----------------------------------------------------------------------------
# 6. Static UI styles (no runtime patch needed)
# -----------------------------------------------------------------------------
css = STYLES.read_text(encoding="utf-8")
marker = "/* V1.3.4 core project/time controls */"
if marker not in css:
    css += '''

/* V1.3.4 core project/time controls */
.btn.v13-danger{background:#F6DED5;color:#9F3E24;border:1px solid rgba(214,106,74,.25)}
.v13-project-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.v13-crew-detail{display:block;color:#6E746F;font-size:10px;font-weight:700;margin-top:3px}
.v13-crew-field select{font-weight:800;color:#0D1B2A}
@media(max-width:560px){.project-meta{gap:12px}.v13-project-actions{max-width:64%;justify-content:flex-end}.v13-project-actions .btn{padding:9px 10px;font-size:12px}}
'''
STYLES.write_text(css, encoding="utf-8")

# -----------------------------------------------------------------------------
# 7. Remove the temporary patch layer and force new assets on Safari/PWA
# -----------------------------------------------------------------------------
html = INDEX.read_text(encoding="utf-8")
html = re.sub(r'href="styles\.css(?:\?v=[^"]+)?"', 'href="styles.css?v=1.3.4"', html)
html = re.sub(r'<div class="hero-badge" id="heroBadge">.*?</div>', '<div class="hero-badge" id="heroBadge">V1.3.4</div>', html, count=1)
html = re.sub(r'<script src="app\.js(?:\?v=[^"]+)?"></script>', '<script src="app.js?v=1.3.4"></script>', html)
html = re.sub(r'\s*<script src="v1_3_patch\.js(?:\?v=[^"]+)?"></script>', '', html)
INDEX.write_text(html, encoding="utf-8")

sw = '''const CACHE="baticout-v1.3.4";
const SHELL=["./","./index.html","./styles.css?v=1.3.4","./app.js?v=1.3.4","./config.js","./manifest.json","./assets/logo-mark.svg","./assets/icon-192.png","./assets/icon-512.png"];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin)return;
  event.respondWith(
    fetch(event.request).then(response=>{
      if(response&&response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}
      return response;
    }).catch(async()=>{
      const cached=await caches.match(event.request);
      if(cached)return cached;
      if(event.request.mode==="navigate")return caches.match("./index.html");
      throw new Error("Offline and resource not cached");
    })
  );
});
'''
SW.write_text(sw, encoding="utf-8")

# Sanity assertions used by the workflow and useful locally too.
final_app = APP.read_text(encoding="utf-8")
assert '<small>Dépensé</small>' in final_app
assert 'delete-project' in final_app
assert 'crew_count:crew' in final_app
assert 'effectiveMinutes(x)' in final_app
assert 'async function deleteProject(id)' in final_app
assert 'v1_3_patch.js' not in INDEX.read_text(encoding="utf-8")
assert 'baticout-v1.3.4' in SW.read_text(encoding="utf-8")
print("Bati'Coût V1.3.4 core integration complete")
