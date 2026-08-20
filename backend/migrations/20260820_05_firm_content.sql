-- Phase 3 of the firm structure plan (docs/FIRM_STRUCTURE_PLAN.md):
-- one shared library of templates and letterhead, workflows the firm can
-- publish, and the firm's own standing instructions riding every chat.
--
-- The rule everywhere below is the same: a row with no firm on it is somebody's
-- own private thing and behaves exactly as it always has. A row with a firm on
-- it belongs to the firm, and everyone still working there can read it.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Marking library folders, documents and workflows as the firm's
-- ---------------------------------------------------------------------------

alter table public.library_folders add column if not exists
  firm_id uuid references public.firms(id) on delete cascade;

alter table public.documents add column if not exists
  firm_id uuid references public.firms(id) on delete set null;

alter table public.workflows add column if not exists
  firm_id uuid references public.firms(id) on delete cascade;

create index if not exists library_folders_firm_idx
  on public.library_folders(firm_id, library_kind)
  where firm_id is not null;

create index if not exists documents_firm_library_idx
  on public.documents(firm_id, library_kind, library_folder_id)
  where firm_id is not null and project_id is null;

create index if not exists workflows_firm_idx
  on public.workflows(firm_id)
  where firm_id is not null;

-- ---------------------------------------------------------------------------
-- The library, read either as your own or as the firm's
-- ---------------------------------------------------------------------------
--
-- Each of these three used to answer "what is in this person's library". They
-- now answer that same question when no firm is passed, and "what is in the
-- firm's library" when one is. Adding an argument means the old shape has to be
-- dropped first; nothing calls them mid-flight but the backend, which is
-- restarted with this change.

drop function if exists public.search_library_documents(
  text, text, integer, integer, text, text, text, text);

