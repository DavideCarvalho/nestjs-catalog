import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, ShieldCheck, ShieldHalf, UserRound } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from './cn';
import {
  type CatalogIdentity,
  type CatalogPeoplePage,
  type CatalogPersonRole,
  type CatalogPersonSummary,
  type CatalogPrincipalSummary,
  catalogQueryKeys,
  useCatalogClient,
} from './context';
import { TextField } from './ui/field';
import { SelectField } from './ui/select';
import { Tooltip, TooltipProvider } from './ui/tooltip';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

export interface AccessConsoleProps {
  /**
   * Who is looking, if the host knows.
   *
   * A prop rather than something this screen fetches, because signing in is not
   * part of the catalog's surface. A host may authenticate with a session
   * cookie, OIDC, a proxy header or nothing at all, and a library that reached
   * for `/auth/me` would be choosing for them. Omit it and the "you" panel
   * disappears; the two lists below are the same either way.
   */
  identity?: CatalogIdentity;
  /**
   * Signing out, if the host has somewhere to sign out to. Omit and the button
   * is absent rather than present and inert.
   */
  onSignOut?: () => void;
  signOutPending?: boolean;
  /**
   * Whether to offer the "add someone" form.
   *
   * Defaults to what `identity` implies, and is separate so a host that knows
   * better — because its proxy already gated the route — can say so. The
   * endpoint refuses either way; this only stops a console showing a form whose
   * only possible outcome is a 403.
   */
  canAddPeople?: boolean;
  title?: string;
  eyebrow?: string;
  intro?: string;
}

function PeopleSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="mt-3 block">
      <span className="sr-only">Search people</span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search by name or email"
        className={cn(
          'w-full rounded-md border px-3 py-1.5 text-sm',
          RULE,
          PANEL,
          'placeholder:text-zinc-400 dark:placeholder:text-zinc-600',
        )}
      />
    </label>
  );
}

/**
 * What the page is NOT showing.
 *
 * Rendered whenever there is a page at all, not only when there is more than
 * one: a bounded list that looks complete is the failure worth spending a line
 * of UI on, because an operator who reads it as complete concludes somebody has
 * no access when they were merely on the next page.
 */
