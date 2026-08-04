---
"@dudousxd/nestjs-catalog-react": minor
"@dudousxd/nestjs-catalog": minor
---

Curated descriptions are rich text, stored as markdown

The two fields an operator writes prose into — a type's description and a
property's — are TipTap editors now, with bold, italic, inline code and lists.
`RichTextField` and `RichTextView` are exported for hosts that render the same
text elsewhere.

**They store markdown, and that choice is about everyone who is not this
editor.** `description` is served raw in the `/catalog` snapshot to whatever a
host built on top of it, and those consumers were written against plain text.
Markdown degrades into something a person can still read — `**bold**` — while
HTML degrades into `<strong>bold</strong>`, which is noise, and creates an XSS
surface in every consumer that decides to render it after all. One of those
failures is cosmetic and the other is a vulnerability.

So this is a contract change with no migration and nothing to update: plain text
is valid markdown, so every description written before, and every one declared
by a decorator, is unchanged and renders as itself. The type's docblock says so.

Three decisions worth keeping:

- **The read view is the same editor with `editable: false`**, not a second
  markdown renderer. Two parsers for one format is two answers to "what does
  this text mean", and they diverge on exactly the inputs nobody tests.
- **Nothing is saved when nothing changed.** Opening a field and closing it is
  not an edit; saving anyway writes an overlay row that shadows the declared
  description with an identical string and puts a change in the audit trail that
  nobody made.
- **Plain Enter belongs to the editor**, and Cmd/Ctrl+Enter commits. Stealing
  Enter is right for a one-line field and would make a multi-paragraph
  description impossible to write.

Headings, images and horizontal rules are configured off: these render in a
table cell, and an `<h1>` in a 20%-wide column is a line of enormous text that
would be there purely because the library offers it.

`@tiptap/react`, `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/pm` and
`tiptap-markdown` join the peer dependencies. A host that mounts only the NestJS
module never pulls them in.
