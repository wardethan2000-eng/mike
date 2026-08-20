-- Mike Supabase schema
-- Use this for a fresh Supabase database. Existing deployments should instead
-- apply the dated incremental migration files in backend/migrations that are
-- newer than the version of Mike they currently have deployed.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- User profiles
-- ---------------------------------------------------------------------------

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text,
  display_name text,
  organisation text,
  tier text not null default 'Free',
  message_credits_used integer not null default 0,
  credits_reset_date timestamptz not null default (now() + interval '30 days'),
  title_model text,
  tabular_model text not null default 'gemini-3-flash-preview',
  quote_model text,
  mfa_on_login boolean not null default false,
  legal_research_us boolean not null default true,
  quick_actions_visible boolean not null default true,
  -- How this person signs: their title, the states they are admitted in and
  -- under what number, and the block that goes at the foot of a letter,
  -- stored exactly as they want it to appear.
  prof_title text,
  prof_phone text,
  practice_areas text[] not null default '{}',
  bar_admissions jsonb not null default '[]'::jsonb,
  signature_block text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_profiles_user
  on public.user_profiles(user_id);

create unique index if not exists user_profiles_email_lower_unique
  on public.user_profiles (lower(email))
  where email is not null and btrim(email) <> '';

create index if not exists idx_user_profiles_email
  on public.user_profiles(email);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id, email)
  values (new.id, lower(new.email))
  on conflict (user_id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
exception when others then
  -- Never block signup if the profile insert fails.
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('claude', 'gemini', 'openai', 'openrouter', 'courtlistener')),
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider)
);

create index if not exists idx_user_api_keys_user
  on public.user_api_keys(user_id);

alter table public.user_api_keys enable row level security;

create table if not exists public.user_mcp_connectors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  transport text not null default 'streamable_http'
    check (transport in ('streamable_http')),
  server_url text not null,
  auth_type text not null default 'none'
    check (auth_type in ('none', 'bearer', 'oauth')),
  enabled boolean not null default true,
  tool_policy jsonb not null default '{}'::jsonb,
  encrypted_auth_config text,
  auth_config_iv text,
  auth_config_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_connectors_user
  on public.user_mcp_connectors(user_id);

alter table public.user_mcp_connectors enable row level security;

create table if not exists public.user_mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  encrypted_access_token text,
  access_token_iv text,
  access_token_tag text,
  encrypted_refresh_token text,
  refresh_token_iv text,
  refresh_token_tag text,
  token_type text,
  scope text,
  expires_at timestamptz,
  authorization_server text,
  token_endpoint text,
  client_id text,
  encrypted_client_secret text,
  client_secret_iv text,
  client_secret_tag text,
  resource text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connector_id)
);

alter table public.user_mcp_oauth_tokens enable row level security;

create table if not exists public.user_mcp_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  state_hash text not null unique,
  encrypted_state_config text not null,
  state_config_iv text not null,
  state_config_tag text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_oauth_states_expires
  on public.user_mcp_oauth_states(expires_at);

alter table public.user_mcp_oauth_states enable row level security;

create table if not exists public.user_mcp_connector_tools (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_name text not null,
  openai_tool_name text not null,
  title text,
  description text,
  input_schema jsonb not null default '{"type":"object","properties":{}}'::jsonb,
  output_schema jsonb,
  annotations jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  requires_confirmation boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connector_id, tool_name),
  unique(openai_tool_name)
);

create index if not exists idx_user_mcp_connector_tools_connector
  on public.user_mcp_connector_tools(connector_id);

alter table public.user_mcp_connector_tools enable row level security;

create table if not exists public.user_mcp_tool_audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null references public.user_mcp_connectors(id) on delete cascade,
  tool_id uuid references public.user_mcp_connector_tools(id) on delete set null,
  tool_name text not null,
  openai_tool_name text not null,
  status text not null check (status in ('ok', 'error')),
  error_message text,
  duration_ms integer not null default 0,
  result_size_chars integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_mcp_tool_audit_logs_user_created
  on public.user_mcp_tool_audit_logs(user_id, created_at desc);

alter table public.user_mcp_tool_audit_logs enable row level security;

-- ---------------------------------------------------------------------------
-- Projects and documents
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The firm
-- ---------------------------------------------------------------------------
-- One row. Mike began as single-user accounts, where everything was "mine" and
-- sharing meant naming one colleague's email on one matter. A law firm needs
-- the opposite default: people belong to the firm, and most work is the firm's.
--
-- Everything below keys off firm_id even though there is only ever one row, so
-- that a second firm would be a data question rather than a rewrite.

create table if not exists public.firms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address_lines text[] not null default '{}',
  phone text,
  website text,
  -- Where the firm practises, and how it likes citations written. Sent as
  -- context with the firm's questions.
  default_jurisdiction text,
  citation_style text,
  -- A short note that rides along with every chat in the firm.
  standing_instructions text,
  -- Fonts and spacing used when a document is generated from scratch.
  drafting_defaults jsonb,
  -- Which models the firm allows. Null means every model the server offers.
  allowed_models jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Who belongs to the firm, and what they may do.
