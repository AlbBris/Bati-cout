(() => {
  "use strict";

  const VERSION = "1.3.3";
  const STORAGE_KEY = "baticout_v1";
  const DEFAULT_LOTS = ["Terrassement","Gros œuvre","Maçonnerie","Charpente","Couverture","Menuiseries","Isolation","Placo","Électricité","Plomberie","Chauffage","Carrelage","Peinture","Aménagement extérieur","Divers"];
  const cfg = window.BATICOUT_CONFIG || {};
  const cloud = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
  const sb = cloud ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  let session = null;
  let data = { projects: [], expenses: [], logs: [], lots: [] };
  let timer = null;
  let timerInterval = null;
  let patchBusy = false;

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const money = n => new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR",maximumFractionDigits:2}).format(Number(n||0));
  const hoursLabel = mins => { const h=Math.floor((mins||0)/60),m=Math.round((mins||0)%60); return m?`${h} h ${String(m).padStart(2,"0")}`:`${h} h`; };
  const crew = x => Math.min(5,Math.max(1,Number(x?.crew_count||1)));
  const effectiveMinutes = x => Number(x?.minutes||0)*crew(x);

  function toast(message){
    const el=$("#toast");
    if(!el){ alert(message); return; }
    el.textContent=message;el.classList.add("show");clearTimeout(el._v13Timer);el._v13Timer=setTimeout(()=>el.classList.remove("show"),3800);
  }
  function setText(el,value){ if(el && el.textContent!==String(value)) el.textContent=String(value); }
  function currentProjectId(){ return $(".project-card.active .choose-project")?.dataset.id || null; }
  function localState(){ try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}")}catch{return {}} }
  function saveLocal(s){ localStorage.setItem(STORAGE_KEY,JSON.stringify(s)); }

  async function refreshData(){
    if(cloud){
      if(!session)session=(await sb.auth.getSession()).data.session;
      if(!session)return;
      const [p,e,w,l]=await Promise.all([
        sb.from("projects_visible").select("*"),
        sb.from("expenses").select("id,project_id,amount,receipt_path"),
        sb.from("work_logs").select("*"),
        sb.from("project_lots").select("id,project_id,name,budget,hourly_rate")
      ]);
      [p,e,w,l].forEach(r=>r.error&&console.warn("Bati'Coût V1.3",r.error));
      data.projects=p.data||[];data.expenses=e.data||[];data.logs=w.data||[];data.lots=l.data||[];
    }else{
      const s=localState();
      data.projects=s.projects||[];data.expenses=s.expenses||[];data.logs=(s.workLogs||[]).map(x=>({...x,crew_count:crew(x)}));data.lots=s.lots||[];
    }
  }

  function injectStyles(){
    if($("#v13Styles"))return;
    const style=document.createElement("style");style.id="v13Styles";style.textContent=`
      .btn.v13-danger{background:#F6DED5;color:#9F3E24;border:1px solid rgba(214,106,74,.25)}
      .v13-project-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}
      .v13-crew-detail{display:block;color:#6E746F;font-size:10px;font-weight:700;margin-top:2px}
      .v13-crew-field select{font-weight:800;color:#0D1B2A}
      @media(max-width:560px){.v13-project-actions{max-width:58%}.v13-project-actions .btn{padding:9px 10px}}
    `;document.head.appendChild(style);
  }

  function injectCrewField(){
    const form=$("#timeForm");if(!form)return;
    if(!$("#timeCrewCount")){
      const duration=$("#timeDurationOverride")?.closest("label");
      if(duration){
        const label=document.createElement("label");label.className="v13-crew-field";label.innerHTML=`<span>Nombre de personnes</span><select id="timeCrewCount" required><option value="1">1 personne</option><option value="2">2 personnes</option><option value="3">3 personnes</option><option value="4">4 personnes</option><option value="5">5 personnes</option></select><small id="timeCrewHint" class="field-hint">Durée × équipe = heures comptabilisées</small>`;
        duration.parentNode.insertBefore(label,duration);
      }
    }
    ["#timeCrewCount","#timeStart","#timeEnd","#timeDurationOverride"].forEach(sel=>{const el=$(sel);if(el&&!el.dataset.v13Hint){el.dataset.v13Hint="1";el.addEventListener("input",updateCrewHint);el.addEventListener("change",updateCrewHint);}});
    updateCrewHint();
  }

  function minutesBetween(a,b){if(!a||!b)return 0;const [ah,am]=a.split(":").map(Number),[bh,bm]=b.split(":").map(Number);let m=(bh*60+bm)-(ah*60+am);if(m<0)m+=1440;return m;}
  function updateCrewHint(){
    const c=Math.min(5,Math.max(1,Number($("#timeCrewCount")?.value||1))),override=Number($("#timeDurationOverride")?.value||0);
    const mins=override?Math.round(override*60):minutesBetween($("#timeStart")?.value,$("#timeEnd")?.value);
    setText($("#timeCrewHint"),mins>0?`${hoursLabel(mins)} × ${c} personne${c>1?"s":""} = ${hoursLabel(mins*c)} comptabilisées`:`${c} personne${c>1?"s":""}`);
  }

  function bindTimeForm(){
    const form=$("#timeForm");if(!form||form.dataset.v13Submit)return;
    form.dataset.v13Submit="1";
    form.onsubmit=async ev=>{
      ev.preventDefault();
      const pid=currentProjectId();if(!pid)return toast("Projet actif introuvable.");
      const start=$("#timeStart").value,end=$("#timeEnd").value,override=Number($("#timeDurationOverride").value||0),mins=override?Math.round(override*60):minutesBetween(start,end),c=Math.min(5,Math.max(1,Number($("#timeCrewCount")?.value||1)));
      if(mins<=0)return toast("La durée doit être supérieure à zéro.");
      const payload={date:$("#timeDate").value,start_time:start||null,end_time:end||null,minutes:mins,crew_count:c,lot:$("#timeLot").value,task:$("#timeTask").value.trim(),hourly_rate:Number($("#timeRate").value||0),notes:$("#timeNotes").value.trim()};
      if(cloud){
        if(!session)session=(await sb.auth.getSession()).data.session;if(!session)return toast("Reconnecte-toi avant d'enregistrer.");
        const {error}=await sb.from("work_logs").insert({...payload,project_id:pid,user_id:session.user.id});
        if(error){console.error(error);return toast(error.message.includes("crew_count")?"Exécute d'abord migration_v1_3.sql dans Supabase.":error.message);}
      }else{
        const s=localState();s.workLogs=s.workLogs||[];s.workLogs.unshift({id:uid(),project_id:pid,created_at:new Date().toISOString(),...payload});saveLocal(s);
      }
      toast(`${hoursLabel(mins*c)} enregistrées (${hoursLabel(mins)} × ${c}).`);setTimeout(()=>location.reload(),450);
    };
  }

  async function startOrStopTimer(){
    if(timer){
      clearInterval(timerInterval);const mins=Math.max(1,Math.round((Date.now()-timer.startedAt)/60000)),saved={...timer,minutes:mins};timer=null;setText($("#timerDisplay"),"00:00:00");setText($("#timerTaskLabel"),"Sélectionne une tâche puis démarre.");setText($("#timerToggle"),"▶");
      if(cloud){if(!session)session=(await sb.auth.getSession()).data.session;const {error}=await sb.from("work_logs").insert({project_id:saved.project_id,user_id:session.user.id,date:saved.date,start_time:null,end_time:null,minutes:mins,crew_count:saved.crew_count,lot:saved.lot,task:saved.task,hourly_rate:saved.hourly_rate,notes:"Chronométré avec Bati'Coût"});if(error)return toast(error.message.includes("crew_count")?"Exécute d'abord migration_v1_3.sql dans Supabase.":error.message);}
      else{const s=localState();s.workLogs=s.workLogs||[];s.workLogs.unshift({id:uid(),project_id:saved.project_id,date:saved.date,minutes:mins,crew_count:saved.crew_count,lot:saved.lot,task:saved.task,hourly_rate:saved.hourly_rate,notes:"Chronométré avec Bati'Coût",created_at:new Date().toISOString()});saveLocal(s);}
      toast(`${hoursLabel(mins*saved.crew_count)} comptabilisées.`);setTimeout(()=>location.reload(),450);return;
    }
    const pid=currentProjectId();if(!pid)return toast("Projet actif introuvable.");
    const lots=data.lots.filter(l=>l.project_id===pid);if(!lots.length)return toast("Ajoute d'abord un lot au projet.");
    const list=lots.map((l,i)=>`${i+1}. ${l.name}`).join("\n"),choice=Number(prompt(`Choisis le numéro du lot :\n${list}`,"1")),lot=lots[choice-1];if(!lot)return;
    const task=prompt("Tâche réalisée :","Travaux chantier");if(!task)return;const c=Math.min(5,Math.max(1,Number(prompt("Combien de personnes ? (1 à 5)","1")||1));
    timer={startedAt:Date.now(),project_id:pid,date:new Date().toISOString().slice(0,10),crew_count:c,lot:lot.name,task,hourly_rate:Number(lot.hourly_rate||45)};
    setText($("#timerTaskLabel"),`${lot.name} · ${task} · ${c} pers.`);setText($("#timerToggle"),"■");
    const tick=()=>{const sec=Math.floor((Date.now()-timer.startedAt)/1000),h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;setText($("#timerDisplay"),[h,m,s].map(x=>String(x).padStart(2,"0")).join(":"));};tick();timerInterval=setInterval(tick,1000);
    const sheet=$("#quickSheet");if(sheet)sheet.classList.add("hidden");
    document.querySelector('[data-view="time"]')?.classList.add("active");
  }

  function bindTimer(){
    const btn=$("#timerToggle");if(btn&&!btn.dataset.v13Timer){btn.dataset.v13Timer="1";btn.onclick=startOrStopTimer;}
    const quick=$('[data-action="start-timer"]');if(quick&&!quick.dataset.v13Timer){quick.dataset.v13Timer="1";quick.onclick=startOrStopTimer;}
  }

  function groupSpend(){const g={};data.expenses.forEach(x=>g[x.project_id]=(g[x.project_id]||0)+Number(x.amount||0));return g;}
  function patchProjects(){
    const spend=groupSpend(),roles=Object.fromEntries(data.projects.map(p=>[p.id,p.role]));
    $$(".project-card").forEach(card=>{
      const open=card.querySelector(".choose-project");if(!open)return;const pid=open.dataset.id,meta=card.querySelector(".project-meta"),info=meta?.querySelector(":scope > div:first-child");
      if(info){setText(info.querySelector("small"),"Dépensé");setText(info.querySelector("strong"),money(spend[pid]||0));}
      if(meta&&!meta.querySelector(".v13-project-actions")){
        const actions=document.createElement("div");actions.className="v13-project-actions";open.parentNode.insertBefore(actions,open);actions.appendChild(open);
        const del=document.createElement("button");del.type="button";del.className="btn compact v13-danger v13-delete-project";del.dataset.id=pid;del.textContent="Supprimer";del.onclick=()=>deleteProject(pid);actions.appendChild(del);
      }
    });
  }

  async function deleteProject(pid){
    const p=data.projects.find(x=>x.id===pid),name=p?.name||"ce projet";
    
    if(!confirm(`Supprimer définitivement « ${name} » ?\n\nDépenses, heures, lots, membres et tickets seront supprimés. Cette action est irréversible.`))return;
    if(cloud){
      const paths=data.expenses.filter(x=>x.project_id===pid&&x.receipt_path).map(x=>x.receipt_path);
      if(paths.length){const r=await sb.storage.from("receipts").remove(paths);if(r.error)console.warn(r.error);}
      const {data:result,error}=await sb.rpc("delete_project",{p_project_id:pid});if(error)return toast(error.message.includes("delete_project")?"Exécute d'abord migration_v1_3.sql dans Supabase.":error.message);if(result!=="deleted")return toast(result||"Suppression impossible.");
    }else{
      const s=localState();s.projects=(s.projects||[]).filter(x=>x.id!==pid);s.expenses=(s.expenses||[]).filter(x=>x.project_id!==pid);s.workLogs=(s.workLogs||[]).filter(x=>x.project_id!==pid);s.lots=(s.lots||[]).filter(x=>x.project_id!==pid);
      if(s.currentProjectId===pid)s.currentProjectId=s.projects[0]?.id||null;
      if(!s.projects.length){const id=uid();s.projects=[{id,name:"Mon chantier",address:"",budget:0,role:"owner",created_at:new Date().toISOString()}];s.currentProjectId=id;s.lots=DEFAULT_LOTS.map(n=>({id:uid(),project_id:id,name:n,budget:0,hourly_rate:45}));}
      saveLocal(s);
    }
    toast("Projet supprimé.");setTimeout(()=>location.reload(),450);
  }

  function currentLogs(){const pid=currentProjectId();return data.logs.filter(x=>x.project_id===pid);}
  function currentExpenses(){const pid=currentProjectId();return data.expenses.filter(x=>x.project_id===pid);}
  function currentLots(){const pid=currentProjectId();return data.lots.filter(x=>x.project_id===pid);}
  function timeByLot(){const g={};currentLogs().forEach(x=>g[x.lot||"Divers"]=(g[x.lot||"Divers"]||0)+effectiveMinutes(x)/60);return g;}
  function laborByLot(){const g={};currentLogs().forEach(x=>g[x.lot||"Divers"]=(g[x.lot||"Divers"]||0)+(effectiveMinutes(x)/60)*Number(x.hourly_rate||0));return g;}

  function updateChart(id,values){
    const canvas=document.getElementById(id);if(!canvas||!window.Chart)return;const chart=Chart.getChart(canvas);if(!chart)return;const entries=Object.entries(values).filter(([,v])=>Number(v)>0).sort((a,b)=>b[1]-a[1]);chart.data.labels=entries.map(x=>x[0]);if(chart.data.datasets[0])chart.data.datasets[0].data=entries.map(x=>x[1]);chart.update("none");
  }

  function patchHours(){
    const logs=currentLogs();if(!logs.length&& !currentProjectId())return;const minutes=logs.reduce((s,x)=>s+effectiveMinutes(x),0),labor=logs.reduce((s,x)=>s+(effectiveMinutes(x)/60)*Number(x.hourly_rate||0),0),spent=currentExpenses().reduce((s,x)=>s+Number(x.amount||0),0);
    setText($("#kpiHours"),hoursLabel(minutes));setText($("#kpiLabor"),money(labor));setText($("#kpiTotalValue"),money(spent+labor));
    $$(".delete-time").forEach(btn=>{const log=logs.find(x=>x.id===btn.dataset.id);if(!log)return;const value=btn.closest(".list-value");if(!value)return;const c=crew(log),main=hoursLabel(effectiveMinutes(log)),detail=c>1?`<small class="v13-crew-detail">${hoursLabel(log.minutes)} × ${c} personnes</small>`:"";const desired=`${main}${detail}<br>`;if(value.dataset.v13Value!==`${main}|${c}`){value.dataset.v13Value=`${main}|${c}`;value.innerHTML=desired;value.appendChild(btn);}});
    const tg=timeByLot(),lg=laborByLot();updateChart("bilanTimeChart",tg);updateChart("bilanTimeOnlyChart",tg);
    const timeList=$("#bilanTimeList");if(timeList){const lots=currentLots(),names=[...new Set([...lots.map(l=>l.name),...Object.keys(tg)])].filter(n=>(tg[n]||0)>0);const html=names.map(n=>{const lot=lots.find(l=>l.name===n),rate=Number(lot?.hourly_rate||45);return `<div class="time-budget-row"><div><strong>${n}</strong><small>Taux configuré : ${money(rate)}/h</small></div><div><span>${(tg[n]||0).toFixed(1)} h</span><strong>${money(lg[n]||0)}</strong></div></div>`}).join("")||'<div class="empty-state">Aucune donnée.</div>';if(timeList.innerHTML!==html)timeList.innerHTML=html;}
    $$("#lotSummary .budget-table-row:not(.header)").forEach(row=>{const name=row.querySelector("strong")?.textContent,children=row.children;if(name&&children.length>=6){setText(children[4],`${(tg[name]||0).toFixed(1)} h`);setText(children[5],money(lg[name]||0));}});
    setText($("#bilanLaborTotal"),money(labor));setText($("#bilanLaborHint"),`${hoursLabel(minutes)} valorisées`);
    const active=$("[data-bilan].active")?.dataset.bilan;if(active==="time"){setText($("#bilanGrandTotal"),hoursLabel(minutes));setText($("#bilanSentence"),`Valeur théorique de la main-d'œuvre : ${money(labor)}.`);}else if(active==="global"){setText($("#bilanGrandTotal"),money(spent+labor));}
  }

  function patchVersion(){setText($("#heroBadge"),"V1.3");}
  function patchAll(){
    if(patchBusy)return;patchBusy=true;
    try{injectStyles();injectCrewField();bindTimeForm();bindTimer();patchVersion();patchProjects();patchHours();}finally{patchBusy=false;}
  }

  function schedulePatch(){clearTimeout(schedulePatch.t);schedulePatch.t=setTimeout(patchAll,80);}
  async function refreshAndPatch(){await refreshData();patchAll();}

  async function init(){
    injectStyles();injectCrewField();bindTimeForm();bindTimer();
    await refreshAndPatch();
    const obs=new MutationObserver(schedulePatch);obs.observe(document.body,{childList:true,subtree:true});
    document.addEventListener("click",e=>{if(e.target.closest(".delete-expense,.edit-expense,.choose-project,[data-go]"))setTimeout(refreshAndPatch,900);});
    $("#expenseForm")?.addEventListener("submit",()=>setTimeout(refreshAndPatch,1200));
    setInterval(refreshAndPatch,15000);
    console.info(`Bati'Coût patch V${VERSION} actif`);
  }

  if(document.readyState==="complete")init();else window.addEventListener("load",init,{once:true});
})();
