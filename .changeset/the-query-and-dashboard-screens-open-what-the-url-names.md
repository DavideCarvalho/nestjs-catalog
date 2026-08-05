---
"@dudousxd/nestjs-catalog-dashboard": minor
"@dudousxd/nestjs-catalog-react": minor
---

The query and dashboard screens open what the URL names

Last release mounted the search box and said plainly that two of its four kinds
of link were half-honest: `#query?savedQuery=…` and `#dashboards?dashboard=…`
landed on the right **screen** and stopped, because `QueryConsole` took only
`onGenerate` and `maxRows` and `DashboardBoard` took no props at all. The id
rode in the address bar unread, and somebody who clicked a result for a specific
dashboard got whichever board the component had picked for itself. That is worse
than not navigating: nothing on screen says the link failed. It also broke the
ordinary thing people do with a console, which is send somebody a link.

**Both screens now read the id, from the same two places `ObjectExplorer` does.**
`QueryConsole` takes `savedQueryId`, `DashboardBoard` takes `dashboardId`, and
each falls back to reading its parameter out of the hash — the precedent, and
the reasoning, `ObjectExplorer` already argued: the host is the one that knows
where its router keeps parameters, so it passes what it parsed, and the self-read
is the convenience for a host that does not route. Both props follow the prop
whenever it changes, not only on the first render, because navigating from one
saved query to another is how you arrive here a second time.

**An id naming something that is gone is refused out loud.** A deleted board, a
saved query somebody else removed. Falling back to the first row is what makes a
stale link look like a working link showing the wrong thing, so neither screen
does it any more: the dashboard board says *"That dashboard is not here"* and
quotes the id, the query console says the same above an editor it leaves
untouched, and the address is left naming the dead id — rewriting it would erase
the only evidence of which link broke. The old fallback survives for the case it
was right for, which is nobody having named anything: arriving at `#dashboards`
with no parameter still opens the first board.

**The address follows what you select, so a link can be copied out of it.** Both
screens report the selection through `onSavedQueryChange` / `onDashboardChange`
rather than writing the URL themselves — reading a URL is an observation, but
writing one is an act with effects outside a component's box, and a console
mounted inside somebody else's page should not find a library appending
parameters to its address. Omit the callback and nothing writes, which is exactly
what an existing host gets.

The shipped console wires both up, and writes with `history.replaceState`. That
is the whole of the history question: assigning `location.hash` would push an
entry per selection, so clicking through eleven dashboards would leave eleven
presses of Back between you and the screen you were on before. Replacing keeps
the address naming what is on screen — which is all a copyable link needs — and
costs nothing to leave.

`SavedQueryPanel` also marks which of its rows is the one currently in the
editor, so a console that filled the editor from a link says where the SQL came
from.

A spec holds **both ends**: it reads the href off the rendered search row and
follows it, then asserts the named saved query and the named board are what
appear. The parameter is spelled twice — once where the link is generated and
once where the screen is handed it — and nothing but that test makes the two
agree.