--
-- `admin` runs the firm's settings and people; `attorney` and `paralegal` are
-- the same in code today and differ in what they are given (a paralegal has no
-- bar number to sign with). Deactivation, not deletion, is how someone leaves:
-- their matters stay with the firm and get handed to a colleague.
create table if not exists public.firm_members (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null default 'attorney'
    check (role in ('admin', 'attorney', 'paralegal')),
  status text not null default 'active'
    check (status in ('active', 'deactivated')),
  -- Whether this person may change the firm's shared templates and forms.
  can_edit_firm_library boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists firm_members_firm_idx
  on public.firm_members(firm_id);

create index if not exists firm_members_firm_role_idx
  on public.firm_members(firm_id, role, status);

-- Joining is by invitation only. Mail here is a local catcher rather than a
-- real mail server, so an invitation is a link the admin passes on themselves;
-- the token is what makes it usable exactly once, by one address.
create table if not exists public.firm_invites (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  email text not null,
  role text not null default 'attorney'
    check (role in ('admin', 'attorney', 'paralegal')),
  token uuid not null unique default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  accepted_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists firm_invites_email_idx
  on public.firm_invites(lower(email));

create index if not exists firm_invites_firm_idx
  on public.firm_invites(firm_id, created_at desc);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  -- The responsible attorney. Deliberately `restrict`: a matter belongs to the
  -- firm, so deleting an account must not quietly take its matters with it.
  -- Whoever leaves has their matters handed over first.
  user_id uuid not null references auth.users(id) on delete restrict,
  firm_id uuid references public.firms(id) on delete set null,
  name text not null,
  cm_number text,
  practice text,
  -- Standing instructions for the matter, written by the lawyer and sent
  -- with every question asked inside it.
  overview text,
  -- 'private' — only the owner and anyone named in shared_with.
  -- 'firm'    — every active member of firm_id, plus anyone named.
  visibility text not null default 'private'
    check (visibility in ('private', 'firm')),
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user
  on public.projects(user_id);

create index if not exists projects_updated_at_idx
  on public.projects(updated_at desc, id);

create index if not exists projects_shared_with_idx
  on public.projects using gin (shared_with);

create index if not exists projects_firm_visibility_idx
  on public.projects(firm_id, visibility);

-- ---------------------------------------------------------------------------
-- Who can open a matter
-- ---------------------------------------------------------------------------
-- The rule lived in seven copies across the queries below, with a comment
-- asking whoever changed one to remember the other six. Firm visibility made
-- that a bad bet, so the rule is written once here and called from each.
--
-- Both helpers are single-statement SQL functions, which Postgres inlines into
-- the calling query, so this reads as a helper without costing a call per row.

create or replace function public.active_member_firm_id(p_user_id text)
returns uuid
language sql
stable
as $$
  select fm.firm_id
  from public.firm_members fm
  where fm.user_id::text = p_user_id
    and fm.status = 'active'
  limit 1;
$$;

create or replace function public.can_access_project(
  p_owner_id uuid,
  p_shared_with jsonb,
  p_visibility text,
  p_project_firm_id uuid,
  p_user_id text,
  p_user_email text
)
returns boolean
language sql
stable
as $$
  select
    -- The responsible attorney.
    p_owner_id::text = p_user_id
    -- Someone named on the matter by email.
    or (
      coalesce(p_user_email, '') <> ''
      and p_owner_id::text <> p_user_id
      and p_shared_with @> jsonb_build_array(p_user_email)
    )
    -- Anyone still working at the firm, when the matter is the firm's.
    or (
      coalesce(p_visibility, 'private') = 'firm'
      and p_project_firm_id is not null
      and p_owner_id::text <> p_user_id
      and p_project_firm_id = public.active_member_firm_id(p_user_id)
    );
$$;

create table if not exists public.project_subfolders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  parent_folder_id uuid references public.project_subfolders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_subfolders_project
  on public.project_subfolders(project_id);

create table if not exists public.library_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  library_kind text not null default 'file',
  name text not null,
  parent_folder_id uuid references public.library_folders(id) on delete cascade,
  -- No firm means it is this person's own folder; a firm means it belongs to
  -- the firm and everyone still working there can read what is in it.
  firm_id uuid references public.firms(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint library_folders_kind_check
    check (library_kind in ('file', 'template'))
);

create index if not exists idx_library_folders_user_kind
  on public.library_folders(user_id, library_kind);

create index if not exists idx_library_folders_parent
  on public.library_folders(parent_folder_id);

create index if not exists library_folders_firm_idx
  on public.library_folders(firm_id, library_kind)
  where firm_id is not null;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  folder_id uuid references public.project_subfolders(id) on delete set null,
  library_kind text not null default 'file',
  library_folder_id uuid references public.library_folders(id) on delete set null,
  -- Set only on library documents that belong to the firm rather than to one
  -- person. Documents inside a matter are reached through the matter instead.
  firm_id uuid references public.firms(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_library_kind_check
    check (library_kind in ('file', 'template'))
);

create index if not exists idx_documents_user_project
  on public.documents(user_id, project_id);

create index if not exists idx_documents_project_folder
  on public.documents(project_id, folder_id);

create index if not exists idx_documents_library_kind_folder
  on public.documents(user_id, library_kind, library_folder_id)
  where project_id is null;

create index if not exists documents_firm_library_idx
  on public.documents(firm_id, library_kind, library_folder_id)
  where firm_id is not null and project_id is null;

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text,
  pdf_storage_path text,
  source text not null default 'upload',
  version_number integer,
  filename text,
  file_type text,
  size_bytes integer,
  page_count integer,
  content_sha256 text,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text
    ]))
);

create index if not exists document_versions_document_id_idx
  on public.document_versions(document_id, created_at desc);

create index if not exists document_versions_active_document_id_idx
  on public.document_versions(document_id, created_at desc)
  where deleted_at is null;

create index if not exists document_versions_doc_vnum_idx
  on public.document_versions(document_id, version_number);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_versions_doc_version_unique'
      and conrelid = 'public.document_versions'::regclass
  ) then
    alter table public.document_versions
      add constraint document_versions_doc_version_unique
      unique (document_id, version_number);
  end if;
