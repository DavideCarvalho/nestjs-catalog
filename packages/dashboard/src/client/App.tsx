import {
  AccessConsole,
  CatalogManager,
  CatalogProvider,
  DashboardBoard,
  FlowView,
  GovernanceTimeline,
  ObjectExplorer,
  PipelineConsole,
  QueryConsole,
  cn,
} from '@dudousxd/nestjs-catalog-react';
import { WorkflowCanvas } from '@dudousxd/nestjs-catalog-react/workflow';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  Cable,
  Database,
  GitBranch,
  History,
  LayoutGrid,
  ShieldHalf,
  TerminalSquare,
  Workflow,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { IDENTITY_QUERY_KEY, KeyGate } from './KeyGate';

/**
 * Whether the HOST already knows who this is.
 *
 * Set by the server when the mount was given an auth config. A console embedded
 * in an application that authenticated you and then shows its own sign-in form
 * is not a smaller problem than one that lets anybody in: it asks for a
 * credential that does not exist, and the only honest thing it can report is
 * that the endpoint it wanted is missing — which is exactly what
 * `Cannot GET /api/auth/me` was.
 *
 * When the host authenticates, the gate is skipped entirely: the session cookie
 * the host minted is already on every request this SPA makes.
 */
const HOST_AUTHENTICATES =
  (window as { __CATALOG_HOST_AUTH__?: boolean }).__CATALOG_HOST_AUTH__ === true;

/** The gate, or nothing at all when the host owns identity. */
function IdentityGate({ children }: { children: React.ReactNode }) {
  if (HOST_AUTHENTICATES) return <>{children}</>;
  return <KeyGate>{children}</KeyGate>;
}
import { api, getEnvironment, listEnvironments, setEnvironment, transport } from './transport';

type Tab =
  | 'model'
  | 'objects'
  | 'query'
  | 'dashboards'
  | 'connectors'
  | 'workflows'
  | 'lineage'
  | 'activity'
  | 'access';

const TABS: Array<{ id: Tab; label: string; icon: typeof Boxes }> = [
  { id: 'model', label: 'Model', icon: Boxes },
  { id: 'objects', label: 'Objects', icon: Database },
  { id: 'query', label: 'Query', icon: TerminalSquare },
  { id: 'dashboards', label: 'Dashboards', icon: LayoutGrid },
  { id: 'connectors', label: 'Connectors', icon: Cable },
  { id: 'workflows', label: 'Workflows', icon: Workflow },
  // Renamed from "Flow". Two screens called the same thing while making
  // opposite claims about where truth lives — one inferring the graph from what
  // publishers did, one declaring it — is how somebody trusts the wrong one.
  // This is the inferred half, so it says so.
  { id: 'lineage', label: 'Lineage', icon: GitBranch },
  { id: 'activity', label: 'Activity', icon: History },
  { id: 'access', label: 'Access', icon: ShieldHalf },
];

/**
 * The hash is the router, and everything before the `?` is the route.
 *
 * Matching the whole hash meant `#objects?type=Mvr` — the link the model
 * screen generates — matched no tab and silently fell back to the model. The
 * address bar changed and the screen did not, which reads as a click that
 * never landed.
 */
function tabFromHash(): Tab {
  const route = window.location.hash.replace('#', '').split('?')[0];
  return TABS.some((t) => t.id === route) ? (route as Tab) : 'model';
}

/** The parameters after the `?`, which live in the hash rather than in `search`. */
function paramsFromHash(): URLSearchParams {
  const hash = window.location.hash;
  const mark = hash.indexOf('?');
  return new URLSearchParams(mark === -1 ? '' : hash.slice(mark + 1));
}

/**
 * Identity stays here rather than moving into the library with the screen.
 *
 * Signing in is the host's business — this console uses its own session
 * endpoints, and a flip-nestjs mounting the same screen would use Keycloak.
 * `AccessConsole` takes both as props precisely so it does not have to know.
 */
function useConsoleIdentity() {
  const queryClient = useQueryClient();
  const { data: identity } = useQuery({
    queryKey: IDENTITY_QUERY_KEY,
    queryFn: () => api.me(),
    retry: false,
  });
  const signOut = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IDENTITY_QUERY_KEY }),
  });
  return { identity, signOut };
}

/**
 * Which environment the console is pointed at, stated in the chrome.
 *
 * In the nav rather than buried in a settings screen, and it reloads on change
 * rather than invalidating queries one by one: every cached answer on the
 * screen came from the previous environment, and a half-swapped console showing
 * dev's connectors beside production's row counts is worse than a blink.
 */
