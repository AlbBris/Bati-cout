-- ============================================================
-- Bati'Coût — migration V1.1 -> V1.2
-- À exécuter UNE SEULE FOIS dans Supabase SQL Editor
-- uniquement si la V1.1 est déjà installée.
-- ============================================================

-- 1) Paramétrage financier et MO des lots
alter table public.project_lots
  add column if not exists budget numeric(12,2) not null default 0 check (budget >= 0),
  add column if not exists hourly_rate numeric(10,2) not null default 45 check (hourly_rate >= 0);

-- On reprend si possible un taux déjà réellement utilisé sur le lot.
update public.project_lots pl
set hourly_rate = src.avg_rate
from (
  select project_id, lot, round(avg(hourly_rate)::numeric,2) as avg_rate
  from public.work_logs
  where hourly_rate is not null and hourly_rate >= 0
  group by project_id, lot
) src
where src.project_id = pl.project_id
  and src.lot = pl.name
  and pl.hourly_rate = 45;

-- 2) Personne ayant réellement payé une dépense
alter table public.expenses
  add column if not exists paid_by_user_id uuid references public.profiles(id);

-- Pour les anciennes dépenses, on considère que le saisissant était le payeur.
update public.expenses
set paid_by_user_id = user_id
where paid_by_user_id is null;

create index if not exists expenses_paid_by_idx on public.expenses(paid_by_user_id);

-- 3) Autoriser les admins/propriétaires à modifier budget et taux des lots
alter table public.project_lots enable row level security;
drop policy if exists "project lots admins update" on public.project_lots;
create policy "project lots admins update"
on public.project_lots for update
using (public.project_role(project_id) in ('owner','admin'))
with check (public.project_role(project_id) in ('owner','admin'));

-- 4) Sécuriser le payeur : il doit appartenir au projet quand il est renseigné.
-- On remplace les politiques INSERT/UPDATE des dépenses de manière idempotente.
drop policy if exists "expenses contributors insert" on public.expenses;
create policy "expenses contributors insert"
on public.expenses for insert
with check (
  public.project_role(project_id) in ('owner','admin','member')
  and user_id = auth.uid()
  and (
    paid_by_user_id is null
    or exists (
      select 1 from public.project_members pm
      where pm.project_id = expenses.project_id
        and pm.user_id = expenses.paid_by_user_id
    )
  )
);

drop policy if exists "expenses own or admin update" on public.expenses;
create policy "expenses own or admin update"
on public.expenses for update
using (
  user_id = auth.uid()
  or public.project_role(project_id) in ('owner','admin')
)
with check (
  (user_id = auth.uid() or public.project_role(project_id) in ('owner','admin'))
  and (
    paid_by_user_id is null
    or exists (
      select 1 from public.project_members pm
      where pm.project_id = expenses.project_id
        and pm.user_id = expenses.paid_by_user_id
    )
  )
);

-- 5) Valeur par défaut à l'avenir : aucun changement structurel supplémentaire.
-- Les lignes de tickets créées en V1.1 restent compatibles avec la V1.2.