end;
$$;

alter table public.documents
  add column if not exists current_version_id uuid
  references public.document_versions(id) on delete set null;

create table if not exists public.document_edits (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chat_message_id uuid,
  version_id uuid not null references public.document_versions(id) on delete cascade,
  change_id text not null,
  del_w_id text,
  ins_w_id text,
  mark_w_ids text[] not null default '{}'::text[],
  deleted_text text not null default '',
  inserted_text text not null default '',
  context_before text,
  context_after text,
  status text not null default 'pending'
    check (status = any (array[
      'pending'::text,
      'accepted'::text,
      'rejected'::text
    ])),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists document_edits_document_id_idx
  on public.document_edits(document_id, created_at desc);

create index if not exists document_edits_message_id_idx
  on public.document_edits(chat_message_id);

create index if not exists document_edits_version_id_idx
  on public.document_edits(version_id);

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------

create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  language text default 'English',
  practice text default 'General Transactions',
  jurisdictions text[] default array['General']::text[],
  -- Set when the workflow has been published to the firm. The person who wrote
  -- it stays recorded in user_id.
  firm_id uuid references public.firms(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists idx_workflows_user
  on public.workflows(user_id);

create index if not exists workflows_firm_idx
  on public.workflows(firm_id)
  where firm_id is not null;

create table if not exists public.hidden_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id, workflow_id)
);

create index if not exists idx_hidden_workflows_user
  on public.hidden_workflows(user_id);

create table if not exists public.workflow_shares (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  shared_by_user_id uuid not null references auth.users(id) on delete cascade,
  shared_with_email text not null,
  allow_edit boolean not null default false,
  created_at timestamptz not null default now(),
  constraint workflow_shares_workflow_email_unique
    unique(workflow_id, shared_with_email)
);

create index if not exists workflow_shares_workflow_id_idx
  on public.workflow_shares(workflow_id);

create index if not exists workflow_shares_email_idx
  on public.workflow_shares(shared_with_email);

create table if not exists public.default_workflow_installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  default_key text not null,
  workflow_id uuid references public.workflows(id) on delete set null,
  installed_at timestamptz not null default now(),
  constraint default_workflow_installations_user_key_unique
    unique(user_id, default_key),
  constraint default_workflow_installations_workflow_unique
    unique(workflow_id)
);

create table if not exists public.quick_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  name text not null,
  prompt text not null default '',
  document_upload boolean not null default false,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quick_actions_user_order_idx
  on public.quick_actions(user_id, sort_order, created_at);

create index if not exists quick_actions_workflow_idx
  on public.quick_actions(workflow_id);

create table if not exists public.workflow_addons (
  id uuid primary key default gen_random_uuid(),
  addon_key text not null unique,
  pack_key text,
  pack_title text,
  pack_description text,
  pack_version text,
  version text,
  title text not null,
  description text,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  contributors jsonb,
  language text,
  practice text,
  jurisdictions text[],
  content_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_addons_type_check
    check(type in ('assistant', 'tabular'))
);

create index if not exists workflow_addons_active_type_idx
  on public.workflow_addons(active, type, title);

create index if not exists workflow_addons_active_pack_idx
  on public.workflow_addons(active, pack_key, title);

create table if not exists public.workflow_reference_documents (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  file_type text not null,
  storage_path text not null,
  size_bytes integer,
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workflow_reference_documents_workflow_idx
  on public.workflow_reference_documents(workflow_id, created_at);

create index if not exists workflow_reference_documents_user_idx
  on public.workflow_reference_documents(user_id);

create table if not exists public.workflow_addon_reference_files (
  id uuid primary key default gen_random_uuid(),
  addon_id uuid not null references public.workflow_addons(id) on delete cascade,
  filename text not null,
  file_type text not null,
  storage_path text not null,
  size_bytes integer,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint workflow_addon_reference_files_name_unique
    unique(addon_id, filename)
);

-- Install each user's editable defaults and Quick Actions atomically. The
-- installation row remains after a default workflow is deleted so it is not
-- silently recreated on a later request.
create or replace function public.install_missing_default_workflows(
  p_user_id text,
  p_defaults jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  workflow_uuid uuid;
  installed_count integer := 0;
  jurisdiction_values text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id, 0));

  for item in select value from jsonb_array_elements(coalesce(p_defaults, '[]'::jsonb))
  loop
    if nullif(trim(item->>'default_key'), '') is null then
      continue;
    end if;

    if exists (
      select 1
      from public.default_workflow_installations dwi
      where dwi.user_id::text = p_user_id
        and dwi.default_key = item->>'default_key'
    ) then
      continue;
    end if;

    select coalesce(array_agg(value), array['General']::text[])
      into jurisdiction_values
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(item->'jurisdictions') = 'array'
          then item->'jurisdictions'
        else '["General"]'::jsonb
      end
    );

    insert into public.workflows (
      user_id,
      title,
      type,
      prompt_md,
      columns_config,
      language,
      practice,
      jurisdictions
    ) values (
      p_user_id::uuid,
      item->>'title',
      item->>'type',
      nullif(item->>'prompt_md', ''),
      case
        when jsonb_typeof(item->'columns_config') = 'array'
          then item->'columns_config'
        else null
      end,
      coalesce(nullif(item->>'language', ''), 'English'),
      coalesce(nullif(item->>'practice', ''), 'General Transactions'),
      jurisdiction_values
    )
    returning id into workflow_uuid;

    insert into public.default_workflow_installations (
      user_id,
      default_key,
      workflow_id
    ) values (
      p_user_id::uuid,
      item->>'default_key',
      workflow_uuid
    );

    if item->>'type' = 'assistant' then
    insert into public.quick_actions (
      user_id,
      workflow_id,
      name,
      prompt,
      document_upload,
      enabled,
      sort_order
    ) values (
      p_user_id::uuid,
      workflow_uuid,
      coalesce(nullif(trim(item->>'quick_action_name'), ''), item->>'title'),
      coalesce(item->>'quick_action_prompt', ''),
      coalesce((item->>'document_upload')::boolean, false),
      true,
      coalesce((item->>'sort_order')::integer, installed_count)
    );
    end if;

    installed_count := installed_count + 1;
  end loop;

  return installed_count;