function PageBar({
  page,
  onOffset,
  busy,
}: {
  page: CatalogPeoplePage;
  onOffset: (next: number) => void;
  busy: boolean;
}) {
  const shown = page.people.length;
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = page.offset + shown;
  const hasMore = last < page.total;

  return (
    <div className={cn('mt-3 flex items-center justify-between text-xs', MUTED)}>
      <span>
        {page.total === 0
          ? 'No people'
          : `Showing ${first}–${last} of ${page.total.toLocaleString()}`}
      </span>
      {(page.offset > 0 || hasMore) && (
        <span className="flex gap-2">
          <button
            type="button"
            disabled={page.offset === 0 || busy}
            onClick={() => onOffset(Math.max(0, page.offset - page.limit))}
            className="disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!hasMore || busy}
            onClick={() => onOffset(page.offset + page.limit)}
            className="disabled:opacity-40"
          >
            Next
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * One page answering the two questions a shared catalog creates: which
 * application is allowed to touch what, and which person is behind it.
 *
 * Kept as one page rather than split, because the answer to "who did this" is a
 * pair — a person, acting through an application, capped by both — and two
 * screens would let a reader see one half and believe it was the whole thing.
 */
export function AccessConsole({
  identity,
  onSignOut,
  signOutPending,
  canAddPeople,
  title = 'Access',
  eyebrow = 'Governance',
  intro = 'Two kinds of caller reach this catalog. Applications hold keys and act on their own behalf. People sign in and act through an application, and can never do more than both of them may.',
}: AccessConsoleProps) {
  const client = useCatalogClient();

  const applications = useQuery({
    queryKey: catalogQueryKeys.principals,
    queryFn: () => client.listPrincipals(),
    // Grants change when an operator changes them, which is not often and not
    // from here. Long enough that moving between tabs is instant.
    staleTime: 30_000,
  });
  // Paged, because a host's user table is its whole directory: this screen is
  // embedded in applications with thousands of employees, and the endpoint caps
  // what it will return regardless of what is asked for. The key carries the
  // query so a search does not read a previous search's page from the cache.
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const people = useQuery({
    queryKey: [...catalogQueryKeys.people, { search, offset }],
    queryFn: () => client.listPeople({ ...(search ? { search } : {}), offset }),
    staleTime: 30_000,
    // The count and the page it describes must not be shown apart. Without
    // this, typing into the search blanks the list to a spinner and then shows
    // a total for a different query for one frame.
    placeholderData: (previous) => previous,
  });

  const mayAdminister = canAddPeople ?? identity?.scopes.includes('catalog:admin') ?? false;

  return (
    <TooltipProvider>
      <div className="mx-auto max-w-5xl px-8 py-8">
        <p className={cn('font-mono text-[11px] uppercase tracking-[0.18em]', MUTED)}>{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">{intro}</p>

        {identity && (
          <YouPanel identity={identity} onSignOut={onSignOut} signOutPending={signOutPending} />
        )}

        <Section
          title="People"
          note="Sign in to the console. Capped by the application they sign in through."
        >
          <PeopleSearch
            value={search}
            onChange={(next) => {
              setSearch(next);
              // Back to the first page. Staying on page 3 of the previous
              // search shows an empty list for a search that has matches.
              setOffset(0);
            }}
          />
          {mayAdminister && <AddPerson />}
          {people.isPending && <Placeholder>Reading people…</Placeholder>}
          {/* A failed read must never render as an empty list. "Nobody can sign
              in yet" and "we could not ask" send an operator to completely
              different places, and the first one invites them to create an
              account that already exists. */}
          {people.isError && (
            <Failed
              message={
                people.error instanceof Error
                  ? people.error.message
                  : 'Could not read the people list.'
              }
              onRetry={() => people.refetch()}
            />
          )}
          {people.data?.people.map((person) => (
            <PersonCard key={person.email} person={person} />
          ))}
          {/* Two different empty lists, and conflating them is the bug this
              splits: with a search typed, "no matches" is a fact about the
              search. Without one it is a fact about the directory, and the
              advice below only makes sense for the second. */}
          {people.data?.people.length === 0 &&
            (search ? (
              <Placeholder>Nobody matches “{search}”.</Placeholder>
            ) : (
              <Placeholder>
                Nobody can sign in yet. Seed the first administrator from the environment before
                anybody can reach this console as a person.
              </Placeholder>
            ))}
          {people.data && (
            <PageBar page={people.data} onOffset={setOffset} busy={people.isFetching} />
          )}
        </Section>

        <Section
          title="Applications"
          note="Provisioned by an operator — a console that could hand grants out is one that stops leaving a trail."
        >
          {applications.isPending && <Placeholder>Reading applications…</Placeholder>}
          {applications.isError && (
            <Failed
              message={
                applications.error instanceof Error
                  ? applications.error.message
                  : 'Could not read the application list.'
              }
              onRetry={() => applications.refetch()}
            />
          )}
          {applications.data?.map((principal) => (
            <PrincipalCard key={principal.id} principal={principal} />
          ))}
          {applications.data?.length === 0 && (
            <Placeholder>No applications are provisioned.</Placeholder>
          )}
        </Section>
      </div>
    </TooltipProvider>
  );
}

/**
 * Who you are, said plainly, including the exact string your actions will be
 * stamped with.
 *
 * Showing the raw `principalId` is not a debugging affordance. It is the whole
 * claim the sign-in makes — that the audit trail names a person — and the
 * cheapest way to let somebody verify it is true is to show them the string
 * before they go looking for it on the activity timeline.
 */
function YouPanel({
  identity,
  onSignOut,
  signOutPending,
}: {
  identity: CatalogIdentity;
  onSignOut?: () => void;
  signOutPending?: boolean;
}) {
  // Null actor means an application key is behind this request rather than a
  // person. Derived from `actor` rather than carried as a separate flag,
  // because two fields that must agree are two fields that can disagree.
  const machine = identity.actor === null;

  return (
    <div
      className={cn('mt-6 rounded-lg border p-4', PANEL, machine ? 'border-amber-500/40' : RULE)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
            {machine ? 'Acting as an application' : 'Signed in'}
          </div>
          <div className="mt-1 flex items-center gap-2 text-sm font-medium">
            {machine ? <KeyRound size={14} /> : <UserRound size={14} />}
            {identity.displayName}
          </div>
          <div className={cn('mt-1 font-mono text-[11px]', MUTED)}>
            recorded as {identity.principalId}
          </div>
          {machine && (
            <p className="mt-2 max-w-md text-xs text-amber-600">
              Nothing you do here will name you. This is the application-key path, kept for local
              development — sign in to be attributable.
            </p>
          )}
        </div>

        <div className="flex items-center gap-4">
          {identity.session && (
            <span className={cn('font-mono text-[11px]', MUTED)}>
              expires {new Date(identity.session.expiresAt).toLocaleTimeString()} · idle{' '}
              {identity.session.idleMinutes}m
            </span>
          )}
          {!machine && onSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              disabled={signOutPending}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs disabled:opacity-40',
                RULE,
                'hover:bg-zinc-50 dark:hover:bg-zinc-800',
              )}
            >
              <LogOut size={13} />
              {signOutPending ? 'Signing out…' : 'Sign out'}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Grant label="Effective scopes" values={identity.scopes} tone="neutral" />
        <Grant label="May write" values={identity.writeTypes} tone="write" emptyNote="nothing" />
        <Grant label="May read" values={identity.readTypes ?? ['every type']} tone="neutral" />
        <Grant
          label="May see"
          values={identity.classifications}
          tone="classified"
          emptyNote="nothing classified"
        />
      </div>
    </div>
  );
}

function PersonCard({ person }: { person: CatalogPersonSummary }) {
  return (
    <div className={cn('rounded-lg border p-4', RULE, PANEL)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{person.displayName}</span>
            <span className="rounded-sm bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-500 dark:bg-zinc-800">
              {person.role}
            </span>
            {!person.active && (
              <span className="rounded-sm bg-red-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-red-600 dark:bg-red-950">
                disabled
              </span>
            )}
          </div>
          <div className={cn('mt-0.5 font-mono text-[11px]', MUTED)}>{person.principalId}</div>
        </div>

        <div className={cn('flex items-center gap-4 font-mono text-[11px]', MUTED)}>
          <Tooltip content="Sessions currently alive — not expired, not idled out, not revoked.">
            <span className="cursor-help">{person.liveSessions} live</span>
          </Tooltip>
          <span>
            {person.lastLoginAt
              ? `last in ${new Date(person.lastLoginAt).toLocaleString()}`
              : 'never signed in'}
          </span>
        </div>
      </div>

      {/* The intersection, not the role. A curator whose console has had
          catalog:curate removed is not a curator here, and the role badge
          above would say otherwise on its own. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Grant
          label="Effective scopes"
          values={person.effective.scopes}
          tone="neutral"
          emptyNote="nothing"
        />
        <Grant
          label="May write"
          values={person.effective.writeTypes}
          tone="write"
          emptyNote="nothing"
        />
        <Grant
          label="May read"
          values={person.effective.readTypes ?? ['every type']}
          tone="neutral"
        />
        <Grant
          label="May see"
          values={person.effective.classifications}
          tone="classified"
          emptyNote="nothing classified"
        />
      </div>
    </div>
  );
}

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'viewer', hint: 'read' },
  { value: 'curator', label: 'curator', hint: 'read, curate' },
  { value: 'admin', label: 'admin', hint: 'read, curate, administer' },
];

/** Narrowed rather than cast: a select value is a string as far as the DOM cares. */
function toRole(value: string): CatalogPersonRole {
  return value === 'curator' || value === 'admin' ? value : 'viewer';
}

/**
 * Creating an account, for administrators only.
 *
 * The one write on this page, and it stays narrow on purpose: a name, a role
 * and a password. Per-type grants for a person are deliberately not editable
 * here — they are the exception, they are read straight out of the row, and a
 * form that offers them invites somebody to build a bespoke permission set that
 * nobody can audit later.
 */
function AddPerson() {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<CatalogPersonRole>('viewer');
  const [password, setPassword] = useState('');

  const save = useMutation({
    mutationFn: () =>
      client.upsertPerson({
        email: email.trim(),
        displayName: displayName.trim() || email.trim(),
        role,
        password,
      }),
    onSuccess: () => {
      setEmail('');
      setDisplayName('');
      setPassword('');
      setOpen(false);
      // Precisely this list. Invalidating everything would refetch the model,
      // the connectors and every run on the screen because somebody added a
      // viewer.
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.people });
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'rounded-lg border border-dashed px-4 py-3 text-left text-sm',
          RULE,
          MUTED,
          'hover:text-zinc-600 dark:hover:text-zinc-300',
        )}
      >
        + Add someone
      </button>
    );
  }

  return (
    <form
      className={cn('rounded-lg border p-4', RULE, PANEL)}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="someone@example.mil"
        />
        <TextField
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          placeholder="Defaults to the email"
        />
        <SelectField
          label="Role"
          ariaLabel="Role"
          value={role}
          onValueChange={(value) => setRole(toRole(value))}
          options={ROLE_OPTIONS}
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder="12 characters or more"
          autoComplete="new-password"
        />
      </div>

      {save.isError && (
        <p className="mt-2 text-xs text-red-600">
          {save.error instanceof Error ? save.error.message : 'Could not save.'}
        </p>
      )}

      <p className={cn('mt-2 text-xs', MUTED)}>
        No role carries permission to load a snapshot. Publishing is something an application does
        from a pipeline, with a retryable snapshot id.
      </p>

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={save.isPending || email.trim().length === 0 || password.length < 12}
          className="rounded-md bg-zinc-950 px-3 py-1.5 text-xs text-zinc-50 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-950"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={cn('rounded-md px-3 py-1.5 text-xs', MUTED)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const AUTH_METHODS = {
  token: {
    icon: ShieldCheck,
    tone: 'text-emerald-600',
    hint: 'Authenticates with an access token — rotation and revocation belong to the identity provider.',
  },
  key: {
    icon: KeyRound,
    tone: 'text-amber-600',
    hint: 'Authenticates with a long-lived static key, revoked only by editing its row.',
  },
  session: {
    icon: ShieldHalf,
    tone: 'text-violet-600',
    hint: 'Holds no credential of its own. Reachable only by a person signing in, and it caps what any of them can do.',
  },
} as const;

function PrincipalCard({ principal }: { principal: CatalogPrincipalSummary }) {
  const method = AUTH_METHODS[principal.authMethod];
  // Lifted into a capitalised binding: JSX reads a lowercase `method.icon` in
  // element position as a member expression, which happens to work, but the
  // capitalised local is what every other component here does and is what the
  // union of icon types resolves cleanly against.
  const MethodIcon = method.icon;

  return (
    <div className={cn('rounded-lg border p-4', RULE, PANEL)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{principal.displayName}</span>
            {!principal.active && (
              <span className="rounded-sm bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-500 dark:bg-zinc-800">
                disabled
              </span>
            )}
          </div>
          <div className={cn('mt-0.5 font-mono text-[11px]', MUTED)}>{principal.id}</div>
        </div>

        <div className="flex items-center gap-4">
          <Tooltip content={method.hint}>
            <span
              className={cn(
                'flex cursor-help items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider',
                method.tone,
              )}
            >
              <MethodIcon size={13} />
              {principal.authMethod}
            </span>
          </Tooltip>
          <span className={cn('font-mono text-[11px]', MUTED)}>
            {principal.lastSeenAt
              ? `seen ${new Date(principal.lastSeenAt).toLocaleString()}`
              : 'never seen'}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Grant label="Scopes" values={principal.scopes} tone="neutral" />
        <Grant label="May write" values={principal.writeTypes} tone="write" emptyNote="nothing" />
        <Grant label="May read" values={principal.readTypes ?? ['every type']} tone="neutral" />
        <Grant
          label="Owns"
          values={principal.ownedTypes}
          tone="own"
          emptyNote="no types published"
        />
      </div>

      {principal.classifications.length > 0 && (
        <div className="mt-3">
          <Grant label="May see" values={principal.classifications} tone="classified" />
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-10">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      <p className={cn('mt-0.5 max-w-2xl text-xs', MUTED)}>{note}</p>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <p className={cn('rounded-lg border border-dashed px-4 py-8 text-center text-sm', RULE, MUTED)}>
      {children}
    </p>
  );
}

function Failed({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-center dark:border-red-900 dark:bg-red-950/40">
      <p className="text-sm text-red-700 dark:text-red-300">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-md border border-red-300 px-3 py-1 text-xs text-red-700 dark:border-red-800 dark:text-red-300"
      >
        Try again
      </button>
    </div>
  );
}

const TONES = {
  neutral: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  write: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  own: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  classified: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
} as const;

function Grant({
  label,
  values,
  tone,
  emptyNote = '—',
}: {
  label: string;
  values: string[];
  tone: keyof typeof TONES;
  emptyNote?: string;
}) {
  return (
    <div>
      <div className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>{label}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {values.length === 0 ? (
          <span className={cn('text-xs italic', MUTED)}>{emptyNote}</span>
        ) : (
          values.map((value) => (
            <span
              key={value}
              className={cn('rounded-sm px-1.5 py-0.5 font-mono text-[10px]', TONES[tone])}
            >
              {value}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
