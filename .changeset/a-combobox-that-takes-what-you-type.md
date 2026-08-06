---
'@dudousxd/nestjs-catalog-react': minor
---

New `Combobox` / `ComboboxField`: a searchable select that also accepts a value nobody offered.

`Select` is a closed set — it renders a button, and every value is one of its rows. That is right
for a mode or a kind, whose options are three and written in this repository. It is wrong for a list
a *deployment* supplies, which is what the call node's workflow picker needed and what these screens
will keep needing: a fleet announcing three hundred workflows renders three hundred rows in a popup
whose only gesture is "scroll until you see it", and a workflow served by a worker too old to
publish its registrations is not on the list at all and is perfectly callable.

Built on Base UI's `Autocomplete` rather than its `Combobox`, and the difference is the whole point.
`Combobox` has a *selected value*: its input is a query over a closed list, and what you end up with
is one of the items. `Autocomplete` has no selected value — the input's text **is** the value — so
free entry is not a feature bolted onto a picker, it is what the primitive already is.

- **Picking and typing are told apart.** `onValueChange` fires for keystrokes, `onSelect` for a
  committed row. Base UI also fills the input on an item press, which arrives as a value change
  reasoned `item-press`; that one is dropped, so a caller writing two fields from one row cannot
  have the second immediately overwritten by the keystroke-shaped echo of the first.
- **Reopening shows the whole list again.** The query is held separately from the value and reset on
  every open. Filtering by the value would open the popup onto the single row already chosen, and
  the only way to see the others would be to delete what is there.
- **A row can be shown and refused.** `disabled` greys a row and blocks the commit — twice, in the
  rendering and again in the click handler, because what may be committed is a rule and not a
  rendering decision. Omitting such a row instead is how a picker comes to hide the thing somebody
  was looking for.
- **The search reads more than the label.** `keywords` is matched and never shown, because somebody
  hunting the Python half of a fleet types the group, and somebody who half-remembers a workflow
  types what it does.
- **Substring, not prefix**, since these names are dotted and namespaced and `reconcile` is as
  likely a query as `billing`. Labels truncate with a `title`, because the distinguishing half of
  `billing.reconcile.nightly` is the end.
- **An empty result says so.** `emptyMessage` renders in a live region Base UI keeps mounted, rather
  than leaving a blank popup that reads as a broken field.

The popup animates and honours `prefers-reduced-motion` as a fallback rather than as the ceiling.