end;
$$;

-- Review queue for user-submitted workflows that may later be published to the
-- open-source workflow repository. The backend writes with the service role.
create table if not exists public.workflow_open_source_submissions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  submitted_by_user_id uuid not null references auth.users(id) on delete cascade,
  submitter_email text,
  submitter_name text,
  contributor_mode text not null default 'anonymous',
  status text not null default 'pending',
  snapshot jsonb not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  review_notes text,
  constraint workflow_open_source_submissions_status_check
    check (status in ('pending', 'approved', 'rejected')),
  constraint workflow_open_source_submissions_contributor_mode_check
    check (contributor_mode in ('named', 'anonymous'))
);

create unique index if not exists idx_workflow_open_source_submissions_pending
  on public.workflow_open_source_submissions(workflow_id, submitted_by_user_id)
  where status = 'pending';

create index if not exists idx_workflow_open_source_submissions_reviewer_queue
  on public.workflow_open_source_submissions(status, submitted_at desc);

create index if not exists idx_workflow_open_source_submissions_submitter
  on public.workflow_open_source_submissions(submitted_by_user_id, submitted_at desc);

alter table public.workflow_open_source_submissions enable row level security;

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

-- ---------------------------------------------------------------------------
-- Assistant chats
-- ---------------------------------------------------------------------------

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now()
);

create index if not exists idx_chats_user
  on public.chats(user_id);

create index if not exists chats_user_created_idx
  on public.chats(user_id, created_at desc, id);

create index if not exists idx_chats_project
  on public.chats(project_id);

create or replace function public.get_chats_overview(
  p_user_id text,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  created_at timestamptz,
  project_name text
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.created_at,
    p.name as project_name
  from public.chats c
  left join public.projects p on p.id = c.project_id
  where c.user_id::text = p_user_id
     or (
       p.id is not null
       and p.user_id::text = p_user_id
     )
  order by c.created_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  role text not null,
  content jsonb,
  files jsonb,
  workflow jsonb,
  citations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_chat
  on public.chat_messages(chat_id);

-- ---------------------------------------------------------------------------
-- Word add-in chats
-- ---------------------------------------------------------------------------
-- These conversations are document-scoped and deliberately separate from the
-- web assistant's chats/chat_messages history.

create table if not exists public.word_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_document_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_document_id)
);

create index if not exists idx_word_documents_user_updated
  on public.word_documents(user_id, updated_at desc);