create or replace function public.search_library_documents(
  p_user_id text,
  p_library_kind text,
  p_limit integer,
  p_offset integer,
  p_search_term text default null,
  p_file_type text default null,
  p_sort_key text default 'updated',
  p_sort_direction text default 'desc',
  p_firm_id text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  firm_id uuid,
  status text,
  folder_id uuid,
  library_kind text,
  library_folder_id uuid,
  current_version_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  filename text,
  file_type text,
  storage_path text,
  pdf_storage_path text,
  size_bytes integer,
  page_count integer,
  active_version_number integer
)
language sql
stable
as $$
  select
    d.id,
    d.project_id,
    d.user_id::text as user_id,
    d.firm_id,
    d.status,
    d.folder_id,
    d.library_kind,
    d.library_folder_id,
    d.current_version_id,
    d.created_at,
    d.updated_at,
    coalesce(nullif(trim(v.filename), ''), 'Untitled document') as filename,
    v.file_type,
    v.storage_path,
    v.pdf_storage_path,
    v.size_bytes,
    v.page_count,
    v.version_number as active_version_number
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.project_id is null
    and (
      case when p_firm_id is null
        then d.user_id::text = p_user_id and d.firm_id is null
        else d.firm_id::text = p_firm_id
      end
    )
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(v.filename, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(v.filename, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then lower(coalesce(v.file_type, '')) else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then lower(coalesce(v.file_type, '')) else null end desc,
    case when p_sort_key = 'size' and p_sort_direction = 'asc' then v.size_bytes else null end asc,
    case when p_sort_key = 'size' and p_sort_direction = 'desc' then v.size_bytes else null end desc,
    case when p_sort_key = 'version' and p_sort_direction = 'asc' then v.version_number else null end asc,
    case when p_sort_key = 'version' and p_sort_direction = 'desc' then v.version_number else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then d.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then d.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then d.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then d.updated_at else null end desc,
    d.updated_at desc,
    d.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.get_library_filter_options(text, text);

create or replace function public.get_library_filter_options(
  p_user_id text,
  p_library_kind text,
  p_firm_id text default null
)
returns table (file_types text[])
language sql
stable
as $$
  select coalesce(
    array_agg(distinct lower(v.file_type) order by lower(v.file_type))
      filter (where nullif(trim(v.file_type), '') is not null),
    array[]::text[]
  ) as file_types
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.project_id is null
    and (
      case when p_firm_id is null
        then d.user_id::text = p_user_id and d.firm_id is null
        else d.firm_id::text = p_firm_id
      end
    )
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    );
$$;

drop function if exists public.get_library_document_ids(
  text, text, text, text, integer, integer);

create or replace function public.get_library_document_ids(
  p_user_id text,
  p_library_kind text,
  p_search_term text,
  p_file_type text,
  p_limit integer,
  p_offset integer,
  p_firm_id text default null
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  select d.id, d.user_id::text as user_id
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.project_id is null
    and (
      case when p_firm_id is null
        then d.user_id::text = p_user_id and d.firm_id is null
        else d.firm_id::text = p_firm_id
      end
    )
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by d.updated_at desc, d.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ---------------------------------------------------------------------------
-- Workflow lists now include the ones the firm has published
-- ---------------------------------------------------------------------------
--
-- Both list queries gain a "where it came from" column, so the page can say
-- whether a workflow is yours, someone's who shared it with you, or the
-- firm's. A returned column cannot be added in place, so each is dropped and
-- recreated. The three ways a workflow can reach you are gathered once here,
-- so the list and the id-only list can never drift apart. A workflow that
-- reaches you two ways at once — you wrote it and the firm published it, or it
-- was both emailed to you and published — is listed once, under the closest
-- of the three.

create or replace function public.visible_workflows(
  p_user_id text,
  p_user_email text default null,
  p_type text default null
)
returns table (
  id uuid,
  user_id text,
  title text,
  type text,
  prompt_md text,
  columns_config jsonb,
  language text,
  practice text,
  jurisdictions text[],
  is_system boolean,
  created_at timestamptz,
  allow_edit boolean,
  is_owner boolean,
  shared_by_name text,
  scope text,
  sort_bucket integer
)
language sql
stable
as $$
  with mine as (
    select
      w.id, w.user_id::text as user_id, w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      true as allow_edit, true as is_owner, null::text as shared_by_name,
      case when w.firm_id is null then 'personal' else 'firm' end as scope,
      0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select
      w.id, w.user_id::text as user_id, w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      ws.allow_edit, false as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      'shared' as scope,
      1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id::text
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and (p_type is null or w.type = p_type)
  ),
  published as (
    select
      w.id, w.user_id::text as user_id, w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      false as allow_edit, false as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      'firm' as scope,
      2 as sort_bucket
    from public.workflows w
    left join public.user_profiles up
      on up.user_id::text = w.user_id::text
    where w.firm_id is not null
      and w.firm_id = public.active_member_firm_id(p_user_id)
      and (p_type is null or w.type = p_type)
  ),
  everything as (
    select * from mine
    union all
    select * from shared
    union all
    select * from published
  )
  select distinct on (e.id)
    e.id, e.user_id, e.title, e.type, e.prompt_md, e.columns_config,
    e.language, e.practice, e.jurisdictions, e.is_system, e.created_at,
    e.allow_edit, e.is_owner, e.shared_by_name, e.scope, e.sort_bucket
  from everything e
  order by e.id, e.sort_bucket asc;
$$;

drop function if exists public.get_workflows_overview(text, text, text);

create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text default null,
  p_type text default null
)
returns table (
  id uuid,
  user_id text,
  title text,
  type text,
  prompt_md text,
  columns_config jsonb,
  language text,
  practice text,
  jurisdictions text[],
  is_system boolean,
  created_at timestamptz,
  allow_edit boolean,
  is_owner boolean,
  shared_by_name text,
  scope text
)
language sql
stable
as $$
  select
    vw.id, vw.user_id, vw.title, vw.type, vw.prompt_md, vw.columns_config,
    vw.language, vw.practice, vw.jurisdictions, vw.is_system, vw.created_at,
    vw.allow_edit, vw.is_owner, vw.shared_by_name, vw.scope
  from public.visible_workflows(p_user_id, p_user_email, p_type) vw
  order by vw.sort_bucket asc, vw.created_at desc, vw.id asc;
$$;

drop function if exists public.get_workflows_overview(
  text, text, text, text, integer, integer, text, text, text, text, text, text);

create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text,
  p_type text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_language text,
  p_jurisdiction text
)
returns table (
  id uuid,
  user_id text,
  title text,
  type text,
  prompt_md text,
  columns_config jsonb,
  language text,
  practice text,
  jurisdictions text[],
  is_system boolean,
  created_at timestamptz,
  allow_edit boolean,
  is_owner boolean,
  shared_by_name text,
  scope text
)
language sql
stable
as $$
  select
    vw.id, vw.user_id, vw.title, vw.type, vw.prompt_md, vw.columns_config,
    vw.language, vw.practice, vw.jurisdictions, vw.is_system, vw.created_at,
    vw.allow_edit, vw.is_owner, vw.shared_by_name, vw.scope
  from public.visible_workflows(p_user_id, p_user_email, p_type) vw
  where (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.is_owner)
      or (p_scope = 'shared' and vw.sort_bucket = 1)
      or (p_scope = 'firm' and vw.scope = 'firm')
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(vw.title) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or vw.practice = p_practice)
    and (p_language is null or vw.language = p_language)
    and (p_jurisdiction is null or vw.jurisdictions @> array[p_jurisdiction])
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vw.title, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vw.title, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then vw.type else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then vw.type else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vw.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vw.created_at else null end desc,
    vw.sort_bucket asc,
    vw.created_at desc,
    vw.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.get_workflow_ids_overview(
  text, text, text, text, text, text, text, text, integer, integer);

