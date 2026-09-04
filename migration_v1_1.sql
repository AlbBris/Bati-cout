-- Bati'Coût — migration V1 -> V1.1
-- À exécuter UNE SEULE FOIS dans Supabase SQL Editor si la V1 est déjà configurée en ligne.

create table if not exists public.project_lots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check(length(trim(name)) > 0),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create unique index if not exists project_lots_project_name_ci on public.project_lots(project_id, lower(name));

create table if not exists public.expense_items (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  description text not null,
  amount numeric(12,2) not null check(amount >= 0),
  lot text not null,
  created_at timestamptz not null default now()
);
create index if not exists expense_items_expense_idx on public.expense_items(expense_id);
create index if not exists expense_items_project_idx on public.expense_items(project_id);

insert into public.project_lots(project_id,name,created_by)
select p.id,v.name,p.created_by from public.projects p cross join (values
 ('Terrassement'),('Gros œuvre'),('Maçonnerie'),('Charpente'),('Couverture'),('Menuiseries'),
 ('Isolation'),('Placo'),('Électricité'),('Plomberie'),('Chauffage'),('Carrelage'),('Peinture'),
 ('Aménagement extérieur'),('Divers')) as v(name)
on conflict do nothing;
insert into public.project_lots(project_id,name,created_by)
select distinct e.project_id,e.lot,p.created_by from public.expenses e join public.projects p on p.id=e.project_id where e.lot is not null and trim(e.lot)<>'' on conflict do nothing;
insert into public.project_lots(project_id,name,created_by)
select distinct w.project_id,w.lot,p.created_by from public.work_logs w join public.projects p on p.id=w.project_id where w.lot is not null and trim(w.lot)<>'' on conflict do nothing;

alter table public.project_lots enable row level security;
alter table public.expense_items enable row level security;

drop policy if exists "project lots members read" on public.project_lots;
drop policy if exists "project lots admins insert" on public.project_lots;
drop policy if exists "expense items members read" on public.expense_items;
drop policy if exists "expense items contributors insert" on public.expense_items;
drop policy if exists "expense items own expense or admin update" on public.expense_items;
drop policy if exists "expense items own expense or admin delete" on public.expense_items;

create policy "project lots members read" on public.project_lots for select using (public.is_project_member(project_id));
create policy "project lots admins insert" on public.project_lots for insert with check (public.project_role(project_id) in ('owner','admin') and created_by=auth.uid());
create policy "expense items members read" on public.expense_items for select using (public.is_project_member(project_id));
create policy "expense items contributors insert" on public.expense_items for insert with check (public.project_role(project_id) in ('owner','admin','member') and exists(select 1 from public.expenses e where e.id=expense_id and e.project_id=project_id and (e.user_id=auth.uid() or public.project_role(project_id) in ('owner','admin'))));
create policy "expense items own expense or admin update" on public.expense_items for update using (exists(select 1 from public.expenses e where e.id=expense_id and (e.user_id=auth.uid() or public.project_role(project_id) in ('owner','admin'))));
create policy "expense items own expense or admin delete" on public.expense_items for delete using (exists(select 1 from public.expenses e where e.id=expense_id and (e.user_id=auth.uid() or public.project_role(project_id) in ('owner','admin'))));

create or replace function public.create_project_with_owner(p_name text,p_address text default '',p_budget numeric default 0)
returns uuid language plpgsql security definer set search_path=''
as $$
declare pid uuid;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  insert into public.projects(name,address,budget,created_by) values(p_name,p_address,coalesce(p_budget,0),auth.uid()) returning id into pid;
  insert into public.project_members(project_id,user_id,role) values(pid,auth.uid(),'owner');
  insert into public.project_lots(project_id,name,created_by)
  select pid,v.name,auth.uid() from (values
   ('Terrassement'),('Gros œuvre'),('Maçonnerie'),('Charpente'),('Couverture'),('Menuiseries'),
   ('Isolation'),('Placo'),('Électricité'),('Plomberie'),('Chauffage'),('Carrelage'),('Peinture'),
   ('Aménagement extérieur'),('Divers')) as v(name);
  return pid;
end; $$;

create or replace function public.delete_project_lot(p_lot_id uuid)
returns text language plpgsql security definer set search_path=''
as $$
declare pid uuid;lname text;usage_count integer;
begin
  select pl.project_id,pl.name into pid,lname from public.project_lots pl where pl.id=p_lot_id;
  if pid is null then return 'Lot introuvable'; end if;
  if public.project_role(pid) not in ('owner','admin') then raise exception 'Droits insuffisants'; end if;
  select (select count(*) from public.expenses e where e.project_id=pid and e.lot=lname)
       + (select count(*) from public.expense_items i where i.project_id=pid and i.lot=lname)
       + (select count(*) from public.work_logs w where w.project_id=pid and w.lot=lname) into usage_count;
  if usage_count>0 then return 'Lot utilisé dans '||usage_count||' donnée(s) : suppression impossible'; end if;
  delete from public.project_lots where id=p_lot_id;
  return 'deleted';
end; $$;
grant execute on function public.delete_project_lot(uuid) to authenticated;