create table if not exists public.word_chats (
  id uuid primary key default gen_random_uuid(),
  word_document_id uuid not null
    references public.word_documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_word_chats_document_updated
  on public.word_chats(word_document_id, updated_at desc);

create index if not exists idx_word_chats_user
  on public.word_chats(user_id);

create table if not exists public.word_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.word_chats(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content jsonb,
  files jsonb,
  workflow jsonb,
  citations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_word_chat_messages_chat_created
  on public.word_chat_messages(chat_id, created_at);

alter table public.word_documents enable row level security;
alter table public.word_chats enable row level security;
alter table public.word_chat_messages enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_edits_chat_message_id_fkey'
      and conrelid = 'public.document_edits'::regclass
  ) then
    alter table public.document_edits
      add constraint document_edits_chat_message_id_fkey
      foreign key (chat_message_id)
      references public.chat_messages(id)
      on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tabular reviews
-- ---------------------------------------------------------------------------

create table if not exists public.tabular_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid references public.workflows(id) on delete set null,
  practice text,
  document_grouping text not null default 'document' check (document_grouping in ('document', 'folder')),
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tabular_reviews_user
  on public.tabular_reviews(user_id);

create index if not exists idx_tabular_reviews_project
  on public.tabular_reviews(project_id);

create index if not exists tabular_reviews_shared_with_idx
  on public.tabular_reviews using gin (shared_with);

create index if not exists tabular_reviews_title_trgm_idx
  on public.tabular_reviews using gin (lower(title) gin_trgm_ops);

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text default null
)
returns table (
  id uuid,
  user_id text,
  name text,
  cm_number text,
  practice text,
  shared_with jsonb,
  visibility text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where public.can_access_project(
        p.user_id, p.shared_with, p.visibility, p.firm_id, p_user_id, p_user_email
      )
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.shared_with,
    coalesce(vp.visibility, 'private') as visibility,
    vp.created_at,
    vp.updated_at,
    vp.user_id::text = p_user_id as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    null::text as owner_email,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by vp.created_at desc;
$$;

create table if not exists public.tabular_review_rows (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  label text not null,
  row_type text not null check (row_type in ('document', 'folder')),
  folder_id uuid references public.project_subfolders(id) on delete set null,
  library_folder_id uuid references public.library_folders(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  sort_index integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_review_rows_review
  on public.tabular_review_rows(review_id, sort_index);

alter table public.tabular_review_rows enable row level security;

create table if not exists public.tabular_review_row_sources (
  row_id uuid not null references public.tabular_review_rows(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  sort_index integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (row_id, document_id)
);

create index if not exists idx_tabular_review_row_sources_document
  on public.tabular_review_row_sources(document_id);

alter table public.tabular_review_row_sources enable row level security;

create table if not exists public.tabular_cells (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  row_id uuid not null references public.tabular_review_rows(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  column_index integer not null,
  content text,
  citations jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_cells_review
  on public.tabular_cells(review_id, document_id, column_index);

create index if not exists idx_tabular_cells_review_row
  on public.tabular_cells(review_id, row_id, column_index);

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  document_count integer
)
language sql
stable
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where public.can_access_project(
        p.user_id, p.shared_with, p.visibility, p.firm_id, p_user_id, p_user_email
      )
  ),
  visible_reviews as (
    select tr.*
    from public.tabular_reviews tr
    where (p_project_id is null or tr.project_id::text = p_project_id)
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'in-project' and tr.project_id is not null)
        or (p_scope = 'standalone' and tr.project_id is null)
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(tr.title) like
          '%' ||
          replace(
            replace(
              replace(lower(p_search_term), '\', '\\'),
              '%',
              '\%'
            ),
            '_',
            '\_'
          ) ||
          '%'
          escape '\'
      )
      and (
        p_project_id is null
        or exists (
          select 1
          from accessible_projects ap
          where ap.id::text = p_project_id
        )
      )
      and (
        tr.user_id::text = p_user_id
        or (
          tr.project_id in (select ap.id from accessible_projects ap)
          and tr.user_id::text <> p_user_id
        )
        or (
          p_project_id is null
          and coalesce(p_user_email, '') <> ''
          and tr.user_id::text <> p_user_id
          and tr.shared_with @> jsonb_build_array(p_user_email)
        )
      )
  ),
  cell_document_counts as (
    select
      tc.review_id,
      count(distinct tc.document_id)::integer as document_count
    from public.tabular_cells tc
    where tc.review_id in (
      select vr.id
      from visible_reviews vr
      where jsonb_typeof(vr.document_ids) is distinct from 'array'
    )
    group by tc.review_id
  ),
  review_document_counts as (
    select
      vr.id,
      case
        when jsonb_typeof(vr.document_ids) = 'array'
          then (
            select count(distinct doc_id.value)::integer
            from jsonb_array_elements_text(vr.document_ids) as doc_id(value)
          )
        else coalesce(cdc.document_count, 0)
      end as document_count
    from visible_reviews vr
    left join cell_document_counts cdc
      on cdc.review_id = vr.id
  )
  select
    vr.id,
    vr.project_id,
    vr.user_id::text as user_id,
    vr.title,
    vr.columns_config,
    vr.document_ids,
    vr.workflow_id,
    vr.shared_with,
    vr.created_at,
    vr.updated_at,
    vr.user_id::text = p_user_id as is_owner,
    rdc.document_count
  from visible_reviews vr
  join review_document_counts rdc
    on rdc.id = vr.id
  order by
    case
      when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vr.title, ''))
      else null
    end asc,
    case
      when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vr.title, ''))
      else null
    end desc,
    case
      when p_sort_key = 'columns' and p_sort_direction = 'asc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb))
      else null
    end asc,
    case
      when p_sort_key = 'columns' and p_sort_direction = 'desc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb))
      else null
    end desc,
    case
      when p_sort_key = 'documents' and p_sort_direction = 'asc' then rdc.document_count
      else null
    end asc,
    case
      when p_sort_key = 'documents' and p_sort_direction = 'desc' then rdc.document_count
      else null
    end desc,
    case
      when p_sort_key = 'created' and p_sort_direction = 'asc' then vr.created_at
      else null
    end asc,
    case
      when p_sort_key = 'created' and p_sort_direction = 'desc' then vr.created_at
      else null
    end desc,
    vr.created_at desc,
    vr.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text default null,
  p_project_id text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  document_count integer
)
language sql
stable
as $$
  select *
  from public.get_tabular_reviews_overview(
    p_user_id,
    p_user_email,
    p_project_id,
    'all',
    2147483647,
    0,
    null,
    'created',
    'desc'
  );
$$;