function EnvironmentPicker() {
  const current = getEnvironment();
  const { data: environments = [] } = useQuery({
    queryKey: ['environments'],
    queryFn: () => listEnvironments(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const active = environments.find((environment) => environment.id === current);

  return (
    <label className="ml-auto mr-3 flex items-center gap-1.5 text-[10px]">
      <span className="font-mono uppercase tracking-[0.14em] text-zinc-400">Env</span>
      <select
        value={current}
        onChange={(event) => {
          setEnvironment(event.target.value);
          window.location.reload();
        }}
        aria-label="Environment"
        className={cn(
          'rounded-md border px-1.5 py-1 font-mono text-[10px] outline-none',
          'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
          // A protected environment looks different, because "am I about to do
          // this to production" should not require reading the word.
          active?.protected && 'border-amber-500 text-amber-700 dark:text-amber-400',
        )}
      >
        {environments.length === 0 && <option value={current}>{current}</option>}
        {environments.map((environment) => (
          <option key={environment.id} value={environment.id}>
            {environment.displayName}
            {environment.protected ? ' (protected)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

export function App() {
  const { identity, signOut } = useConsoleIdentity();
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [params, setParams] = useState<URLSearchParams>(paramsFromHash);

  // The hash is the router. Three tabs do not justify a routing library, and
  // the object explorer already reads `?type=` from the query string.
  useEffect(() => {
    const sync = () => {
      setTab(tabFromHash());
      setParams(paramsFromHash());
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  return (
    <CatalogProvider transport={transport}>
      <IdentityGate>
        <div className="flex h-full flex-col bg-zinc-50 dark:bg-zinc-950">
          <nav className="flex shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900">
            <span className="mr-4 flex items-center gap-2 py-3 text-sm font-semibold tracking-tight">
              <span className="text-base">◈</span> Catalog
            </span>
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  window.location.hash = id;
                  setTab(id);
                }}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-3 text-sm transition-colors ${
                  tab === id
                    ? 'border-violet-600 text-zinc-950 dark:text-zinc-50'
                    : 'border-transparent text-zinc-500 hover:text-zinc-950 dark:hover:text-zinc-50'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
            <EnvironmentPicker />
            <StoreBadge />
          </nav>

          <main className="min-h-0 flex-1 overflow-hidden">
            {tab === 'model' && (
              <CatalogManager
                title="Model"
                eyebrow="Published by your applications"
                intro="Every object type published into this catalog. Structure follows the publisher; names, descriptions and units are yours, and survive its next deploy."
                explorerHref={(type) => `#objects?type=${type}`}
              />
            )}
            {tab === 'objects' && (
              <ObjectExplorer
                // Passed rather than left to the library to sniff: the host is
                // the one that knows where its own router keeps parameters.
                type={params.get('type') ?? undefined}
                backHref="#model"
                backLabel="Model"
              />
            )}
            {tab === 'query' && <QueryPane />}
            {tab === 'dashboards' && <DashboardBoard />}
            {tab === 'connectors' && (
              <div className="h-full overflow-hidden">
                <PipelineConsole />
              </div>
            )}
            {tab === 'workflows' && <WorkflowCanvas />}
            {tab === 'lineage' && <FlowView />}
            {tab === 'activity' && <GovernanceTimeline />}
            {tab === 'access' && (
              <div className="h-full overflow-y-auto">
                <AccessConsole
                  identity={identity}
                  onSignOut={() => signOut.mutate()}
                  signOutPending={signOut.isPending}
                />
              </div>
            )}
          </main>
        </div>
      </IdentityGate>
    </CatalogProvider>
  );
}

/**
 * The query console, with the assistant attached only when the host actually
 * has one. Passing `onGenerate` unconditionally would put a button on screen
 * that fails on click, which teaches people to distrust the whole page.
 */
function QueryPane() {
  const { data } = useQuery({
    queryKey: ['query-ai', 'capabilities'],
    queryFn: () => api.aiCapabilities(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <QueryConsole
      onGenerate={
        data?.available ? async (prompt) => (await api.generateSql(prompt)).sql : undefined
      }
    />
  );
}

/**
 * Says out loud what the mounted store can do.
 *
 * Worth the pixels: "this catalog keeps history" and "this catalog is a live
 * view" are the same screen with very different meanings, and a reader who
 * assumes the wrong one draws wrong conclusions from every number on it.
 */
function StoreBadge() {
  const { data } = useQuery({
    queryKey: ['catalog', 'snapshot'],
    queryFn: () => transport.get<{ stats: { types: number } }>('/catalog'),
    staleTime: 60_000,
  });

  if (!data) return null;
  return (
    <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
      {data.stats.types} types · snapshots on
    </span>
  );
}
