(() => {
  "use strict";

  const cfg = window.BATICOUT_CONFIG || {};
  const cloudEnabled = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
  const sb = cloudEnabled ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

  const DEFAULT_LOTS = ["Terrassement","Gros œuvre","Maçonnerie","Charpente","Couverture","Menuiseries","Isolation","Placo","Électricité","Plomberie","Chauffage","Carrelage","Peinture","Aménagement extérieur","Divers"];
  const COLORS = ["#8FA17A","#C4B5FD","#D66A4A","#0D1B2A","#D9C7A7","#7E9EB3","#B88E78","#A7B68F"];
  const STORAGE_KEY = "baticout_v1";

  let mode = cloudEnabled ? "cloud" : "local";
  let session = null;
  let deferredInstallPrompt = null;
  let state = {
    projects: [], currentProjectId: null, expenses: [], workLogs: [], team: [], lots: [],
    weekOffset: 0, bilanMode: "global", timer: null, timerInterval: null, charts: {},
    pendingReceiptItems: [], editingExpenseId: null, existingReceiptUrl: null
  };

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const money = n => new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR",maximumFractionDigits:2}).format(Number(n||0));
  const pct = n => `${Math.round(Number(n||0))} %`;
  const hoursLabel = mins => { const h=Math.floor((mins||0)/60),m=Math.round((mins||0)%60); return m?`${h} h ${String(m).padStart(2,"0")}`:`${h} h`; };
  const dateISO = d => { const x=d?new Date(d):new Date(); const local=new Date(x.getTime()-x.getTimezoneOffset()*60000); return local.toISOString().slice(0,10); };
  const fmtDate = iso => !iso ? "" : new Intl.DateTimeFormat("fr-FR",{day:"2-digit",month:"short",year:"numeric"}).format(new Date(iso+"T12:00:00"));
  const roleLabel = r => ({owner:"Propriétaire",admin:"Administrateur",member:"Membre",viewer:"Lecture seule"}[r]||r);

  function toast(msg){ const el=$("#toast"); el.textContent=msg; el.classList.add("show"); clearTimeout(el._timer); el._timer=setTimeout(()=>el.classList.remove("show"),3200); }
  function show(id){ $(id)?.classList.remove("hidden"); }
  function hide(id){ $(id)?.classList.add("hidden"); }
  function closeOverlays(){ $$(".sheet-backdrop,.modal-backdrop").forEach(x=>x.classList.add("hidden")); }

  function currentProject(){ return state.projects.find(p=>p.id===state.currentProjectId)||null; }
  function projectExpenses(){ return state.expenses.filter(x=>x.project_id===state.currentProjectId); }
  function projectLogs(){ return state.workLogs.filter(x=>x.project_id===state.currentProjectId); }
  function projectLots(){ return state.lots.filter(x=>x.project_id===state.currentProjectId).sort((a,b)=>a.name.localeCompare(b.name,"fr")); }
  function currentUserId(){ return mode==="cloud" ? session?.user?.id : "demo"; }
  function lotByName(name){ return projectLots().find(l=>l.name===name); }
  function lotDefaultRate(name){ const r=Number(lotByName(name)?.hourly_rate); return Number.isFinite(r)?r:45; }
  function budgetTotal(){ return projectLots().reduce((s,l)=>s+Number(l.budget||0),0); }

  function localLoad(){
    const raw=localStorage.getItem(STORAGE_KEY);
    if(raw){ try{ state={...state,...JSON.parse(raw)}; }catch{} }
    if(!state.projects.length){
      const p={id:uid(),name:"Maison Aigueperse",address:"",budget:24000,created_at:new Date().toISOString(),role:"admin"};
      state.projects=[p]; state.currentProjectId=p.id;
      state.lots=DEFAULT_LOTS.map(name=>({id:uid(),project_id:p.id,name,budget:0,hourly_rate:45}));
      const masonry=state.lots.find(l=>l.name==="Maçonnerie"); if(masonry){masonry.budget=8000;masonry.hourly_rate=48;}
      const elec=state.lots.find(l=>l.name==="Électricité"); if(elec){elec.budget=4500;elec.hourly_rate=52;}
      const plumbing=state.lots.find(l=>l.name==="Plomberie"); if(plumbing){plumbing.budget=3500;plumbing.hourly_rate=55;}
      const today=dateISO();
      state.team=[{user_id:"demo",id:"demo",email:"mode.demo@local",display_name:"Vous",role:"admin"}];
      state.expenses=[
        {id:uid(),project_id:p.id,user_id:"demo",paid_by_user_id:"demo",merchant:"Bricomarché",date:today,amount:83.40,vat:13.90,category:"Matériaux",lot:"Maçonnerie",description:"Ticket quincaillerie",items:[
          {id:uid(),description:"Ciment",amount:42.50,lot:"Maçonnerie"},{id:uid(),description:"Gaines ICTA",amount:40.90,lot:"Électricité"}
        ],created_at:new Date().toISOString()},
        {id:uid(),project_id:p.id,user_id:"demo",paid_by_user_id:"demo",merchant:"Rexel",date:today,amount:126.80,vat:21.13,category:"Matériaux",lot:"Électricité",description:"Gaines et boîtes",items:[],created_at:new Date().toISOString()}
      ];
      state.workLogs=[
        {id:uid(),project_id:p.id,date:today,start_time:"08:00",end_time:"12:00",minutes:240,lot:"Maçonnerie",task:"Élévation murs",hourly_rate:48,notes:""},
        {id:uid(),project_id:p.id,date:today,start_time:"14:00",end_time:"17:00",minutes:180,lot:"Électricité",task:"Passage des gaines",hourly_rate:52,notes:""}
      ];
    }
    migrateLocalState();
    localSave();
  }

  function migrateLocalState(){
    state.expenses=(state.expenses||[]).map(x=>({...x,items:Array.isArray(x.items)?x.items:[],paid_by_user_id:x.paid_by_user_id||x.user_id||"demo"}));
    if(!Array.isArray(state.lots)) state.lots=[];
    if(!Array.isArray(state.team)||!state.team.length) state.team=[{user_id:"demo",id:"demo",email:"mode.demo@local",display_name:"Vous",role:"admin"}];
    state.team=state.team.map(m=>({...m,user_id:m.user_id||m.id}));
    for(const p of state.projects){
      const used=[...DEFAULT_LOTS];
      state.expenses.filter(x=>x.project_id===p.id).forEach(x=>{ if(x.lot)used.push(x.lot); (x.items||[]).forEach(i=>i.lot&&used.push(i.lot)); });
      state.workLogs.filter(x=>x.project_id===p.id).forEach(x=>x.lot&&used.push(x.lot));
      for(const name of [...new Set(used)]){
        let lot=state.lots.find(l=>l.project_id===p.id&&l.name.toLowerCase()===name.toLowerCase());
        if(!lot){ lot={id:uid(),project_id:p.id,name,budget:0,hourly_rate:45}; state.lots.push(lot); }
        if(lot.budget==null)lot.budget=0;
        if(lot.hourly_rate==null){
          const matching=state.workLogs.filter(w=>w.project_id===p.id&&w.lot===lot.name&&Number(w.hourly_rate)>=0);
          lot.hourly_rate=matching.length?matching.reduce((s,w)=>s+Number(w.hourly_rate||0),0)/matching.length:45;
        }
      }
    }
  }
  function localSave(){
    const safe={projects:state.projects,currentProjectId:state.currentProjectId,expenses:state.expenses,workLogs:state.workLogs,team:state.team,lots:state.lots,weekOffset:state.weekOffset,bilanMode:state.bilanMode};
    localStorage.setItem(STORAGE_KEY,JSON.stringify(safe));
  }

  async function boot(){
    bindUI();
    if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});
    if(cloudEnabled){
      const {data}=await sb.auth.getSession(); session=data.session;
      sb.auth.onAuthStateChange((_e,s)=>{session=s;if(s)enterCloud();else showAuth();});
      if(session) await enterCloud(); else showAuth();
    } else { showAuth(); if($("#syncStatus")) $("#syncStatus").textContent="Mode local"; }
  }
  function showAuth(){ hide("#appShell"); show("#authScreen"); }
  async function enterCloud(){ mode="cloud";hide("#authScreen");show("#appShell");$("#syncStatus").textContent="Synchronisé";await loadCloudData();renderAll(); }
  function enterLocal(){ mode="local";session={user:{id:"demo",email:"demo@local"}};localLoad();hide("#authScreen");show("#appShell");$("#syncStatus").textContent="Mode local";renderAll(); }

  async function loadCloudData(){
    const {data:projects,error}=await sb.from("projects_visible").select("*").order("created_at",{ascending:true});
    if(error){toast("Impossible de charger les projets");console.error(error);return;}
    state.projects=projects||[];
    if(!state.currentProjectId||!state.projects.some(p=>p.id===state.currentProjectId))state.currentProjectId=state.projects[0]?.id||null;
    if(!state.currentProjectId){ await createProjectCloud({name:"Mon premier chantier",address:"",budget:0}); return loadCloudData(); }
    await loadCurrentProjectData();
  }
  async function loadCurrentProjectData(){
    if(mode!=="cloud"||!state.currentProjectId)return;
    const pid=state.currentProjectId;
    const [e,w,t,l]=await Promise.all([
      sb.from("expenses").select("*,expense_items(*)").eq("project_id",pid).order("date",{ascending:false}),
      sb.from("work_logs").select("*").eq("project_id",pid).order("date",{ascending:false}),
      sb.from("project_team_view").select("*").eq("project_id",pid),
      sb.from("project_lots").select("*").eq("project_id",pid).order("name",{ascending:true})
    ]);
    [e,w,t,l].forEach(r=>r.error&&console.error(r.error));
    state.expenses=(e.data||[]).map(x=>({...x,items:x.expense_items||[]}));
    state.workLogs=w.data||[]; state.team=t.data||[]; state.lots=(state.lots||[]).filter(x=>x.project_id!==pid).concat(l.data||[]);
  }

  function totals(){
    const expenses=projectExpenses().reduce((s,x)=>s+Number(x.amount||0),0);
    const minutes=projectLogs().reduce((s,x)=>s+Number(x.minutes||0),0);
    const labor=projectLogs().reduce((s,x)=>s+(Number(x.minutes||0)/60)*Number(x.hourly_rate||0),0);
    return {expenses,minutes,labor,total:expenses+labor};
  }
  function expenseBreakdownByLot(){
    const g={};
    projectExpenses().forEach(x=>{
      const items=(x.items||[]).filter(i=>Number(i.amount)>0);
      if(!items.length){ g[x.lot||"Divers"]=(g[x.lot||"Divers"]||0)+Number(x.amount||0); return; }
      const sum=items.reduce((s,i)=>s+Number(i.amount||0),0);
      items.forEach(i=>g[i.lot||x.lot||"Divers"]=(g[i.lot||x.lot||"Divers"]||0)+Number(i.amount||0));
      const remainder=Number(x.amount||0)-sum;
      if(Math.abs(remainder)>0.01)g[x.lot||"Divers"]=(g[x.lot||"Divers"]||0)+remainder;
    });
    return g;
  }
  function budgetBreakdownByLot(){ const g={}; projectLots().forEach(l=>g[l.name]=Number(l.budget||0)); return g; }
  function timeBreakdownByLot(){ const g={};projectLogs().forEach(x=>g[x.lot||"Divers"]=(g[x.lot||"Divers"]||0)+Number(x.minutes||0)/60);return g; }
  function laborBreakdownByLot(){ const g={};projectLogs().forEach(x=>g[x.lot||"Divers"]=(g[x.lot||"Divers"]||0)+(Number(x.minutes||0)/60)*Number(x.hourly_rate||0));return g; }
  function expenseLots(x){ const arr=(x.items||[]).map(i=>i.lot).filter(Boolean); if(x.lot)arr.push(x.lot); return [...new Set(arr)]; }
  function teamMember(userId){ return state.team.find(m=>(m.user_id||m.id)===userId); }
  function payerLabel(x){ const m=teamMember(x.paid_by_user_id||x.user_id); return m?.display_name||m?.email||"Non renseigné"; }
  function payerBreakdown(){ const g={};projectExpenses().forEach(x=>{const k=payerLabel(x);g[k]=(g[k]||0)+Number(x.amount||0)});return g; }

  function renderAll(){ renderHeader();renderLotControls();renderPayerControl();renderDashboard();renderExpenses();renderTime();renderBilan();renderProjects();renderTeam();renderLots(); }
  function renderHeader(){ const p=currentProject();const name=p?.name||"Mon chantier";$("#projectNameHeader").textContent=name;$("#heroProjectName").textContent=name;$("#heroSubtitle").textContent=p?.address||"Tout ce qu'il faut suivre, sans tableur à rallonge."; }

  function renderDashboard(){
    const t=totals(),ex=projectExpenses(),logs=projectLogs(),bt=budgetTotal();
    $("#kpiExpenses").textContent=money(t.expenses);
    $("#kpiExpensesSub").textContent=bt>0?`${pct(t.expenses/bt*100)} du budget lots`:`${ex.length} dépense${ex.length>1?"s":""}`;
    $("#kpiHours").textContent=hoursLabel(t.minutes);$("#kpiHoursSub").textContent=`${logs.length} saisie${logs.length>1?"s":""}`;
    $("#kpiLabor").textContent=money(t.labor);$("#kpiTotalValue").textContent=money(t.total);
    const grouped=expenseBreakdownByLot();drawDoughnut("expenseChart",grouped);
    $("#expenseLegend").innerHTML=Object.entries(grouped).sort((a,b)=>b[1]-a[1]).map(([k,v],i)=>`<div class="legend-item"><span class="legend-dot" style="background:${COLORS[i%COLORS.length]}"></span>${escapeHtml(k)} <strong>${money(v)}</strong></div>`).join("");
    const acts=[...ex.map(x=>({type:"expense",date:x.date,title:x.merchant||x.description||"Dépense",sub:`${expenseLots(x).join(" · ")||"Divers"} · payé par ${payerLabel(x)}`,value:`− ${money(x.amount)}`})),...logs.map(x=>({type:"time",date:x.date,title:x.task||"Temps chantier",sub:`${x.lot} · ${hoursLabel(x.minutes)}`,value:money((x.minutes/60)*x.hourly_rate)}))].sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,6);
    $("#recentActivity").classList.toggle("empty-state",!acts.length);$("#recentActivity").innerHTML=acts.length?acts.map(a=>`<div class="activity-row"><div class="activity-icon">${a.type==="expense"?"€":"◷"}</div><div class="activity-main"><strong>${escapeHtml(a.title)}</strong><small>${fmtDate(a.date)} · ${escapeHtml(a.sub)}</small></div><div class="activity-value">${a.value}</div></div>`).join(""):"Aucune donnée pour le moment.";
  }

  function renderExpenses(){
    const ex=projectExpenses(),q=$("#expenseSearch")?.value?.toLowerCase()||"",lf=$("#expenseLotFilter")?.value||"";
    const filtered=ex.filter(x=>{const lots=expenseLots(x),hay=[x.merchant,x.description,x.category,payerLabel(x),...lots,...(x.items||[]).map(i=>i.description)].join(" ").toLowerCase();return(!lf||lots.includes(lf))&&(!q||hay.includes(q));});
    $("#expenseTotal").textContent=money(ex.reduce((s,x)=>s+Number(x.amount||0),0));const ym=dateISO().slice(0,7);$("#expenseMonth").textContent=money(ex.filter(x=>String(x.date).startsWith(ym)).reduce((s,x)=>s+Number(x.amount||0),0));$("#expenseCount").textContent=ex.length;
    $("#expenseList").innerHTML=filtered.length?filtered.map(x=>{const lots=expenseLots(x);const tags=lots.slice(0,3).map(l=>`<span class="mini-tag">${escapeHtml(l)}</span>`).join("")+(lots.length>3?`<span class="mini-tag">+${lots.length-3}</span>`:"");return `<div class="list-card"><div class="list-icon">€</div><div class="list-main"><strong>${escapeHtml(x.merchant||x.description||"Dépense")}</strong><small>${fmtDate(x.date)} · ${escapeHtml(x.category)} · payé par ${escapeHtml(payerLabel(x))} · ${(x.items||[]).length?`${x.items.length} ligne${x.items.length>1?"s":""}`:"saisie simple"}</small><div class="expense-lots">${tags}</div></div><div class="list-value">${money(x.amount)}<div class="list-actions"><button class="text-btn edit-expense" data-id="${x.id}">Modifier</button><button class="text-btn danger delete-expense" data-id="${x.id}">Suppr.</button></div></div></div>`}).join(""):`<div class="empty-state">Aucune dépense.</div>`;
    $$(".edit-expense").forEach(b=>b.onclick=()=>openExpenseEditor(b.dataset.id));
    $$(".delete-expense").forEach(b=>b.onclick=()=>deleteExpense(b.dataset.id));
    renderExpenseLotFilter();
  }
  function renderExpenseLotFilter(){ const sel=$("#expenseLotFilter");if(!sel)return;const v=sel.value;sel.innerHTML=`<option value="">Tous les lots</option>`+projectLots().map(l=>`<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)}</option>`).join("");if([...sel.options].some(o=>o.value===v))sel.value=v; }

  function renderLotControls(){
    const lots=projectLots();
    [$("#expenseLot"),$("#timeLot")].forEach(sel=>{if(!sel)return;const old=sel.value;sel.innerHTML=lots.map(l=>`<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)}</option>`).join("");if(lots.some(l=>l.name===old))sel.value=old;else if(lots.some(l=>l.name==="Divers"))sel.value="Divers";else if(lots[0])sel.value=lots[0].name;});
    renderReceiptLines();
  }
  function renderPayerControl(){
    const sel=$("#expensePaidBy"); if(!sel)return;
    const old=sel.value; const members=state.team.length?state.team:[{user_id:currentUserId(),display_name:"Vous",email:session?.user?.email||""}];
    sel.innerHTML=members.map(m=>{const id=m.user_id||m.id;return `<option value="${escapeHtml(id)}">${escapeHtml(m.display_name||m.email||"Membre")}</option>`}).join("");
    if([...sel.options].some(o=>o.value===old))sel.value=old;else if([...sel.options].some(o=>o.value===currentUserId()))sel.value=currentUserId();
  }
  function applyLotRate(force=true){
    const lot=$("#timeLot")?.value; if(!lot)return; const rate=lotDefaultRate(lot);
    if(force||!$("#timeRate").value)$("#timeRate").value=rate;
    if($("#timeRateHint"))$("#timeRateHint").textContent=`Taux configuré pour ${lot} : ${money(rate)}/h`;
  }

  function weekStart(offset=0){const d=new Date();const day=(d.getDay()+6)%7;d.setHours(0,0,0,0);d.setDate(d.getDate()-day+offset*7);return d;}
  function renderTime(){
    const start=weekStart(state.weekOffset),end=new Date(start);end.setDate(end.getDate()+6);$("#weekLabel").textContent=`${fmtDate(dateISO(start))} — ${fmtDate(dateISO(end))}`;const today=dateISO();
    $("#weekDays").innerHTML=[0,1,2,3,4,5,6].map(i=>{const d=new Date(start);d.setDate(d.getDate()+i);const iso=dateISO(d);return `<div class="day-chip ${iso===today?"active":""}"><span>${["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"][i]}</span><strong>${d.getDate()}</strong></div>`}).join("");
    const s=dateISO(start),e=dateISO(end),logs=projectLogs().filter(x=>x.date>=s&&x.date<=e).sort((a,b)=>a.date.localeCompare(b.date)||String(a.start_time).localeCompare(String(b.start_time)));
    $("#timeList").innerHTML=logs.length?logs.map(x=>`<div class="list-card"><div class="list-icon">◷</div><div class="list-main"><strong>${escapeHtml(x.task)}</strong><small>${fmtDate(x.date)} · ${escapeHtml(x.lot)} · ${x.start_time?.slice(0,5)||""}${x.end_time?` → ${x.end_time.slice(0,5)}`:""} · ${money(x.hourly_rate)}/h</small></div><div class="list-value">${hoursLabel(x.minutes)}<br><button class="text-btn danger delete-time" data-id="${x.id}">Suppr.</button></div></div>`).join(""):`<div class="empty-state">Aucune heure cette semaine.</div>`;$$(".delete-time").forEach(b=>b.onclick=()=>deleteTime(b.dataset.id));
  }

  function renderBilan(){
    $$("[data-bilan]").forEach(b=>b.classList.toggle("active",b.dataset.bilan===state.bilanMode));
    $$("[data-bilan-section]").forEach(s=>s.classList.toggle("hidden",s.dataset.bilanSection!==state.bilanMode));
    const t=totals(),eg=expenseBreakdownByLot(),bg=budgetBreakdownByLot(),tg=timeBreakdownByLot(),lg=laborBreakdownByLot(),pg=payerBreakdown(),bt=budgetTotal(),remaining=bt-t.expenses;

    if($("#bilanBudgetTotal")){ $("#bilanBudgetTotal").textContent=money(bt);$("#bilanBudgetHint").textContent=bt?`${projectLots().filter(l=>Number(l.budget)>0).length} lot(s) budgété(s)`:"À paramétrer dans Projets";$("#bilanSpentTotal").textContent=money(t.expenses);$("#bilanSpentHint").textContent=bt?`${pct(t.expenses/bt*100)} du budget lots`:"Budget non défini";$("#bilanRemainingTotal").textContent=money(remaining);$("#bilanRemainingHint").textContent=bt?(remaining>=0?"Reste prévisionnel":"Dépassement prévisionnel"):"Budget non défini";$("#bilanLaborTotal").textContent=money(t.labor);$("#bilanLaborHint").textContent=`${hoursLabel(t.minutes)} valorisées`; }

    if(state.bilanMode==="global"){
      $("#bilanHighlightLabel").textContent="Valeur théorique du chantier";$("#bilanGrandTotal").textContent=money(t.total);$("#bilanSentence").textContent=bt?`${money(t.expenses)} dépensés sur ${money(bt)} de budgets de lots. ${remaining>=0?money(remaining)+" restent prévus.":money(Math.abs(remaining))+" de dépassement."}`:`${hoursLabel(t.minutes)} de travail valorisées à ${money(t.labor)}.`;
      drawDoughnut("bilanExpenseChart",eg);drawDoughnut("bilanTimeChart",tg);renderGlobalLotSummary(bg,eg,tg,lg);
    }else if(state.bilanMode==="expenses"){
      $("#bilanHighlightLabel").textContent="Dépenses réelles";$("#bilanGrandTotal").textContent=money(t.expenses);$("#bilanSentence").textContent=bt?`${pct(t.expenses/bt*100)} du budget lots consommé.`:`${projectExpenses().length} dépense${projectExpenses().length>1?"s":""} enregistrée${projectExpenses().length>1?"s":""}.`;
      drawDoughnut("bilanExpenseOnlyChart",eg);drawDoughnut("bilanPayerChart",pg);renderExpenseBudgetList(bg,eg);renderRankList("#bilanPayerList",pg,v=>money(v));
    }else{
      $("#bilanHighlightLabel").textContent="Temps passé";$("#bilanGrandTotal").textContent=hoursLabel(t.minutes);$("#bilanSentence").textContent=`Valeur théorique de la main-d'œuvre : ${money(t.labor)}.`;drawDoughnut("bilanTimeOnlyChart",tg);renderTimeBudgetList(tg,lg);
    }
  }
  function renderGlobalLotSummary(bg,eg,tg,lg){
    const lots=[...new Set([...projectLots().map(l=>l.name),...Object.keys(eg),...Object.keys(tg)])];
    $("#lotSummary").innerHTML=lots.length?`<div class="budget-table-row header"><span>Lot</span><span>Budget</span><span>Dépensé</span><span>Situation</span><span>Temps</span><span>MO</span></div>`+lots.map(l=>{const budget=bg[l]||0,spent=eg[l]||0,ratio=budget?spent/budget*100:0,rem=budget-spent;return `<div class="budget-table-row"><strong>${escapeHtml(l)}</strong><span>${money(budget)}</span><span>${money(spent)}</span><span class="${budget&&rem<0?"over":""}">${budget?(rem>=0?money(rem)+" reste":money(Math.abs(rem))+" dépassés"):"—"}</span><span>${(tg[l]||0).toFixed(1)} h</span><span>${money(lg[l]||0)}</span><div class="budget-progress"><span style="width:${Math.min(100,Math.max(0,ratio))}%" class="${ratio>100?"over":""}"></span></div></div>`}).join(""):`<div class="empty-state">Aucune donnée.</div>`;
  }
  function renderExpenseBudgetList(bg,eg){
    const lots=[...new Set([...projectLots().map(l=>l.name),...Object.keys(eg)])];
    $("#bilanExpenseList").innerHTML=lots.length?lots.map(l=>{const budget=bg[l]||0,spent=eg[l]||0,ratio=budget?spent/budget*100:0,remain=budget-spent;return `<div class="budget-row"><div class="budget-row-top"><div><strong>${escapeHtml(l)}</strong><small>${budget?`${money(budget)} prévus`:`Budget non défini`}</small></div><div class="budget-values"><strong>${money(spent)}</strong><small class="${budget&&remain<0?"over":""}">${budget?(remain>=0?`${money(remain)} restants`:`+ ${money(Math.abs(remain))} dépassés`):"dépensés"}</small></div></div><div class="budget-progress large"><span style="width:${Math.min(100,Math.max(0,ratio))}%" class="${ratio>100?"over":""}"></span></div>${budget?`<div class="budget-percent">${pct(ratio)}</div>`:""}</div>`}).join(""):`<div class="empty-state">Aucune donnée.</div>`;
  }
  function renderTimeBudgetList(tg,lg){
    const lots=[...new Set([...projectLots().map(l=>l.name),...Object.keys(tg)])].filter(l=>(tg[l]||0)>0||Number(lotByName(l)?.hourly_rate)>=0);
    $("#bilanTimeList").innerHTML=lots.length?lots.map(l=>`<div class="time-budget-row"><div><strong>${escapeHtml(l)}</strong><small>Taux configuré : ${money(lotDefaultRate(l))}/h</small></div><div><span>${(tg[l]||0).toFixed(1)} h</span><strong>${money(lg[l]||0)}</strong></div></div>`).join(""):`<div class="empty-state">Aucune donnée.</div>`;
  }
  function renderRankList(selector,data,formatter){const entries=Object.entries(data).sort((a,b)=>b[1]-a[1]),max=entries[0]?.[1]||1;$(selector).innerHTML=entries.length?entries.map(([k,v])=>`<div class="rank-row"><div class="rank-name"><strong>${escapeHtml(k)}</strong></div><div class="rank-bar"><span style="width:${Math.max(3,(v/max)*100)}%"></span></div><div class="rank-value">${formatter(v)}</div></div>`).join(""):`<div class="empty-state">Aucune donnée.</div>`;}

  function renderProjects(){
    $("#projectList").innerHTML=state.projects.map(p=>{const isCurrent=p.id===state.currentProjectId;const pLots=state.lots.filter(l=>l.project_id===p.id),lotBudget=pLots.reduce((s,l)=>s+Number(l.budget||0),0);return `<article class="project-card ${isCurrent?"active":""}"><div><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.address||"Adresse non renseignée")}</p></div><div class="project-meta"><div><small>Budget lots</small><br><strong>${money(lotBudget||p.budget||0)}</strong></div><button class="btn secondary compact choose-project" data-id="${p.id}">${isCurrent?"Actif":"Ouvrir"}</button></div></article>`}).join("");$$(".choose-project").forEach(b=>b.onclick=()=>switchProject(b.dataset.id));
  }
  function lotUsage(name){ let expense=0,line=0,time=0;projectExpenses().forEach(x=>{if(x.lot===name)expense++;(x.items||[]).forEach(i=>{if(i.lot===name)line++;});});projectLogs().forEach(x=>{if(x.lot===name)time++;});return {expense,line,time,total:expense+line+time}; }
  function renderLots(){
    const el=$("#lotList");if(!el)return;const lots=projectLots();
    el.innerHTML=lots.length?lots.map(l=>{const u=lotUsage(l.name);return `<div class="lot-config-row" data-id="${l.id}"><div class="lot-config-name"><strong>${escapeHtml(l.name)}</strong><small>${u.total?`${u.total} donnée${u.total>1?"s":""} associée${u.total>1?"s":""}`:"Non utilisé"}</small></div><label><span>Budget €</span><input class="lot-budget-input" type="number" min="0" step="100" value="${Number(l.budget||0)}"></label><label><span>Taux €/h</span><input class="lot-rate-input" type="number" min="0" step="1" value="${Number(l.hourly_rate??45)}"></label><div class="lot-config-actions"><button class="btn secondary compact lot-save" type="button">Enregistrer</button><button class="lot-delete" type="button" ${u.total?"disabled title=\"Lot utilisé : suppression impossible\"":"title=\"Supprimer\""}>×</button></div></div>`}).join(""):`<div class="empty-state">Ajoute au moins un lot.</div>`;
    $$(".lot-config-row").forEach(row=>{const id=row.dataset.id;row.querySelector(".lot-save").onclick=()=>updateLot(id,Number(row.querySelector(".lot-budget-input").value||0),Number(row.querySelector(".lot-rate-input").value||0));const del=row.querySelector(".lot-delete");if(!del.disabled)del.onclick=()=>deleteLot(id);});
    if($("#lotBudgetFooter")){const bt=budgetTotal();$("#lotBudgetFooter").innerHTML=`<span>Budget total des lots</span><strong>${money(bt)}</strong><small>${bt?"Utilisé comme référence dans le bilan":"Renseigne les budgets pour activer le suivi prévisionnel"}</small>`;}
  }
  function renderTeam(){const list=state.team||[];$("#teamList").innerHTML=list.length?list.map(m=>`<div class="list-card"><div class="list-icon">♙</div><div class="list-main"><strong>${escapeHtml(m.display_name||m.email||"Membre")}</strong><small>${escapeHtml(m.email||"")} · ${escapeHtml(roleLabel(m.role))}</small></div></div>`).join(""):`<div class="empty-state">Aucun membre chargé.</div>`;}

  function drawDoughnut(id,data){
    const el=document.getElementById(id);if(!el||!window.Chart)return;if(state.charts[id])state.charts[id].destroy();const entries=Object.entries(data).filter(([,v])=>Math.abs(v)>0.001).sort((a,b)=>b[1]-a[1]);
    state.charts[id]=new Chart(el,{type:"doughnut",data:{labels:entries.map(x=>x[0]),datasets:[{data:entries.map(x=>x[1]),backgroundColor:entries.map((_,i)=>COLORS[i%COLORS.length]),borderWidth:0,hoverOffset:4}]},options:{responsive:true,maintainAspectRatio:false,cutout:"68%",plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.label}: ${Number(c.raw).toLocaleString("fr-FR",{maximumFractionDigits:2})}`}}}}});
  }

  async function fileToDataUrlCompressed(file){
    if(!file)return null;
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>{const img=new Image();img.onerror=reject;img.onload=()=>{const max=1400,scale=Math.min(1,max/Math.max(img.width,img.height)),canvas=document.createElement("canvas");canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL("image/jpeg",.76));};img.src=reader.result;};reader.readAsDataURL(file);});
  }

  async function addExpense(payload,file,items=[]){
    if(mode==="cloud"){
      let receipt_path=null;
      if(file){const ext=(file.name.split(".").pop()||"jpg").replace(/[^a-z0-9]/gi,"").toLowerCase();receipt_path=`${session.user.id}/${state.currentProjectId}/${Date.now()}.${ext}`;const up=await sb.storage.from("receipts").upload(receipt_path,file,{contentType:file.type||"image/jpeg",upsert:false});if(up.error){console.error(up.error);toast("Ticket non envoyé, dépense enregistrée sans photo.");receipt_path=null;}}
      const ins=await sb.from("expenses").insert({...payload,project_id:state.currentProjectId,user_id:session.user.id,receipt_path}).select("id").single();if(ins.error){toast(ins.error.message);return false;}
      if(items.length){const rows=items.map(i=>({expense_id:ins.data.id,project_id:state.currentProjectId,description:i.description,amount:Number(i.amount),lot:i.lot}));const child=await sb.from("expense_items").insert(rows);if(child.error){await sb.from("expenses").delete().eq("id",ins.data.id);toast("Impossible d'enregistrer les lignes du ticket : "+child.error.message);return false;}}
      await loadCurrentProjectData();
    } else {
      const receipt_data_url=file?await fileToDataUrlCompressed(file):null;
      state.expenses.unshift({id:uid(),project_id:state.currentProjectId,user_id:"demo",created_at:new Date().toISOString(),...payload,receipt_data_url,items:items.map(i=>({id:uid(),...i}))});localSave();
    }
    renderAll();return true;
  }

  async function updateExpense(id,payload,file,items=[]){
    const current=projectExpenses().find(x=>x.id===id);if(!current)return false;
    if(mode==="cloud"){
      let receipt_path=current.receipt_path||null,newPath=null;
      if(file){const ext=(file.name.split(".").pop()||"jpg").replace(/[^a-z0-9]/gi,"").toLowerCase();newPath=`${session.user.id}/${state.currentProjectId}/${Date.now()}.${ext}`;const up=await sb.storage.from("receipts").upload(newPath,file,{contentType:file.type||"image/jpeg",upsert:false});if(up.error){toast("Impossible de remplacer le ticket : "+up.error.message);return false;}receipt_path=newPath;}
      const upExp=await sb.from("expenses").update({...payload,receipt_path}).eq("id",id);if(upExp.error){if(newPath)await sb.storage.from("receipts").remove([newPath]);toast(upExp.error.message);return false;}
      const del=await sb.from("expense_items").delete().eq("expense_id",id);if(del.error){toast("Dépense modifiée, mais impossible de mettre à jour les lignes : "+del.error.message);return false;}
      if(items.length){const rows=items.map(i=>({expense_id:id,project_id:state.currentProjectId,description:i.description,amount:Number(i.amount),lot:i.lot}));const ins=await sb.from("expense_items").insert(rows);if(ins.error){toast("Dépense modifiée, mais erreur sur les lignes : "+ins.error.message);return false;}}
      if(newPath&&current.receipt_path&&current.receipt_path!==newPath)await sb.storage.from("receipts").remove([current.receipt_path]);
      await loadCurrentProjectData();
    }else{
      const idx=state.expenses.findIndex(x=>x.id===id);if(idx<0)return false;let receipt_data_url=current.receipt_data_url||null;if(file)receipt_data_url=await fileToDataUrlCompressed(file);
      state.expenses[idx]={...current,...payload,receipt_data_url,items:items.map(i=>({id:i.id||uid(),...i}))};localSave();
    }
    renderAll();return true;
  }

  async function addTime(payload){if(mode==="cloud"){const {error}=await sb.from("work_logs").insert({...payload,project_id:state.currentProjectId,user_id:session.user.id});if(error){toast(error.message);return false;}await loadCurrentProjectData();}else{state.workLogs.unshift({id:uid(),project_id:state.currentProjectId,created_at:new Date().toISOString(),...payload});localSave();}renderAll();return true;}
  async function deleteExpense(id){if(!confirm("Supprimer cette dépense et ses lignes ?"))return;if(mode==="cloud"){const x=projectExpenses().find(e=>e.id===id);const {error}=await sb.from("expenses").delete().eq("id",id);if(error)return toast(error.message);if(x?.receipt_path)await sb.storage.from("receipts").remove([x.receipt_path]);await loadCurrentProjectData();}else{state.expenses=state.expenses.filter(x=>x.id!==id);localSave();}renderAll();}
  async function deleteTime(id){if(!confirm("Supprimer cette saisie ?"))return;if(mode==="cloud"){const {error}=await sb.from("work_logs").delete().eq("id",id);if(error)return toast(error.message);await loadCurrentProjectData();}else{state.workLogs=state.workLogs.filter(x=>x.id!==id);localSave();}renderAll();}

  async function addLot(name,budget=0,rate=45){
    name=name.trim().replace(/\s+/g," ");if(!name)return false;if(projectLots().some(l=>l.name.toLowerCase()===name.toLowerCase())){toast("Ce lot existe déjà.");return false;}
    if(mode==="cloud"){const {error}=await sb.from("project_lots").insert({project_id:state.currentProjectId,name,budget:Number(budget||0),hourly_rate:Number(rate||0),created_by:session.user.id});if(error){toast(error.message);return false;}await loadCurrentProjectData();}
    else{state.lots.push({id:uid(),project_id:state.currentProjectId,name,budget:Number(budget||0),hourly_rate:Number(rate||0)});localSave();}
    renderAll();return true;
  }
  async function updateLot(id,budget,rate){
    const lot=projectLots().find(l=>l.id===id);if(!lot)return;
    if(mode==="cloud"){const {error}=await sb.from("project_lots").update({budget:Number(budget||0),hourly_rate:Number(rate||0)}).eq("id",id);if(error){toast(error.message);return;}await loadCurrentProjectData();}
    else{lot.budget=Number(budget||0);lot.hourly_rate=Number(rate||0);localSave();}
    renderAll();toast(`Paramètres de « ${lot.name} » enregistrés.`);
  }
  async function deleteLot(id){
    const lot=projectLots().find(l=>l.id===id);if(!lot)return;const u=lotUsage(lot.name);if(u.total){toast(`Impossible : le lot « ${lot.name} » est utilisé dans ${u.total} donnée${u.total>1?"s":""}.`);return;}if(!confirm(`Supprimer le lot « ${lot.name} » ?`))return;
    if(mode==="cloud"){const {data,error}=await sb.rpc("delete_project_lot",{p_lot_id:id});if(error){toast(error.message);return;}if(data!=="deleted"){toast(data||"Suppression impossible");return;}await loadCurrentProjectData();}
    else{state.lots=state.lots.filter(l=>l.id!==id);localSave();}
    renderAll();toast("Lot supprimé.");
  }

  async function createProjectCloud(p){const {data,error}=await sb.rpc("create_project_with_owner",{p_name:p.name,p_address:p.address||"",p_budget:Number(p.budget||0)});if(error){toast(error.message);return null;}return data;}
  async function createProject(p){if(mode==="cloud"){const id=await createProjectCloud(p);if(!id)return;state.currentProjectId=id;await loadCloudData();}else{const pr={id:uid(),created_at:new Date().toISOString(),role:"admin",...p};state.projects.push(pr);state.currentProjectId=pr.id;DEFAULT_LOTS.forEach(name=>state.lots.push({id:uid(),project_id:pr.id,name,budget:0,hourly_rate:45}));localSave();}renderAll();navigate("home");}
  async function switchProject(id){state.currentProjectId=id;if(mode==="cloud")await loadCurrentProjectData();else localSave();renderAll();navigate("home");}
  async function inviteMember(email,role){if(mode==="local"){toast("Les invitations nécessitent la synchronisation Supabase.");return;}const {data,error}=await sb.rpc("invite_project_member",{p_project_id:state.currentProjectId,p_email:email,p_role:role});if(error){toast(error.message);return;}toast(data==="added"?"Membre ajouté.":"Invitation enregistrée.");await loadCurrentProjectData();renderTeam();renderPayerControl();}

  async function scanReceipt(file){
    if(!file)return;const img=$("#receiptPreview");img.src=URL.createObjectURL(file);img.classList.remove("hidden");$("#ocrStatus").textContent="Lecture du ticket en cours…";
    try{
      const {data:{text}}=await Tesseract.recognize(file,"fra+eng",{logger:m=>{if(m.status==="recognizing text")$("#ocrStatus").textContent=`Lecture du ticket… ${Math.round((m.progress||0)*100)} %`;}});
      const parsed=parseReceipt(text);if(parsed.merchant)$("#expenseMerchant").value=parsed.merchant;if(parsed.amount)$("#expenseAmount").value=parsed.amount.toFixed(2);if(parsed.date)$("#expenseDate").value=parsed.date;if(parsed.vat)$("#expenseVat").value=parsed.vat.toFixed(2);
      state.pendingReceiptItems=parsed.items.map(i=>({...i,id:uid(),lot:$("#expenseLot").value||projectLots()[0]?.name||"Divers"}));renderReceiptLines();
      $("#ocrStatus").textContent=parsed.items.length?`${parsed.items.length} ligne${parsed.items.length>1?"s":""} détectée${parsed.items.length>1?"s":""}. Vérifie les désignations, montants et lots.`:"Lecture terminée, mais aucune ligne d'article fiable n'a été détectée. Tu peux les ajouter manuellement.";show("#receiptLinesSection");
    }catch(err){console.error(err);$("#ocrStatus").textContent="Lecture automatique impossible. Tu peux saisir les informations et les lignes manuellement.";show("#receiptLinesSection");}
  }
  function parseReceipt(text){
    const lines=text.split(/\r?\n/).map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean),candidates=[],items=[];
    const excluded=/\b(total|sous[- ]?total|ttc|tva|taxe|a payer|à payer|montant|carte|cb|visa|mastercard|especes|espèces|rendu|remise|avoir|merci|solde|paiement|ticket|transaction)\b/i;
    lines.forEach(line=>{
      const nums=[...line.matchAll(/(\d{1,5}[.,]\d{2})\s*€?/g)].map(m=>Number(m[1].replace(",",".")));if(nums.length){const score=/total|ttc|a payer|à payer|montant/i.test(line)?10:1;nums.forEach(n=>{if(n>0&&n<100000)candidates.push({n,score});});}
      const lm=line.match(/^(.*?)[\s:]+(-?\d{1,5}[.,]\d{2})\s*€?\s*$/);if(lm){let desc=lm[1].replace(/^[*#\-]+/,"").trim(),amount=Number(lm[2].replace(",","."));if(desc.length>=2&&amount>0&&!excluded.test(desc)&&!(/^(\d+[xX*]\s*)?$/.test(desc)))items.push({description:desc.slice(0,100),amount});}
    });
    candidates.sort((a,b)=>b.score-a.score||b.n-a.n);let merchant=lines.find(l=>l.length>2&&!/\d/.test(l)&&!/ticket|merci|www\.|siret|tva/i.test(l))||"";merchant=merchant.slice(0,60);let date=null;const dm=text.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2}|\d{2})\b/);if(dm){let y=dm[3];if(y.length===2)y="20"+y;date=`${y}-${dm[2].padStart(2,"0")}-${dm[1].padStart(2,"0")}`;}let vat=null;const tv=text.match(/(?:tva|taxe)[^\d]{0,10}(\d+[.,]\d{2})/i);if(tv)vat=Number(tv[1].replace(",","."));
    const seen=new Set(),cleanItems=items.filter(i=>{const k=`${i.description.toLowerCase()}|${i.amount.toFixed(2)}`;if(seen.has(k))return false;seen.add(k);return true;}).slice(0,80);return {merchant,amount:candidates[0]?.n||null,date,vat,items:cleanItems};
  }
  function renderReceiptLines(){
    const el=$("#receiptLines");if(!el)return;const lots=projectLots();if(!state.pendingReceiptItems.length){el.innerHTML=`<div class="empty-state compact-empty">Aucune ligne. Utilise « + Ligne » pour répartir manuellement le ticket.</div>`;updateReceiptLineSummary();return;}
    el.innerHTML=state.pendingReceiptItems.map((i,idx)=>`<div class="receipt-line" data-index="${idx}"><input class="receipt-desc" value="${escapeHtml(i.description)}" placeholder="Désignation"><input class="receipt-amount" type="number" min="0" step="0.01" value="${Number(i.amount||0).toFixed(2)}"><select class="receipt-lot">${lots.map(l=>`<option value="${escapeHtml(l.name)}" ${l.name===i.lot?"selected":""}>${escapeHtml(l.name)}</option>`).join("")}</select><button type="button" class="receipt-line-remove" title="Supprimer la ligne">×</button></div>`).join("");
    $$(".receipt-line").forEach(row=>{const idx=Number(row.dataset.index);row.querySelector(".receipt-desc").oninput=e=>state.pendingReceiptItems[idx].description=e.target.value;row.querySelector(".receipt-amount").oninput=e=>{state.pendingReceiptItems[idx].amount=Number(e.target.value||0);updateReceiptLineSummary();};row.querySelector(".receipt-lot").onchange=e=>state.pendingReceiptItems[idx].lot=e.target.value;row.querySelector(".receipt-line-remove").onclick=()=>{state.pendingReceiptItems.splice(idx,1);renderReceiptLines();};});updateReceiptLineSummary();
  }
  function updateReceiptLineSummary(){const el=$("#receiptLinesSummary");if(!el)return;const sum=state.pendingReceiptItems.reduce((s,i)=>s+Number(i.amount||0),0),total=Number($("#expenseAmount")?.value||0),diff=total-sum;el.innerHTML=`<span>Lignes : <strong>${money(sum)}</strong></span><span>Total ticket : <strong>${money(total)}</strong></span><span class="${Math.abs(diff)>.05?"warning":""}">Écart : <strong>${money(diff)}</strong>${diff>0.05?" → lot par défaut":""}</span>`;}

  async function resolveExistingReceipt(expense){
    state.existingReceiptUrl=null;hide("#existingReceiptActions");
    if(mode==="local"&&expense.receipt_data_url){state.existingReceiptUrl=expense.receipt_data_url;show("#existingReceiptActions");return;}
    if(mode==="cloud"&&expense.receipt_path){const {data,error}=await sb.storage.from("receipts").createSignedUrl(expense.receipt_path,3600);if(!error&&data?.signedUrl){state.existingReceiptUrl=data.signedUrl;show("#existingReceiptActions");}}
  }
  async function openExpenseEditor(id){
    const x=projectExpenses().find(e=>e.id===id);if(!x)return;resetExpenseForm();state.editingExpenseId=id;$("#expenseModalEyebrow").textContent="Modification";$("#expenseModalTitle").textContent=x.merchant||"Dépense";$("#expenseSubmit").textContent="Enregistrer les modifications";
    $("#expenseMerchant").value=x.merchant||"";$("#expenseDate").value=x.date||dateISO();$("#expenseAmount").value=Number(x.amount||0);$("#expenseVat").value=x.vat==null?"":Number(x.vat);$("#expenseCategory").value=x.category||"Divers";$("#expenseLot").value=x.lot||projectLots()[0]?.name||"";$("#expenseDescription").value=x.description||"";renderPayerControl();if([...$("#expensePaidBy").options].some(o=>o.value===(x.paid_by_user_id||x.user_id)))$("#expensePaidBy").value=x.paid_by_user_id||x.user_id;
    state.pendingReceiptItems=(x.items||[]).map(i=>({id:i.id||uid(),description:i.description||"",amount:Number(i.amount||0),lot:i.lot||x.lot}));if(state.pendingReceiptItems.length)show("#receiptLinesSection");renderReceiptLines();await resolveExistingReceipt(x);show("#expenseModal");
  }

  function startTimer(){
    if(state.timer){stopTimer();return;}const lots=projectLots();if(!lots.length)return toast("Ajoute d'abord un lot au projet.");const list=lots.map((l,i)=>`${i+1}. ${l.name}`).join("\n");const choice=Number(prompt(`Choisis le numéro du lot :\n${list}`,"1"));const lotObj=lots[choice-1];if(!lotObj)return toast("Lot invalide.");const task=prompt("Tâche réalisée :","Travaux chantier");if(!task)return;const rate=Number(lotObj.hourly_rate??45);state.timer={startedAt:Date.now(),lot:lotObj.name,task,rate,date:dateISO()};$("#timerTaskLabel").textContent=`${lotObj.name} · ${task} · ${money(rate)}/h`;$("#timerToggle").textContent="■";updateTimer();state.timerInterval=setInterval(updateTimer,1000);closeOverlays();navigate("time");
  }
  function updateTimer(){if(!state.timer)return;const sec=Math.floor((Date.now()-state.timer.startedAt)/1000),h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;$("#timerDisplay").textContent=[h,m,s].map(x=>String(x).padStart(2,"0")).join(":");}
  async function stopTimer(){if(!state.timer)return;clearInterval(state.timerInterval);const mins=Math.max(1,Math.round((Date.now()-state.timer.startedAt)/60000)),t=state.timer;state.timer=null;$("#timerToggle").textContent="▶";$("#timerDisplay").textContent="00:00:00";$("#timerTaskLabel").textContent="Sélectionne une tâche puis démarre.";await addTime({date:t.date,start_time:null,end_time:null,minutes:mins,lot:t.lot,task:t.task,hourly_rate:t.rate,notes:"Chronométré avec Bati'Coût"});toast(`Chrono enregistré : ${hoursLabel(mins)}`);}

  function navigate(view){$$(".view").forEach(v=>v.classList.toggle("active",v.dataset.view===view));$$(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.go===view));closeOverlays();window.scrollTo({top:0,behavior:"smooth"});if(view==="bilan")setTimeout(renderBilan,50);}
  function minutesBetween(a,b){if(!a||!b)return 0;const [ah,am]=a.split(":").map(Number),[bh,bm]=b.split(":").map(Number);let m=(bh*60+bm)-(ah*60+am);if(m<0)m+=1440;return m;}
  function setFormDefaults(){$("#expenseDate").value=dateISO();$("#timeDate").value=dateISO();$("#timeStart").value="08:00";$("#timeEnd").value="12:00";renderLotControls();renderPayerControl();applyLotRate(true);}
  function resetExpenseForm(){ $("#expenseForm").reset();state.pendingReceiptItems=[];state.editingExpenseId=null;state.existingReceiptUrl=null;$("#expenseModalEyebrow").textContent="Nouvelle saisie";$("#expenseModalTitle").textContent="Dépense";$("#expenseSubmit").textContent="Enregistrer la dépense";$("#receiptInput").value="";$("#expenseDate").value=dateISO();$("#receiptPreview").classList.add("hidden");$("#receiptPreview").removeAttribute("src");$("#ocrStatus").textContent="";hide("#receiptLinesSection");hide("#existingReceiptActions");renderLotControls();renderPayerControl(); }

  function bindUI(){
    $("#demoButton").onclick=enterLocal;$$("[data-close]").forEach(b=>b.onclick=closeOverlays);$$("[data-go]").forEach(b=>b.onclick=()=>navigate(b.dataset.go));$("#menuBtn").onclick=()=>show("#menuSheet");$("#quickAdd").onclick=()=>show("#quickSheet");$("#projectPicker").onclick=()=>navigate("projects");$("#expenseSearch").addEventListener("input",renderExpenses);$("#expenseLotFilter").addEventListener("change",renderExpenses);$$("[data-action]").forEach(b=>b.onclick=()=>handleAction(b.dataset.action));$("#receiptButton").onclick=()=>$("#receiptInput").click();$("#receiptInput").onchange=e=>scanReceipt(e.target.files[0]);$("#expenseAmount").addEventListener("input",updateReceiptLineSummary);$("#viewExistingReceipt").onclick=()=>{if(state.existingReceiptUrl)window.open(state.existingReceiptUrl,"_blank","noopener")};
    $("#addReceiptLine").onclick=()=>{show("#receiptLinesSection");state.pendingReceiptItems.push({id:uid(),description:"",amount:0,lot:$("#expenseLot").value||projectLots()[0]?.name||"Divers"});renderReceiptLines();};
    $$("[data-bilan]").forEach(b=>b.onclick=()=>{state.bilanMode=b.dataset.bilan;if(mode==="local")localSave();renderBilan();});
    $$(".seg-btn[data-auth-tab]").forEach(b=>b.onclick=()=>{$$(".seg-btn[data-auth-tab]").forEach(x=>x.classList.remove("active"));b.classList.add("active");$("#authSubmit").textContent=b.dataset.authTab==="signup"?"Créer mon compte":"Se connecter";$("#authForm").dataset.mode=b.dataset.authTab;});
    $("#authForm").onsubmit=async e=>{e.preventDefault();if(!cloudEnabled){toast("Configure Supabase ou utilise le mode démo.");return;}const email=$("#authEmail").value.trim(),password=$("#authPassword").value,signup=e.currentTarget.dataset.mode==="signup";const result=signup?await sb.auth.signUp({email,password,options:{data:{display_name:email.split("@")[0]}}}):await sb.auth.signInWithPassword({email,password});if(result.error)return toast(result.error.message);if(signup&&!result.data.session)toast("Compte créé : vérifie ton e-mail pour confirmer l'inscription.");};
    $("#expenseForm").onsubmit=async e=>{e.preventDefault();const items=state.pendingReceiptItems.filter(i=>Number(i.amount)>0&&i.description.trim()).map(i=>({id:i.id,description:i.description.trim(),amount:Number(i.amount),lot:i.lot||$("#expenseLot").value}));const total=Number($("#expenseAmount").value),sum=items.reduce((s,i)=>s+i.amount,0);if(items.length&&sum>total+0.05)return toast("Le total des lignes dépasse le total du ticket. Corrige un montant avant d'enregistrer.");const payload={merchant:$("#expenseMerchant").value.trim(),date:$("#expenseDate").value,amount:total,vat:$("#expenseVat").value?Number($("#expenseVat").value):null,category:$("#expenseCategory").value,lot:$("#expenseLot").value,description:$("#expenseDescription").value.trim(),paid_by_user_id:$("#expensePaidBy").value||currentUserId()};const file=$("#receiptInput").files[0];const ok=state.editingExpenseId?await updateExpense(state.editingExpenseId,payload,file,items):await addExpense(payload,file,items);if(ok){const wasEdit=!!state.editingExpenseId;resetExpenseForm();closeOverlays();toast(wasEdit?"Dépense et lignes mises à jour.":(items.length?"Ticket enregistré et réparti par lot.":"Dépense enregistrée."));}};
    $("#timeLot").onchange=()=>applyLotRate(true);
    $("#timeForm").onsubmit=async e=>{e.preventDefault();const start=$("#timeStart").value,end=$("#timeEnd").value,override=Number($("#timeDurationOverride").value||0),mins=override?Math.round(override*60):minutesBetween(start,end);if(mins<=0)return toast("La durée doit être supérieure à zéro.");const ok=await addTime({date:$("#timeDate").value,start_time:start||null,end_time:end||null,minutes:mins,lot:$("#timeLot").value,task:$("#timeTask").value.trim(),hourly_rate:Number($("#timeRate").value||0),notes:$("#timeNotes").value.trim()});if(ok){e.currentTarget.reset();setFormDefaults();closeOverlays();toast("Temps enregistré.");}};
    $("#projectForm").onsubmit=async e=>{e.preventDefault();await createProject({name:$("#projectNameInput").value.trim(),address:$("#projectAddressInput").value.trim(),budget:Number($("#projectBudgetInput").value||0)});e.currentTarget.reset();closeOverlays();};
    $("#lotForm").onsubmit=async e=>{e.preventDefault();const ok=await addLot($("#newLotName").value,Number($("#newLotBudget").value||0),Number($("#newLotRate").value||45));if(ok){e.currentTarget.reset();$("#newLotRate").value="45";}};
    $("#inviteForm").onsubmit=async e=>{e.preventDefault();await inviteMember($("#inviteEmail").value.trim().toLowerCase(),$("#inviteRole").value);e.currentTarget.reset();closeOverlays();};
    $("#prevWeek").onclick=()=>{state.weekOffset--;if(mode==="local")localSave();renderTime();};$("#nextWeek").onclick=()=>{state.weekOffset++;if(mode==="local")localSave();renderTime();};$("#timerToggle").onclick=()=>state.timer?stopTimer():startTimer();$("#exportCsv").onclick=exportCSV;
    $("#logoutBtn").onclick=async()=>{closeOverlays();if(mode==="cloud")await sb.auth.signOut();else{session=null;showAuth();}};window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredInstallPrompt=e;});$("#installApp").onclick=async()=>{closeOverlays();if(!deferredInstallPrompt)return toast("Sur iPhone : Partager → Sur l'écran d'accueil.");deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;};setFormDefaults();
  }
  function handleAction(action){closeOverlays();if(action==="open-expense"){resetExpenseForm();show("#expenseModal");}if(action==="scan-ticket"){resetExpenseForm();show("#expenseModal");setTimeout(()=>$("#receiptInput").click(),200);}if(action==="open-time"){show("#timeModal");$("#timeDate").value=dateISO();renderLotControls();applyLotRate(true);}if(action==="open-project")show("#projectModal");if(action==="open-invite")show("#inviteModal");if(action==="start-timer")startTimer();}

  function exportCSV(){
    const rows=[["TYPE","DATE","LOT","CATEGORIE/TACHE","DESCRIPTION","PAYE_PAR","MONTANT","HEURES","TAUX_MO","VALEUR_MO","BUDGET_LOT"]];
    projectExpenses().forEach(x=>{rows.push(["DEPENSE",x.date,x.lot,x.category,(x.merchant||"")+" "+(x.description||""),payerLabel(x),x.amount,"","","",lotByName(x.lot)?.budget||0]);(x.items||[]).forEach(i=>rows.push(["LIGNE_TICKET",x.date,i.lot,x.category,i.description,payerLabel(x),i.amount,"","","",lotByName(i.lot)?.budget||0]));});
    projectLogs().forEach(x=>rows.push(["TEMPS",x.date,x.lot,x.task,x.notes||"","","",(x.minutes/60).toFixed(2),x.hourly_rate,((x.minutes/60)*x.hourly_rate).toFixed(2),lotByName(x.lot)?.budget||0]));
    projectLots().forEach(l=>rows.push(["PARAM_LOT","",l.name,"","","","","",l.hourly_rate,"",l.budget]));
    const csv="\ufeff"+rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(";")).join("\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));a.download=`baticout-${dateISO()}.csv`;a.click();URL.revokeObjectURL(a.href);
  }

  boot();
})();
