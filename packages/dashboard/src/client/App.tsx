import {
  AccessConsole,
  Button,
  CatalogManager,
  CatalogProvider,
  CatalogSearch,
  DashboardBoard,
  FlowView,
  GovernanceTimeline,
  ObjectExplorer,
  PipelineConsole,
  QueryConsole,
  Select,
  Tabs,
  TabsPanel,
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
  Search,
  ShieldHalf,
  TerminalSquare,
  Workflow,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IDENTITY_QUERY_KEY, KeyGate } from './KeyGate';
import { TabStrip } from './TabStrip';

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
 * The one screen reached by hash and by shortcut, and never by a tab.
 *
 * Search is a route like any other — `#search` can be bookmarked, sent to
 * somebody, and reloaded — but it is deliberately absent from `TABS`. Nine tabs
 * plus the brand and the controls pinned beside them already need ~1150px, and
 * the strip scrolls below that; a tenth would push the environment picker
 * towards the edge to buy a destination a `⌘K` reaches faster than a click can.
 * `SearchLauncher` is the pointer's way in and costs one 28px square instead.
 */
const SEARCH_ROUTE = 'search';

/** Every place the hash can name: the nine tabs, plus the tabless one. */
type Route = Tab | typeof SEARCH_ROUTE;

/**
 * A guard rather than a cast, because this is the one place a string from the
 * address bar becomes a `Tab` and an assertion here would let a renamed tab
 * through to `TabsPanel`, which would then match nothing and render blank.
 */
function isTab(value: string): value is Tab {
  return TABS.some((tab) => tab.id === value);
}

/**
 * The hash is the router, and everything before the `?` is the route.
 *
 * Matching the whole hash meant `#objects?type=Mvr` — the link the model
 * screen generates — matched no tab and silently fell back to the model. The
 * address bar changed and the screen did not, which reads as a click that
 * never landed. The search rows generate the same shape of link, so the same
 * split is what makes them land.
 */
function routeFromHash(): Route {
  const route = window.location.hash.replace('#', '').split('?')[0] ?? '';
  if (route === SEARCH_ROUTE) return SEARCH_ROUTE;
  return isTab(route) ? route : 'model';
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
    // A div, not a label. `Select` renders its own control and carries its own
    // `ariaLabel`, so wrapping it in a label gave a screen reader two names for
    // one thing — and gave the label no control of its own to point at.
    <div className="ml-auto mr-3 flex items-center gap-1.5 text-[10px]">
      <span aria-hidden className="font-mono uppercase tracking-[0.14em] text-zinc-400">
        Env
      </span>
      <Select
        value={current}
        onValueChange={(next) => {
          setEnvironment(next);
          window.location.reload();
        }}
        ariaLabel="Environment"
        className={cn(
          'font-mono text-[10px]',
          // A protected environment looks different, because "am I about to do
          // this to production" should not require reading the word.
          active?.protected && 'border-amber-500 text-amber-700 dark:text-amber-400',
        )}
        options={
          environments.length === 0
            ? [{ value: current, label: current }]
            : environments.map((environment) => ({
                value: environment.id,
                label: environment.displayName,
                ...(environment.protected ? { hint: 'protected' } : {}),
              }))
        }
      />
    </div>
  );
}

