---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-react": minor
---

Reading a file stops holding it, and parquet is a format

Two things that are one subject: **file reads stream**, and **parquet is a
source format** — because parquet's row groups are the clearest case of a
format that was never meant to be read whole.

## What used to happen

`file`, `s3` and `http` read the entire payload into memory before parsing a
byte of it. For a 7.6 MB export that is the buffer, plus the decoded string,
plus every record built out of it, held at once, inside a durable step. The S3
fetcher was worse: it concatenated every object under the prefix into one array
before returning, so ten 40 MB drops were 400 MB of records in the heap before a
single row was written.

The write side has been bounded since it was written — `appendBatches`, 500 rows
at a time. The read side was the half nobody had bounded for anything but SQL.

## What streams now, and what does not

| Format | How it is read | Why |
|---|---|---|
| `csv` | stream | A row ends at a newline the scanner has already seen |
| `ndjson` | stream | Same |
| `parquet` | stream, one row group at a time | The format supplies the chunk boundary |
| `json` | whole | One value; the array may be nested in an envelope only found by parsing down to it |
| `xlsx` | whole | A ZIP whose shared-string table generally precedes the sheet — unchanged, cap intact |

`http` is **left whole**, deliberately. An incremental JSON parser would still
have to read down to `path` before yielding anything, and for a bare top-level
array the elements it would then yield are the whole response. The honest bound
for an HTTP source is pagination, which this connector does not do; streaming
the body would move where the memory is held without changing how much there is.

Measured on `af_fleet.csv` (7.6 MB, 103,087 data rows) with a consumer that
discards each record, which is the shape `appendBatches` has:

| | peak heap | peak RSS | records | blank lines | non-null `Mgmt Cd` |
|---|---|---|---|---|---|
| whole | 104.7 MB | 282.5 MB | 102,519 | 568 | 89,458 |
| streamed | **18.7 MB** | **94.3 MB** | 102,519 | 568 | 89,458 |

Identical rows, 5.6× less heap. The counts are #94's numbers and flip's: 568
blank lines skipped, 89,458 rows with a `Mgmt Cd`.

## Where a stream is still bounded

Streaming removes the memory ceiling and not every risk.

- **A remote read that goes silent** is not an error any SDK reports — it is a
  promise that never settles, holding a step until its lease expires with
  nothing recorded about why. `readIdleTimeoutMs` (default 60s, reset by every
  chunk) abandons it and says so.
- **`maxBytes`** is opt-in per connector and refuses before the transfer when
  the server declared a length, and mid-transfer when it did not.
- **`maxObjectsPerRun`** already bounded the S3 fan-out and still does.

## Back-pressure, and why S3 spools to disk first

An `AsyncIterable` consumed slowly by something writing to MySQL is exactly the
failure flip recorded: per-batch flushes paused the read for minutes and the
object store reset the connection (ECONNRESET, three to four minutes in),
because S3 closes a connection that has gone quiet. So every remote payload —
S3 object or HTTP body — is **spooled to a temp file and streamed from there**.
The download runs at full speed with nothing throttling it, and the slow half
reads a local file that is not going anywhere. Cost: one object's worth of temp
disk, released as soon as its records have been read. A local path is read
where it lies; `createReadStream` pauses the descriptor while the consumer is
away, which is the back-pressure, end to end.

It also makes parquet possible at all: the footer is at the end and row groups
are addressed by offset, so a reader seeks rather than walks.

## The watermark, on failure

`StreamedFetchResult.state` was already "asked only after `records` is
exhausted". The S3 fetcher now computes it from the objects whose **last record
has gone past**, not from the listing. A run that dies on the fourth of ten
objects never reaches `state()` and advances nothing; the three it did read are
left in an uncommitted snapshot and read again next time. A watermark taken
from the listing would have promised never to read five through ten again.

`StreamedFetchResult` gains **`notes?: () => string[]`**, and `RecordStream.notes`
becomes a function for the same reason `state` is one. #94's blank-line ledger
is a running count over rows not yet read; asking for it before the last row
would report zero for every streamed file, which is the exact silence #94 exists
to end.

## Parquet

**`hyparquet`**, loaded through the same optional-driver seam as `pg`, `mysql2`
and the S3 SDK. Unlike `xlsx` this is *not* a security workaround: hyparquet is
MIT, has **no runtime dependencies at all**, publishes weekly and has no OSV
advisory against any version — a plain dependency would be defensible. It is
optional because this package ships with zero runtime dependencies and a
consumer that never reads parquet should not acquire a decoder by installing a
catalog. hyparquet decompresses UNCOMPRESSED and SNAPPY natively; anything else
loads `hyparquet-compressors` if present, and is refused naming the codec, the
file and the package if not.

**Types.** Every temporal type becomes an ISO-8601 string in UTC, never a
`Date`: a `TIMESTAMP(MICROS)` or a legacy `INT96` carries precision a `Date`
cannot hold, and the library's default parser divides it away. A `DATE` becomes
`YYYY-MM-DD` and stops there — turning a calendar day into midnight UTC invents
an instant the file never contained.

| Parquet | Becomes |
|---|---|
| BOOLEAN, INT32, FLOAT, DOUBLE, FLOAT16 | number / boolean |
| INT64 within ±2^53 | number |
| INT64 outside it | **refused, by name and value** |
| STRING / UTF8 / ENUM | string |
| TIMESTAMP MILLIS/MICROS/NANOS, INT96 | ISO-8601 with 3 / 6 / 9 fractional digits |
| DATE | `YYYY-MM-DD` |
| UUID | canonical uuid string |
| JSON | the decoded value |
| LIST / MAP / group | array / object, walked |
| null | `null` |
| DECIMAL, precision ≤ 15 | number |
| DECIMAL, precision > 15 | **refused by name** — read through a double, would lose digits |
| TIME (MILLIS/MICROS) | **refused by name** — a bare count since midnight with no unit |
| raw BYTE_ARRAY | **refused by name** — the default is to decode every byte array as UTF-8 |
| INTERVAL, BSON, VARIANT, GEOMETRY, GEOGRAPHY | **refused by name** |

Every refusal is made from the schema **before the first row is read**, so a
column this cannot represent fails while the run has written nothing.

**A null is `null`**, and that is parquet's own answer rather than a position in
the CSV argument: presence lives in the definition levels, so a null field and a
field holding `""` are different things *in the file*. A CSV genuinely contains
an empty field where parquet contains an absence, so this format has nothing to
say about which of those a blank CSV cell should be.

## Also

`SOURCE_FORMATS` gains `parquet`; `.parquet` and `.parq` are recognised
extensions; the console derives its picker from the list. `FORMAT_READING` is a
`satisfies Record<SourceFormat, …>` map, so a sixth format is a compile error
until somebody says whether it streams.

`importOptional` moved to `optional-modules.ts` — unchanged, re-exported from
`sources.ts`, and only so that the parquet reader and `sources.ts` are not an
import cycle.
