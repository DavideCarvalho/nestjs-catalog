import type { CatalogConnection } from '@dudousxd/nestjs-catalog/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plug, Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from './cn';
import {
  type ConnectableKind,
  ConnectionCheckResult,
  type ConnectionDraft,
  ConnectionKindFields,
  type UpdateDraft,
  connectableSpec,
  connectionConfigFor,
  connectionDraftFrom,
  connectionIsIncomplete,
  redactedCredentialIn,
} from './connection-form';
import { type ConnectionInput, catalogQueryKeys, useCatalogClient } from './context';
import { Button } from './ui/button';
import { TextField } from './ui/field';
import { WORKFLOW_NAME } from './workflow/name';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const REFUSAL = 'text-[11px] leading-relaxed text-red-600 dark:text-red-400';

/**
 * Making the address a source reads through, without leaving the canvas.
 *
 * THE HALF THAT WAS MISSING
 * -------------------------
 * The sink node can already create the thing it needs: the schema-discovery
 * panel turns confirmed columns into an object type, on a draft, without going
 * anywhere. The source node could only ever *choose* an address. With no
 * connection of the right kind, the picker above this said so and stopped —
 * leave the graph, open the Connections tab, make one, come back, find the node
 * again. Everything in between is where a train of thought goes to die.
 *
 * WHY THIS IS NOT AN ORDINARY "QUICK ADD"
 * ---------------------------------------
 * A connection is the credential and the address boundary. Every protection the
 * Connections screen has, it has for a reason somebody learned, and an inline
 * form that dropped any of them would be the place a password gets pasted into
 * what looks like an ordinary field. So, in full:
 *
 *  - **The fields are the Connections screen's fields**, from
 *    `connection-form.tsx`, per kind and derived from `CONNECTOR_KINDS`. Not a
 *    reduced set: a "quick" form that omitted the credential variable would
 *    teach people to put the credential in the URL.
 *  - **Test before save.** `POST pipeline/connections/check` reaches an address
 *    that has not been stored, which exists precisely because the field most
 *    likely to be wrong is the one nobody can verify by reading it — and because
 *    a connection saved to discover a typo is a row somebody has to remember to
 *    delete. A failed check comes back with the password, the query string and
 *    the fragment removed and the host and the user kept, which is what makes it
 *    worth showing at all.
 *  - **The refusal is surfaced, never worked around.** A deployment with
 *    `allowInlineCredentials` off refuses a URL carrying a password, and its
 *    message names the field to use instead. It is printed here verbatim. This
 *    form has no way of its own around it and must not grow one: the flag is a
 *    property of the deployment — of which database these rows land in — and a
 *    console that quietly re-routed the credential somewhere else would be
 *    answering a question nobody asked it.
 *  - **The placeholder is never sent as a secret.** See
 *    {@link redactedCredentialIn}. This form creates, so there is no stored row
 *    behind what it posts and nothing on the server to restore the real
 *    credential from — a pasted `REDACTED` would simply become the password.
 *
 * WHAT IT DOES TO THE DRAFT, DECIDED RATHER THAN DEFAULTED
 * --------------------------------------------------------
 * The new connection is selected onto the node immediately. Creating one from a
 * node and then not attaching it is the same trip to another screen, only
 * shorter: the picker directly above would list the connection somebody had just
 * made from this node, still saying the node reads through none of them.
 *
 * That selection is a real edit to the graph, so it marks the draft dirty, and
 * it does so through the inspector's own `push` rather than through any path of
 * its own. Nothing here is special-cased: typing a URL into the very same node
 * dirties it identically. It matters because `dirty` is what disables schema
 * discovery lower down the same panel, and the complaint on record about that
 * message is that it names saving without offering it. So the confirmation below
 * says what happened *and* what it costs, in one breath, rather than leaving
 * somebody to infer it from a control that has gone quiet. What it must not do
 * is pretend the graph is unchanged — a selection that did not dirty the draft
 * is a selection lost on the next reload.
 */
export function SourceConnectionCreator({
  kind,
  canEdit,
  hasOptions,
  onCreated,
}: {
  /**
   * The source node's own kind, which is what decides the fields.
   *
   * Not asked again on this form. A second kind dropdown could disagree with the
   * node it is standing in, and the connection it produced would then be
   * invisible in the picker above — filtered out for being the wrong kind by a
   * screen that had just offered to make it.
   *
   * {@link ConnectableKind} rather than `ConnectorKind`, and that narrowing is
   * `usesConnection`'s: a file path and pasted records belong to the load, so
   * there is no shared address to make.
   */
  kind: ConnectableKind;
  canEdit: boolean;
  /** Whether the picker above has anything in it. Changes the wording only. */
  hasOptions: boolean;
  /** Attach it to the node. The caller decides what that does to the draft. */
  onCreated: (connection: CatalogConnection) => void;
}) {
  const [open, setOpen] = useState(false);
  /**
   * The last one made here, kept after the form closes.
   *
   * The note it carries is the only place the cost of the selection is stated,
   * and the form it was made on is gone by then.
   */
  const [created, setCreated] = useState<CatalogConnection | null>(null);

  if (!canEdit) return null;

  if (open) {
    return (
      <InlineConnectionForm
        kind={kind}
        onCancel={() => setOpen(false)}
        onSaved={(connection) => {
          setCreated(connection);
          setOpen(false);
          onCreated(connection);
        }}
      />
    );
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus size={12} />
        {hasOptions ? 'New connection' : `Make the first ${kind} connection`}
      </Button>
      {created && (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          <span className="font-medium text-emerald-700 dark:text-emerald-400">
            "{created.name}" was created
          </span>{' '}
          and this node reads through it. That is a change to the graph like any other, so this{' '}
          {WORKFLOW_NAME.singular} now has unsaved edits — save it before asking the source what
          columns it has, since discovery reads the stored node.
        </p>
      )}
    </div>
  );
}