create or replace function public.get_workflow_ids_overview(
  p_user_id text,
  p_user_email text,
  p_type text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_language text,
  p_jurisdiction text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  select vw.id, vw.user_id
  from public.visible_workflows(p_user_id, p_user_email, p_type) vw
  where (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.is_owner)
      or (p_scope = 'shared' and vw.sort_bucket = 1)
      or (p_scope = 'firm' and vw.scope = 'firm')
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(vw.title) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or vw.practice = p_practice)
    and (p_language is null or vw.language = p_language)
    and (p_jurisdiction is null or vw.jurisdictions @> array[p_jurisdiction])
  order by vw.sort_bucket asc, vw.created_at desc, vw.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- The filter choices on the workflows page have to match what the list shows,
-- so they are drawn from the same three ways a workflow reaches you.

create or replace function public.get_workflow_filter_options(
  p_user_id text,
  p_user_email text default null,
  p_type text default null,
  p_scope text default 'all'
)
returns table (
  practices text[],
  languages text[],
  jurisdictions text[]
)
language sql
stable
as $$
  with scoped as (
    select vw.practice, vw.language, vw.jurisdictions
    from public.visible_workflows(p_user_id, p_user_email, p_type) vw
    where coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.is_owner)
      or (p_scope = 'shared' and vw.sort_bucket = 1)
      or (p_scope = 'firm' and vw.scope = 'firm')
  )
  select
    coalesce(
      array_agg(distinct nullif(trim(practice), '') order by nullif(trim(practice), ''))
        filter (where nullif(trim(practice), '') is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      array_agg(distinct nullif(trim(language), '') order by nullif(trim(language), ''))
        filter (where nullif(trim(language), '') is not null),
      array[]::text[]
    ) as languages,
    coalesce(
      (select array_agg(distinct jurisdiction order by jurisdiction)
       from scoped s
       cross join lateral unnest(coalesce(s.jurisdictions, array[]::text[])) jurisdiction
       where nullif(trim(jurisdiction), '') is not null),
      array[]::text[]
    ) as jurisdictions
  from scoped;
$$;
