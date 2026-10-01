-- ============================================================
-- Bati'Coût — migration V1.2 -> V1.3
-- À exécuter UNE SEULE FOIS dans Supabase SQL Editor.
-- ============================================================

-- Nombre de personnes affectées à une saisie de temps (1 à 5).
alter table public.work_logs
  add column if not exists crew_count smallint not null default 1
  check (crew_count between 1 and 5);

update public.work_logs
set crew_count = 1
where crew_count is null;

-- Le propriétaire d'un projet peut supprimer les tickets du projet,
-- y compris ceux envoyés par un autre membre.
drop policy if exists "receipt delete project owner" on storage.objects;
create policy "receipt delete project owner"
on storage.objects for delete to authenticated
using (
  bucket_id='receipts'
  and array_length(storage.foldername(name),1) >= 2
  and public.project_role(((storage.foldername(name))[2])::uuid) = 'owner'
);

-- Suppression définitive d'un projet par son propriétaire.
-- Les tables liées sont supprimées grâce aux ON DELETE CASCADE déjà en place.
create or replace function public.delete_project(p_project_id uuid)
returns text
language plpgsql
security definer set search_path=''
as $$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  if public.project_role(p_project_id) <> 'owner' then
    raise exception 'Seul le propriétaire peut supprimer ce projet';
  end if;

  delete from public.projects where id=p_project_id;
  if not found then return 'Projet introuvable'; end if;
  return 'deleted';
end;
$$;

-- Important : une fonction SECURITY DEFINER est exécutable par PUBLIC par défaut.
-- On limite donc explicitement cet RPC aux utilisateurs authentifiés.
revoke all on function public.delete_project(uuid) from public;
revoke all on function public.delete_project(uuid) from anon;
grant execute on function public.delete_project(uuid) to authenticated;