/**
 * The form itself: a name, the kind's address fields, a test and a save.
 *
 * Its own component so the disclosure above stays a disclosure. It also gives
 * the draft the right lifetime — cancelling unmounts this, so a half-typed
 * password does not sit in memory behind a collapsed button waiting to be
 * reopened and saved by somebody who has forgotten what is in it.
 */
function InlineConnectionForm({
  kind,
  onCancel,
  onSaved,
}: {
  kind: ConnectableKind;
  onCancel: () => void;
  onSaved: (connection: CatalogConnection) => void;
}) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<ConnectionDraft>(() => connectionDraftFrom());
  /**
   * A refusal this form made itself, before anything was sent.
   *
   * Separate state from `save.error` because it is not a failed request —
   * nothing was posted. Folding the two together would give a sentence about
   * what somebody pasted the wording of a server that might be worth retrying.
   */
  const [refusal, setRefusal] = useState<string | null>(null);

  const config = connectionConfigFor(kind, draft);

  const input = (): ConnectionInput => ({
    // No `id`, and that absence is load-bearing: the server restores a stored
    // credential where a caller posted back the redaction of one, and it can
    // only do that for a connection it can look up. A create has none, so what
    // is typed here is exactly what is reached and exactly what is stored.
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    kind,
    config,
    secretEnvVar: draft.secretEnvVar.trim() || undefined,
  });

  const check = useMutation({
    mutationFn: () => client.checkUnsavedConnection(input()),
  });

  const save = useMutation({
    mutationFn: () => client.saveConnection(input()),
    onSuccess: (connection) => {
      // Written into the cache as well as invalidated, for the same reason the
      // canvas does it after creating a transform: the picker above resolves its
      // options out of this list, and selecting an id that is not in it yet
      // shows "Configure the address here" for one render — telling somebody the
      // node uses no connection immediately after they made one.
      queryClient.setQueryData<CatalogConnection[]>(catalogQueryKeys.connections, (current) => [
        ...(current ?? []),
        connection,
      ]);
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.connections });
      onSaved(connection);
    },
  });

  const update: UpdateDraft = (patch) => {
    setDraft({ ...draft, ...patch });
    // Whatever was refused or reached was about the address as it was. Leaving
    // either beside an edited field is how a green tick comes to be read as
    // covering a URL nobody has tested.
    setRefusal(null);
    check.reset();
  };

  const attempt = () => {
    const placeholder = redactedCredentialIn(config);
    if (placeholder) {
      setRefusal(
        `The ${placeholder} you pasted has "REDACTED" where its password goes. That is what this catalog shows in place of a stored password, not the password itself — saving it would store the word. Paste the address with the real credential, or name the environment variable that holds it.`,
      );
      return;
    }
    setRefusal(null);
    save.mutate();
  };

  return (
    // A fieldset with a legend, and it earns both rather than decorating them.
    // This form stands inside the source inspector, which already has a "Name"
    // field of its own and — while the node carries its own address — a "URL" as
    // well. The labels here are deliberately the Connections screen's labels,
    // because there is one answer to what an HTTP connection needs; what stops
    // the two "URL"s from reading as the same question is that this one sits
    // inside something named, for a screen reader as much as for a reader.
    <fieldset className={cn('space-y-3 rounded-md border p-3', RULE)}>
      <legend className={cn('px-1 font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
        New {kind} connection
      </legend>
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        A {kind} connection, made here and used by this node. It is an object of its own once it is
        saved — other sources can read through it, and moving the address later moves all of them at
        once, which is the point of naming it.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Name"
          value={draft.name}
          onChange={(name) => update({ name })}
          placeholder="Fleet warehouse"
          hint="What the picker above will call it."
        />
        <TextField
          label="Description"
          value={draft.description}
          onChange={(description) => update({ description })}
          placeholder="What lives behind it (optional)"
        />
      </div>

      <ConnectionKindFields kind={kind} draft={draft} update={update} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => check.mutate()}
          // The ADDRESS has to be there; the name does not. Testing is about
          // whether the host answers, and refusing to reach it until a box that
          // has nothing to do with reaching it is filled in is how a check that
          // costs nothing goes unpressed.
          disabled={check.isPending || connectableSpec(kind).isIncomplete(draft)}
        >
          {check.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
          {check.isPending ? 'Reaching…' : 'Test connection'}
        </Button>
        <Button
          size="sm"
          onClick={attempt}
          disabled={save.isPending || connectionIsIncomplete(kind, draft)}
        >
          {save.isPending ? 'Saving…' : 'Save and use it'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        Testing reaches the address and stores nothing. Writing a row proves nothing about whether
        the host behind it answers, and finding that out afterwards means a load failing on a
        schedule hours later.
      </p>

      {check.data && <ConnectionCheckResult result={check.data} />}

      {check.error && !check.data && (
        <p className={REFUSAL}>
          {check.error instanceof Error ? check.error.message : 'The check itself failed.'}
        </p>
      )}

      {refusal && <p className={REFUSAL}>{refusal}</p>}

      {/*
       * The server's sentence, printed as it came. A deployment that refuses a
       * credential at rest says which field carries it and what to do instead,
       * and paraphrasing that would drop the part that names the field.
       */}
      {save.error && !refusal && (
        <p className={REFUSAL}>
          {save.error instanceof Error ? save.error.message : 'It could not be saved.'}
        </p>
      )}
    </fieldset>
  );
}