create or replace function public.get_tabular_review_ids_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_search_term text,
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
  with accessible_projects as (
    select p.id
    from public.projects p
    where public.can_access_project(
        p.user_id, p.shared_with, p.visibility, p.firm_id, p_user_id, p_user_email
      )
  )
  select tr.id, tr.user_id::text as user_id
  from public.tabular_reviews tr
  where (p_project_id is null or tr.project_id::text = p_project_id)
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'in-project' and tr.project_id is not null)
      or (p_scope = 'standalone' and tr.project_id is null)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(tr.title) like
        '%' ||
        replace(
          replace(
            replace(lower(p_search_term), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) ||
        '%'
        escape '\'
    )
    and (
      p_project_id is null
      or exists (
        select 1
        from accessible_projects ap
        where ap.id::text = p_project_id
      )
    )
    and (
      tr.user_id::text = p_user_id
      or (
        tr.project_id in (select ap.id from accessible_projects ap)
        and tr.user_id::text <> p_user_id
      )
      or (
        p_project_id is null
        and coalesce(p_user_email, '') <> ''
        and tr.user_id::text <> p_user_id
        and tr.shared_with @> jsonb_build_array(p_user_email)
      )
    )
  order by tr.created_at desc, tr.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create table if not exists public.tabular_review_chats (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tabular_review_chats_review_idx
  on public.tabular_review_chats(review_id, updated_at desc);

create index if not exists tabular_review_chats_user_idx
  on public.tabular_review_chats(user_id);

create table if not exists public.tabular_review_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.tabular_review_chats(id) on delete cascade,
  role text not null,
  content jsonb,
  annotations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tabular_review_chat_messages_chat_idx
  on public.tabular_review_chat_messages(chat_id, created_at);

-- ---------------------------------------------------------------------------
-- CourtListener bulk-data indexes
-- ---------------------------------------------------------------------------

create table if not exists public.courtlistener_citation_index (
  id bigint primary key,
  volume text not null,
  reporter text not null,
  page text not null,
  type integer,
  cluster_id bigint not null,
  date_created timestamptz,
  date_modified timestamptz
);

create index if not exists courtlistener_citation_lookup_idx
  on public.courtlistener_citation_index(volume, reporter, page);

create index if not exists courtlistener_citation_cluster_idx
  on public.courtlistener_citation_index(cluster_id);

alter table public.courtlistener_citation_index enable row level security;

create table if not exists public.courtlistener_opinion_cluster_index (
  id bigint primary key,
  case_name text,
  case_name_short text,
  case_name_full text,
  slug text,
  date_filed date,
  citation_count integer,
  precedential_status text,
  filepath_pdf_harvard text,
  filepath_json_harvard text,
  docket_id bigint
);

alter table public.courtlistener_opinion_cluster_index enable row level security;

-- ---------------------------------------------------------------------------
-- Library search and lightweight overview facets
-- ---------------------------------------------------------------------------

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

create or replace function public.get_project_filter_options(
  p_user_id text,
  p_user_email text default null
)
returns table (practices text[], owners jsonb)
language sql
stable
as $$
  with visible_projects as (
    select p.user_id, nullif(trim(p.practice), '') as practice
    from public.projects p
    where public.can_access_project(
        p.user_id, p.shared_with, p.visibility, p.firm_id, p_user_id, p_user_email
      )
  ),
  distinct_owners as (
    select distinct vp.user_id
    from visible_projects vp
  ),
  owner_options as (
    select
      o.user_id,
      case
        when o.user_id::text = p_user_id then 'Me'
        else coalesce(
          nullif(trim(up.display_name), ''),
          nullif(trim(up.email), ''),
          'Shared'
        )
      end as label
    from distinct_owners o
    left join public.user_profiles up
      on up.user_id::text = o.user_id::text
  )
  select
    coalesce(
      (select array_agg(distinct practice order by practice)
       from visible_projects
       where practice is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      (select jsonb_agg(
          jsonb_build_object('value', user_id, 'label', label)
          order by label, user_id
       ) from owner_options),
      '[]'::jsonb
    ) as owners;
$$;

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

create index if not exists document_versions_filename_trgm_idx
  on public.document_versions using gin (lower(filename) gin_trgm_ops)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Paginated project/workflow overviews and collection summary helpers
-- ---------------------------------------------------------------------------

-- Server-side pagination for the Projects overview page (/projects) and the
-- Workflows list page (/workflows), added the same day and combined into one
-- migration. Both mirror the pattern already built for Tabular Reviews in
-- 20260726_01_tabular_reviews_pagination.sql /
-- 20260727_01_tabular_review_ids_overview.sql.

-- ============================================================================
-- Projects overview pagination
-- ============================================================================
--   * a trigram index so leading-wildcard search can use an index scan
--   * a new, higher-arity overload of get_projects_overview that adds
--     scope/search/practice/owner filters, server-side sort, and limit/offset
--   * the existing 2-arg get_projects_overview (from 20260703_02_project_practice.sql)
--     is left completely untouched as the back-compat path for every caller
--     that doesn't ask for pagination (document-picker directory view and
--     tabular-review project pickers) — see backend/src/routes/projects.ts
--     for the routing logic that decides which overload to call.
--   * a lightweight get_project_ids_overview companion for "select all
--     matching" bulk actions.

create extension if not exists pg_trgm;

create index if not exists projects_name_trgm_idx
  on public.projects using gin (lower(name) gin_trgm_ops);

create index if not exists projects_updated_at_idx
  on public.projects(updated_at desc, id);

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_owner_user_id text
)
returns table (
  id uuid,
  user_id text,
  name text,
  cm_number text,
  practice text,
  shared_with jsonb,
  visibility text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where public.can_access_project(
        p.user_id, p.shared_with, p.visibility, p.firm_id, p_user_id, p_user_email
      )
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'mine' and p.user_id::text = p_user_id)
        or (p_scope = 'shared' and p.user_id::text <> p_user_id)
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(coalesce(p.name, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.cm_number, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.practice, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
      )
      and (p_practice is null or p.practice = p_practice)
      and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.shared_with,
    coalesce(vp.visibility, 'private') as visibility,
    vp.created_at,
    vp.updated_at,
    vp.user_id::text = p_user_id as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    null::text as owner_email,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vp.name, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vp.name, '')) else null end desc,
    case when p_sort_key = 'cm' and p_sort_direction = 'asc' then lower(coalesce(vp.cm_number, '')) else null end asc,
    case when p_sort_key = 'cm' and p_sort_direction = 'desc' then lower(coalesce(vp.cm_number, '')) else null end desc,
    case when p_sort_key = 'files' and p_sort_direction = 'asc' then coalesce(dc.document_count, 0) else null end asc,
    case when p_sort_key = 'files' and p_sort_direction = 'desc' then coalesce(dc.document_count, 0) else null end desc,
    case when p_sort_key = 'chats' and p_sort_direction = 'asc' then coalesce(cc.chat_count, 0) else null end asc,
    case when p_sort_key = 'chats' and p_sort_direction = 'desc' then coalesce(cc.chat_count, 0) else null end desc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'asc' then coalesce(rc.review_count, 0) else null end asc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'desc' then coalesce(rc.review_count, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vp.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vp.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then vp.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then vp.updated_at else null end desc,
    vp.created_at desc,
    vp.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Lightweight companion for bulk "select all matching" actions — id + owning
-- user only, no count joins. Runs its own query rather than delegating to
-- get_projects_overview (same rationale as get_tabular_review_ids_overview:
-- the count CTEs there would be pure waste for a caller that only wants ids).
-- Both share who-can-open-it through public.can_access_project.
--
-- Paginated (not "return everything") because PostgREST enforces its own
-- row cap on every RPC response and truncates silently rather than erroring;
-- backend/src/routes/projects.ts pages through this on the caller's behalf.
create or replace function public.get_project_ids_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_owner_user_id text,
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
  select p.id, p.user_id::text as user_id
  from public.projects p
  where public.can_access_project(
      p.user_id, p.shared_with, p.visibility, p.firm_id, p_user_id, p_user_email
    )
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'mine' and p.user_id::text = p_user_id)
      or (p_scope = 'shared' and p.user_id::text <> p_user_id)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(p.name, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
      or lower(coalesce(p.cm_number, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
      or lower(coalesce(p.practice, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or p.practice = p_practice)
    and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  order by p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ============================================================================
-- Workflows overview pagination
-- ============================================================================
-- Mirrors the Projects pagination above. System workflows are a static,
-- code-generated TypeScript constant (backend/src/lib/systemWorkflows.ts)
-- with zero user-data growth — they are deliberately NOT part of this RPC and
-- stay fetched/filtered client-side exactly as before. This migration only
-- paginates the one part of /workflows with real growth: a user's owned +
-- shared workflows, currently served by the 3-arg get_workflows_overview
-- defined in 20260625_01_workflow_metadata.sql, which is left completely
-- untouched — every other caller of GET /workflows (the workflow picker
-- modal, the chat slash-menu picker) keeps hitting that exact unpaginated
-- path, since the route only takes the new paginated branch when a
-- pagination-related query param is present.

create index if not exists workflows_title_trgm_idx
  on public.workflows using gin (lower(title) gin_trgm_ops);

create index if not exists workflows_jurisdictions_gin_idx
  on public.workflows using gin (jurisdictions);

-- p_scope here is 'all' | 'owned' | 'shared' — deliberately different
-- vocabulary from Projects' 'mine'/'shared', since this RPC (unlike
-- Projects' single source of truth) never includes system workflows at all;
-- keeping the words distinct avoids conflating this RPC-level scope with the
-- UI's separate "source" filter (system/user/shared), which does include
-- system rows client-side.
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

-- Lightweight companion for bulk "select all matching" actions (owned
-- workflows only — see the route/hook layer; shared workflows are excluded
-- from bulk-delete eligibility since only the owner can delete, and system
-- workflows never need this since all 37 are always already in memory).
-- Duplicates the owned predicate directly rather than delegating to
-- get_workflows_overview, same rationale as get_project_ids_overview: no
-- need for the shared-by-name join when the caller only wants ids.
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

-- Lightweight sidebar project feed. The Projects overview RPC intentionally
-- computes file/chat/review counts for table sorting; the sidebar needs none
-- of those aggregates.
create or replace function public.get_project_summaries(
  p_user_id text,
  p_user_email text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text,
  name text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean
)
language sql
stable
as $$
  select
    p.id,
    p.user_id::text as user_id,
    p.name,
    p.created_at,
    p.updated_at,
    p.user_id::text = p_user_id as is_owner
  from public.projects p
  where public.can_access_project(
      p.user_id, p.shared_with, p.visibility, p.firm_id, p_user_id, p_user_email
    )
  order by p.updated_at desc, p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 11), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ID-only Library query for select-all and bulk actions. This mirrors the
-- flat Library search predicate without returning document/version payloads.
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
-- Direct client grant hardening
-- ---------------------------------------------------------------------------
--
-- The frontend uses Supabase directly only for authentication. Application
-- data access goes through the backend API with the service role after the
-- backend verifies the user's JWT. Do not grant the browser anon/authenticated
-- roles direct table privileges for backend-owned data.

-- Audit history of user actions (queried via the service-role backend only).
-- Defined here — above the service_role grant block — so `grant ... on all
-- tables in schema public` below covers it on a fresh install. Like every other
-- backend-owned table, direct browser roles are revoked and RLS is enabled with
-- no policies (defense in depth; service_role bypasses RLS for the backend path).
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  action text not null,
  status text not null default 'completed',
  title text,
  surface text,
  project_id uuid,
  chat_id uuid,
  document_id uuid,
  review_id uuid,
  model text,
  detail jsonb
);
create index if not exists audit_events_user_created on public.audit_events (user_id, created_at desc);
create index if not exists audit_events_project_created on public.audit_events (project_id, created_at desc);
alter table public.audit_events enable row level security;
alter table public.firms enable row level security;
alter table public.firm_members enable row level security;
alter table public.firm_invites enable row level security;

revoke all on public.user_profiles from anon, authenticated;
revoke all on public.firms from anon, authenticated;
revoke all on public.firm_members from anon, authenticated;
revoke all on public.firm_invites from anon, authenticated;
revoke all on public.projects from anon, authenticated;
revoke all on public.project_subfolders from anon, authenticated;
revoke all on public.library_folders from anon, authenticated;
revoke all on public.documents from anon, authenticated;
revoke all on public.document_versions from anon, authenticated;
revoke all on public.document_edits from anon, authenticated;
revoke all on public.workflows from anon, authenticated;
revoke all on public.hidden_workflows from anon, authenticated;
revoke all on public.workflow_shares from anon, authenticated;
revoke all on public.workflow_open_source_submissions from anon, authenticated;
revoke all on public.chats from anon, authenticated;
revoke all on public.chat_messages from anon, authenticated;
revoke all on public.word_documents from anon, authenticated;
revoke all on public.word_chats from anon, authenticated;
revoke all on public.word_chat_messages from anon, authenticated;
revoke all on public.tabular_reviews from anon, authenticated;
revoke all on public.tabular_cells from anon, authenticated;
revoke all on public.tabular_review_rows from anon, authenticated;
revoke all on public.tabular_review_row_sources from anon, authenticated;
revoke all on public.tabular_review_chats from anon, authenticated;
revoke all on public.tabular_review_chat_messages from anon, authenticated;
revoke all on public.user_api_keys from anon, authenticated;
revoke all on public.user_mcp_connectors from anon, authenticated;
revoke all on public.user_mcp_oauth_tokens from anon, authenticated;
revoke all on public.user_mcp_oauth_states from anon, authenticated;
revoke all on public.user_mcp_connector_tools from anon, authenticated;
revoke all on public.user_mcp_tool_audit_logs from anon, authenticated;
revoke all on public.courtlistener_citation_index from anon, authenticated;
revoke all on public.courtlistener_opinion_cluster_index from anon, authenticated;
revoke all on public.audit_events from anon, authenticated;
revoke all on function public.install_missing_default_workflows(text, jsonb)
  from public, anon, authenticated;

grant select, insert, update, delete
  on public.default_workflow_installations,
     public.quick_actions,
     public.workflow_addons,
     public.workflow_reference_documents,
     public.workflow_addon_reference_files
  to service_role;

grant execute
  on function public.install_missing_default_workflows(text, jsonb)
  to service_role;

-- Tables created by this file are owned by the database bootstrap role. The
-- backend connects as service_role, so grant it only the data privileges that
-- the direct browser roles above intentionally do not have. RLS is still
-- enabled as defense in depth; service_role bypasses it for the backend path.
--
-- NOTE: this grant targets `all tables in schema public`, so every table it
-- must cover has to already exist above this point. audit_events is therefore
-- defined *before* this block (not after it) — otherwise a fresh plain-Postgres
-- install would create the table with no service_role privileges and the
-- backend's inserts would fail permission-denied (silently, since recordAudit
-- swallows errors).
grant select, insert, update, delete
  on all tables in schema public
  to service_role;
grant usage, select
  on all sequences in schema public
  to service_role;
-- Case memory: the short facts a matter accumulates as work goes on — who the
-- parties are, the dates that matter, the position taken, what was decided,
-- what is still open, how the firm wants things drafted.
--
-- Each fact keeps a link back to where it came from, so it can be checked
-- rather than taken on trust. Facts change, so a fact is superseded by a newer
-- one rather than overwritten: the old wording stays readable.
create table if not exists public.project_memories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Who wrote it. Kept so a matter shared between people shows whose fact it is.
  user_id uuid not null references auth.users(id) on delete cascade,
  -- One of: parties, dates, position, decisions, questions, drafting.
  category text not null default 'parties',
  body text not null,
  -- Pinned facts are always sent to the assistant, even once a matter has
  -- accumulated more than fits comfortably.
  pinned boolean not null default false,
  -- Where it came from. A document (with the page it was read on), a chat
  -- message, or nothing at all when someone simply typed it in.
  source_document_id uuid references public.documents(id) on delete set null,
  source_page integer,
  source_chat_id uuid references public.chats(id) on delete set null,
  -- Set on the older fact when a newer one replaces it. The old row stays so
  -- the history of a moving deadline is still readable.
  superseded_by uuid references public.project_memories(id) on delete set null,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_memories_project
  on public.project_memories(project_id, created_at desc);

-- The facts actually in force: everything that has not been replaced.
create index if not exists idx_project_memories_live
  on public.project_memories(project_id)
  where superseded_by is null;

grant select, insert, update, delete on public.project_memories to service_role;
-- Facts Mike suggests for itself after a conversation.
--
-- A suggested fact is not in force: it is shown to the lawyer as something to
-- accept, correct or turn down, and only an accepted fact is ever sent back to
-- the assistant. Turned-down facts are kept so the same suggestion does not
-- come round again.
alter table public.project_memories
  add column if not exists status text not null default 'accepted';

-- Where the fact came from: someone typed it, or Mike suggested it. Shown on
-- the fact, so a matter that saves suggestions without asking still makes plain
-- which facts nobody checked.
alter table public.project_memories
  add column if not exists origin text not null default 'manual';

-- Only accepted facts are in force, so that is the index the assistant reads by.
create index if not exists idx_project_memories_accepted
  on public.project_memories(project_id)
  where superseded_by is null and status = 'accepted';

-- Per matter: let Mike save what it finds without asking first. Off by default;
-- the facts are still listed and can be removed.
alter table public.projects
  add column if not exists auto_remember boolean not null default false;
-- A fingerprint of each remembered fact's meaning, so that once a matter has
-- collected more facts than fit comfortably in every question, the ones sent
-- can be the ones that bear on what was actually asked.
--
-- Computed on our own machine by the same small local model used for document
-- search (bge-small-en-v1.5, 384 dimensions). Nothing is sent outside for this.
create extension if not exists vector;

alter table public.project_memories
  add column if not exists embedding vector(384);
-- Whether Mike looks for facts worth remembering after a conversation at all.
--
-- On unless someone turns it off. A matter where the suggestions are noise —
-- one that is nearly finished, or one where everything worth knowing is already
-- written down — should be able to stop them rather than keep turning them
-- down.
alter table public.projects
  add column if not exists suggest_facts boolean not null default true;
