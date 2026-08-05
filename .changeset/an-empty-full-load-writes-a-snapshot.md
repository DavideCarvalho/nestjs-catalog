---
"@dudousxd/nestjs-catalog-pipeline": minor
---

A full connector run that read nothing now leaves a snapshot

A batch is the only thing that creates the snapshot row, and the batching loop
wrote none when there were no rows. So a full-mode connector whose source
returned nothing left no snapshot at all, and the commit that followed refused
with "no snapshot has been written" — an error naming the wrong event entirely,
for a source that answered perfectly and had nothing to say.

The labels ride on that batch, and the labels are how an operator's
acknowledgement that a collapse was deliberate reaches the snapshot. So the one
case `expectShrink` was built for — a source that really was emptied — was the
one case where it could not arrive.

Incremental runs are deliberately excluded: the carry-forward that follows
writes the snapshot and carries the same labels, so a batch here would be a
second write on a path that already has one.

An empty batch is a statement — the load ran and produced nothing. Writing no
batch at all is silence, and the store cannot tell silence from a crash.