export function App() {
  const { identity, signOut } = useConsoleIdentity();
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [params, setParams] = useState<URLSearchParams>(paramsFromHash);

  /**
   * Where Escape goes when you leave the search screen.
   *
   * Search has no tab, so there is nothing highlighted to click back to — and
   * the browser's own Back is the only other way out, which on a hash router
   * means walking backwards through every tab visited this session. Remembering
   * the last screen with a tab makes `⌘K`, read, Escape a round trip that ends
   * where it started, which is the only shape in which a shortcut-opened search
   * is worth using mid-task.
   */
  const cameFrom = useRef<Tab>(isTab(route) ? route : 'model');
  useEffect(() => {
    if (isTab(route)) cameFrom.current = route;
  }, [route]);

  // The hash is the router. Three tabs do not justify a routing library, and
  // the object explorer already reads `?type=` from the query string.
  useEffect(() => {
    const sync = () => {
      setRoute(routeFromHash());
      setParams(paramsFromHash());
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  /**
   * The shortcut, because a search box people have to aim at is one they do not
   * use.
   *
   * Bound to the window rather than to the launcher, since the whole point is
   * reaching it from the middle of another screen. It writes the hash instead of
   * calling `setRoute`, so every way in — the button, this, a pasted `#search`
   * URL — goes through the one router and leaves an address somebody can send on.
   *
   * The hash is re-read here rather than closed over, which keeps the listener
   * bound once for the life of the console; a dependency on `route` would detach
   * and reattach it on every navigation for no behaviour.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        // Firefox and Chrome both aim ⌘K at the browser's own address bar, so
        // without this the console's search never opens and the URL bar does.
        event.preventDefault();
        window.location.hash = SEARCH_ROUTE;
        return;
      }
      // Only from search, so this cannot swallow an Escape that a dialog, a
      // sheet or a half-typed cell editor on another screen is listening for.
      if (event.key === 'Escape' && routeFromHash() === SEARCH_ROUTE) {
        window.location.hash = cameFrom.current;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <CatalogProvider transport={transport}>
      <IdentityGate>
        {/* One Tabs root around BOTH the strip and the panels, which is the
            whole point of using it: the tabs were a row of `<button>`s as far
            as a screen reader was concerned — no roving tabindex, no arrow-key
            movement, and no `aria-controls` relationship to the screen they
            reveal. Splitting the strip from the panels would keep the last of
            those broken while looking correct. */}
        <Tabs
          value={route}
          onValueChange={(next) => {
            window.location.hash = next;
            // The hash write above fires `hashchange`, which sets this anyway;
            // doing it here too is what keeps the click instant rather than a
            // frame behind. Guarded, so a value that is not a tab cannot get in
            // by this door — only `routeFromHash` may name the tabless route.
            if (isTab(next)) setRoute(next);
          }}
          className="flex h-full flex-col bg-zinc-50 dark:bg-zinc-950"
        >
          {/* Nine tabs plus the brand and two controls need ~1150px. Below that
              the strip used to push the whole DOCUMENT sideways — `nav` is
              `shrink-0` inside a flex column, so nothing absorbed the excess and
              the page itself grew a horizontal scrollbar, taking every screen
              with it. At 809px it overflowed by 345.

              So the tabs get their own scroll container and the things that are
              not tabs stay pinned: the brand on the left, the environment picker
              and store badge on the right. Scrolling a tab strip is ordinary;
              having the environment you are editing scroll off the screen is
              not.

              Search joins the pinned group rather than the strip, and as an icon
              rather than a tab or a box: a tenth tab would spend ~90px of the
              same budget, and an always-visible input several times that. One
              28px square is what the fix above can afford. */}
          <nav className="flex shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900">
            <span className="mr-4 flex shrink-0 items-center gap-2 py-3 text-sm font-semibold tracking-tight">
              <span className="text-base">◈</span> Catalog
            </span>
            <TabStrip tabs={TABS} value={route} />
            {/* Outside the scrolling strip on purpose. Scrolling a tab strip is
                ordinary; having the environment you are editing scroll off the
                screen is not. */}
            <div className="flex shrink-0 items-center gap-1 pl-2">
              <SearchLauncher active={route === SEARCH_ROUTE} />
              <EnvironmentPicker />
              <StoreBadge />
            </div>
          </nav>

          {/* Panels rather than `tab === x &&`. Base UI unmounts the
              unselected ones, so this keeps the exact behaviour the conditional
              had — each screen owns a query, and keeping them all mounted means
              every tab polls for as long as the console is open — while giving
              each panel the `aria-labelledby` back to its tab that a bare
              conditional cannot have. */}
          <main className="min-h-0 flex-1 overflow-hidden">
            <TabsPanel value="model" className="h-full">
              <CatalogManager
                title="Model"
                eyebrow="Published by your applications"
                intro="Every object type published into this catalog. Structure follows the publisher; names, descriptions and units are yours, and survive its next deploy."
                explorerHref={(type) => `#objects?type=${type}`}
              />
            </TabsPanel>
            <TabsPanel value="objects" className="h-full">
              <ObjectExplorer
                // Passed rather than left to the library to sniff: the host is
                // the one that knows where its own router keeps parameters.
                type={params.get('type') ?? undefined}
                backHref="#model"
                backLabel="Model"
              />
            </TabsPanel>
            <TabsPanel value="query" className="h-full">
              <QueryPane />
            </TabsPanel>
            <TabsPanel value="dashboards" className="h-full">
              <DashboardBoard />
            </TabsPanel>
            <TabsPanel value="connectors" className="h-full overflow-hidden">
              <PipelineConsole />
            </TabsPanel>
            <TabsPanel value="workflows" className="h-full">
              <WorkflowCanvas />
            </TabsPanel>
            <TabsPanel value="lineage" className="h-full">
              <FlowView />
            </TabsPanel>
            <TabsPanel value="activity" className="h-full">
              <GovernanceTimeline />
            </TabsPanel>
            <TabsPanel value="access" className="h-full overflow-y-auto">
              <AccessConsole
                identity={identity}
                onSignOut={() => signOut.mutate()}
                signOutPending={signOut.isPending}
              />
            </TabsPanel>
            {/* A panel with no tab above it. Base UI is content with that — the
                panel matches on `value` and simply gets no `aria-labelledby`,
                which is why the screen carries its own heading. */}
            <TabsPanel value={SEARCH_ROUTE} className="h-full">
              <SearchScreen />
            </TabsPanel>
          </main>
        </Tabs>
      </IdentityGate>
    </CatalogProvider>
  );
}

/**
 * The way in for a pointer, at the cost of one square.
 *
 * An icon and not a labelled button, and in the pinned group rather than the
 * strip: the nav is the constrained surface in this console, and the fix that
 * stopped the whole document scrolling sideways is only worth as much as the
 * room left over from it. `aria-label` carries the name that the icon does not,
 * and `title` carries the shortcut, since a shortcut nobody is told about is a
 * shortcut only its author uses.
 *
 * Named "Search" and not "Search the catalog", which is what the box on the
 * screen it opens is called. Two controls with one accessible name is a screen
 * reader announcing the same thing for the button and for the field it focuses.
 *
 * Both accelerators are shown rather than sniffing the platform. `navigator
 * .platform` is deprecated, `userAgent` lies on request, and the cost of being
 * wrong is telling a Mac user to press a key that does nothing.
 */
function SearchLauncher({ active }: { active: boolean }) {
  // Spread rather than `aria-current={active ? 'page' : undefined}`: under
  // `exactOptionalPropertyTypes` an optional prop does not accept an explicit
  // `undefined`. Annotated rather than asserted so `'page'` stays a literal.
  const current: { 'aria-current'?: 'page' } = active ? { 'aria-current': 'page' } : {};

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => {
        window.location.hash = SEARCH_ROUTE;
      }}
      aria-label="Search"
      title="Search the catalog (⌘K / Ctrl-K)"
      {...current}
      // No tab is highlighted while search is open, because search has no tab.
      // Without this the console would give no answer at all to "where am I".
      className={active ? 'text-sky-600 dark:text-sky-400' : ''}
    >
      <Search size={15} />
    </Button>
  );
}

