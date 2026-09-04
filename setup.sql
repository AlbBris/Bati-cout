-- ============================================================
-- Bati'Coût V1 — Schéma Supabase
-- À exécuter dans Supabase > SQL Editor sur un nouveau projet.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  budget numeric(12,2) not null default 0,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner','admin','member','viewer')) default 'member',
  created_at timestamptz not null default now(),
  primary key(project_id,user_id)
);

create table if not exists public.project_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin','member','viewer')) default 'member',
  invited_by uuid not null references public.profiles(id),
  status text not null default 'pending' check(status in ('pending','accepted','revoked')),
  created_at timestamptz not null default now(),
  unique(project_id,email)
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  merchant text,
  date date not null default current_date,
  amount numeric(12,2) not null check(amount >= 0),
  vat numeric(12,2),
  category text not null default 'Divers',
  lot text not null default 'Divers',
  description text,
  receipt_path text,
  created_at timestamptz not null default now()
);

create table if not exists public.work_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  date date not null default current_date,
  start_time time,
  end_time time,
  minutes integer not null check(minutes > 0),
  lot text not null default 'Divers',
  task text not null,
  hourly_rate numeric(10,2) not null default 0 check(hourly_rate >= 0),
  notes text,
  created_at timestamptz not null default now()
);

-- -------- Profil automatique à l'inscription --------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles(id,email,display_name)
  values(new.id,lower(new.email),coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;

  -- Accepte automatiquement les invitations déjà créées pour cet e-mail.
  insert into public.project_members(project_id,user_id,role)
  select i.project_id,new.id,i.role
  from public.project_invites i
  where lower(i.email)=lower(new.email) and i.status='pending'
  on conflict(project_id,user_id) do nothing;

  update public.project_invites set status='accepted'
  where lower(email)=lower(new.email) and status='pending';

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users for each row execute procedure public.handle_new_user();

-- -------- Helpers d'autorisation --------
create or replace function public.is_project_member(pid uuid)
returns boolean language sql stable security definer set search_path=''
as $$ select exists(select 1 from public.project_members pm where pm.project_id=pid and pm.user_id=auth.uid()); $$;

create or replace function public.project_role(pid uuid)
returns text language sql stable security definer set search_path=''
as $$ select pm.role from public.project_members pm where pm.project_id=pid and pm.user_id=auth.uid() limit 1; $$;

-- -------- Création projet + propriétaire --------
create or replace function public.create_project_with_owner(p_name text,p_address text default '',p_budget numeric default 0)
returns uuid
language plpgsql security definer set search_path=''
as $$
declare pid uuid;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  insert into public.projects(name,address,budget,created_by)
  values(p_name,p_address,coalesce(p_budget,0),auth.uid()) returning id into pid;
  insert into public.project_members(project_id,user_id,role) values(pid,auth.uid(),'owner');
  return pid;
end;
$$;

-- -------- Invitation par adresse e-mail --------
create or replace function public.invite_project_member(p_project_id uuid,p_email text,p_role text default 'member')
returns text
language plpgsql security definer set search_path=''
as $$
declare target uuid;
begin
  if public.project_role(p_project_id) not in ('owner','admin') then
    raise exception 'Droits insuffisants';
  end if;
  if p_role not in ('admin','member','viewer') then raise exception 'Rôle invalide'; end if;

  select id into target from public.profiles where lower(email)=lower(p_email) limit 1;
  if target is not null then
    insert into public.project_members(project_id,user_id,role)
    values(p_project_id,target,p_role)
    on conflict(project_id,user_id) do update set role=excluded.role;
    return 'added';
  end if;

  insert into public.project_invites(project_id,email,role,invited_by,status)
  values(p_project_id,lower(p_email),p_role,auth.uid(),'pending')
  on conflict(project_id,email) do update set role=excluded.role,status='pending',invited_by=auth.uid();
  return 'pending';
end;
$$;

-- -------- RLS --------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.project_invites enable row level security;
alter table public.expenses enable row level security;
alter table public.work_logs enable row level security;

create policy "profiles self read" on public.profiles for select using (id=auth.uid());
create policy "profiles same project read" on public.profiles for select using (
  exists (
    select 1 from public.project_members a
    join public.project_members b on a.project_id=b.project_id
    where a.user_id=auth.uid() and b.user_id=profiles.id
  )
);
create policy "projects members read" on public.projects for select using (public.is_project_member(id));
create policy "project members read" on public.project_members for select using (public.is_project_member(project_id));
create policy "invites admins read" on public.project_invites for select using (public.project_role(project_id) in ('owner','admin'));

create policy "expenses members read" on public.expenses for select using (public.is_project_member(project_id));
create policy "expenses contributors insert" on public.expenses for insert with check (
  public.project_role(project_id) in ('owner','admin','member') and user_id=auth.uid()
);
create policy "expenses own or admin update" on public.expenses for update using (
  user_id=auth.uid() or public.project_role(project_id) in ('owner','admin')
);
create policy "expenses own or admin delete" on public.expenses for delete using (
  user_id=auth.uid() or public.project_role(project_id) in ('owner','admin')
);

create policy "work members read" on public.work_logs for select using (public.is_project_member(project_id));
create policy "work contributors insert" on public.work_logs for insert with check (
  public.project_role(project_id) in ('owner','admin','member') and user_id=auth.uid()
);
create policy "work own or admin update" on public.work_logs for update using (
  user_id=auth.uid() or public.project_role(project_id) in ('owner','admin')
);
create policy "work own or admin delete" on public.work_logs for delete using (
  user_id=auth.uid() or public.project_role(project_id) in ('owner','admin')
);

-- -------- Vues utilisées par l'application --------
create or replace view public.projects_visible
with (security_invoker=true)
as
select p.*, pm.role
from public.projects p
join public.project_members pm on pm.project_id=p.id
where pm.user_id=auth.uid();

create or replace view public.project_team_view
with (security_invoker=true)
as
select pm.project_id,pm.user_id,pm.role,pr.email,pr.display_name
from public.project_members pm
join public.profiles pr on pr.id=pm.user_id;

grant select on public.projects_visible to authenticated;
grant select on public.project_team_view to authenticated;
grant execute on function public.create_project_with_owner(text,text,numeric) to authenticated;
grant execute on function public.invite_project_member(uuid,text,text) to authenticated;

-- -------- Stockage privé des tickets --------
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('receipts','receipts',false,6291456,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict(id) do update set public=false;

create policy "receipt upload own folder"
on storage.objects for insert to authenticated
with check (
  bucket_id='receipts'
  and (storage.foldername(name))[1]=auth.uid()::text
);

create policy "receipt read project member"
on storage.objects for select to authenticated
using (
  bucket_id='receipts'
  and public.is_project_member(((storage.foldername(name))[2])::uuid)
);

create policy "receipt delete own folder"
on storage.objects for delete to authenticated
using (
  bucket_id='receipts'
  and (storage.foldername(name))[1]=auth.uid()::text
);

-- ============================================================
-- V1.1 — Lots personnalisables + lignes de tickets multi-lots
-- ============================================================

create table if not exists public.project_lots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check(length(trim(name)) > 0),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create unique index if not exists project_lots_project_name_ci
on public.project_lots(project_id, lower(name));

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

-- Lots standards pour les projets déjà présents.
insert into public.project_lots(project_id,name,created_by)
select p.id, v.name, p.created_by
from public.projects p
cross join (values
 ('Terrassement'),('Gros œuvre'),('Maçonnerie'),('Charpente'),('Couverture'),('Menuiseries'),
 ('Isolation'),('Placo'),('Électricité'),('Plomberie'),('Chauffage'),('Carrelage'),('Peinture'),
 ('Aménagement extérieur'),('Divers')
) as v(name)
on conflict do nothing;

-- Conserve également tous les lots personnalisés déjà présents dans les anciennes données.
insert into public.project_lots(project_id,name,created_by)
select distinct e.project_id, e.lot, p.created_by
from public.expenses e join public.projects p on p.id=e.project_id
where e.lot is not null and trim(e.lot)<>''
on conflict do nothing;

insert into public.project_lots(project_id,name,created_by)
select distinct w.project_id, w.lot, p.created_by
from public.work_logs w join public.projects p on p.id=w.project_id
where w.lot is not null and trim(w.lot)<>''
on conflict do nothing;

alter table public.project_lots enable row level security;
alter table public.expense_items enable row level security;

create policy "project lots members read" on public.project_lots for select
using (public.is_project_member(project_id));
create policy "project lots admins insert" on public.project_lots for insert
with check (public.project_role(project_id) in ('owner','admin') and created_by=auth.uid());

create policy "expense items members read" on public.expense_items for select
using (public.is_project_member(project_id));
create policy "expense items contributors insert" on public.expense_items for insert
with check (
  public.project_role(project_id) in ('owner','admin','member')
  and exists(select 1 from public.expenses e where e.id=expense_id and e.project_id=project_id and (e.user_id=auth.uid() or public.project_role(project_id) in ('owner','admin')))
);
create policy "expense items own expense or admin update" on public.expense_items for update
using (
  exists(select 1 from public.expenses e where e.id=expense_id and (e.user_id=auth.uid() or public.project_role(project_id) in ('owner','admin')))
);
create policy "expense items own expense or admin delete" on public.expense_items for delete
using (
  exists(select 1 from public.expenses e where e.id=expense_id and (e.user_id=auth.uid() or public.project_role(project_id) in ('owner','admin')))
);

-- Nouvelle création de projet : initialise automatiquement les lots standards.
create or replace function public.create_project_with_owner(p_name text,p_address text default '',p_budget numeric default 0)
returns uuid
language plpgsql security definer set search_path=''
as $$
declare pid uuid;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  insert into public.projects(name,address,budget,created_by)
  values(p_name,p_address,coalesce(p_budget,0),auth.uid()) returning id into pid;
  insert into public.project_members(project_id,user_id,role) values(pid,auth.uid(),'owner');

  insert into public.project_lots(project_id,name,created_by)
  select pid, v.name, auth.uid()
  from (values
   ('Terrassement'),('Gros œuvre'),('Maçonnerie'),('Charpente'),('Couverture'),('Menuiseries'),
   ('Isolation'),('Placo'),('Électricité'),('Plomberie'),('Chauffage'),('Carrelage'),('Peinture'),
   ('Aménagement extérieur'),('Divers')
  ) as v(name);
  return pid;
end;
$$;

-- Suppression sécurisée d'un lot : impossible dès qu'une donnée le référence.
create or replace function public.delete_project_lot(p_lot_id uuid)
returns text
language plpgsql security definer set search_path=''
as $$
declare pid uuid; lname text; usage_count integer;
begin
  select pl.project_id,pl.name into pid,lname from public.project_lots pl where pl.id=p_lot_id;
  if pid is null then return 'Lot introuvable'; end if;
  if public.project_role(pid) not in ('owner','admin') then raise exception 'Droits insuffisants'; end if;

  select
    (select count(*) from public.expenses e where e.project_id=pid and e.lot=lname)
    + (select count(*) from public.expense_items i where i.project_id=pid and i.lot=lname)
    + (select count(*) from public.work_logs w where w.project_id=pid and w.lot=lname)
  into usage_count;

  if usage_count > 0 then return 'Lot utilisé dans ' || usage_count || ' donnée(s) : suppression impossible'; end if;
  delete from public.project_lots where id=p_lot_id;
  return 'deleted';
end;
$$;

grant execute on function public.delete_project_lot(uuid) to authenticated;

-- ============================================================
-- V1.2 — Budget/taux par lot + payeur des dépenses
-- ============================================================
alter table public.project_lots
  add column if not exists budget numeric(12,2) not null default 0 check (budget >= 0),
  add column if not exists hourly_rate numeric(10,2) not null default 45 check (hourly_rate >= 0);

alter table public.expenses
  add column if not exists paid_by_user_id uuid references public.profiles(id);

update public.expenses set paid_by_user_id=user_id where paid_by_user_id is null;
create index if not exists expenses_paid_by_idx on public.expenses(paid_by_user_id);

drop policy if exists "project lots admins update" on public.project_lots;
create policy "project lots admins update" on public.project_lots for update
using (public.project_role(project_id) in ('owner','admin'))
with check (public.project_role(project_id) in ('owner','admin'));

drop policy if exists "expenses contributors insert" on public.expenses;
create policy "expenses contributors insert" on public.expenses for insert
with check (
  public.project_role(project_id) in ('owner','admin','member') and user_id=auth.uid()
  and (paid_by_user_id is null or exists(select 1 from public.project_members pm where pm.project_id=expenses.project_id and pm.user_id=expenses.paid_by_user_id))
);

drop policy if exists "expenses own or admin update" on public.expenses;
create policy "expenses own or admin update" on public.expenses for update
using (user_id=auth.uid() or public.project_role(project_id) in ('owner','admin'))
with check (
  (user_id=auth.uid() or public.project_role(project_id) in ('owner','admin'))
  and (paid_by_user_id is null or exists(select 1 from public.project_members pm where pm.project_id=expenses.project_id and pm.user_id=expenses.paid_by_user_id))
);