/**
 * The search screen, told where each kind of thing lives in THIS console.
 *
 * All three hrefs are passed rather than any being left off. A kind with no
 * href renders as a plain row — correct for a host that mounts no screen for
 * it, and wrong here, where all four kinds are one hash away: a box that
 * crosses the catalog and then dead-ends on two of its four groups is a worse
 * answer than the nine tabs it replaces.
 *
 * **What the two id hrefs do and do not promise.** `#objects?type=X` is honest
 * end to end: `ObjectExplorer` is handed `params.get('type')` below and opens on
 * that type, and the string is the same one `CatalogManager` generates, which is
 * the whole reason `explorerHref` has the shape it does. `#query?savedQuery=…`
 * and `#dashboards?dashboard=…` land on the right SCREEN and no further —
 * `QueryConsole` takes no saved-query id and `DashboardBoard` takes no props at
 * all, so today both open on their own default and the id rides along unread.
 * That is deliberately not nothing: the row navigates, the parameter is already
 * in the address for the day either screen learns to read it, and the id is the
 * only part of the link that would have to change if they never do. It is also
 * the reason those hrefs are worth reviewing again the moment either screen
 * grows a prop.
 *
 * Encoded rather than interpolated raw. A type name is an identifier and an id
 * is generated, so `encodeURIComponent` is the identity function for every value
 * that exists today — which is exactly when it costs nothing to be right about
 * the value that does not.
 */
function SearchScreen() {
  const mount = useRef<HTMLDivElement | null>(null);

  // The cursor, put where the shortcut promised it would be. The library screen
  // cannot do this for itself — a component that steals focus on mount is wrong
  // for every host that renders it beside something else — so the host that made
  // it a whole screen is the one that owes it. `TabsPanel` unmounts what is not
  // selected, so this runs on each arrival rather than only on the first.
  useEffect(() => {
    mount.current?.querySelector('input')?.focus();
  }, []);

  return (
    <div ref={mount} className="h-full">
      <CatalogSearch
        explorerHref={(type) => `#objects?type=${encodeURIComponent(type)}`}
        savedQueryHref={(id) => `#query?savedQuery=${encodeURIComponent(id)}`}
        dashboardHref={(id) => `#dashboards?dashboard=${encodeURIComponent(id)}`}
      />
    </div>
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
