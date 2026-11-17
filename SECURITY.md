# Security

## Reporting

Please report a vulnerability through GitHub's private vulnerability
reporting on this repository, rather than in a public issue.

## What this package does, and does not do

`gridcore` is pure computation. It has no runtime dependencies, reads no
network, no filesystem and no environment variables, and touches no DOM or
browser API. That is deliberate, and a pull request that changes it will be
declined: the small surface is what makes auditing it tractable.

## CSV injection

A cell beginning `=`, `+`, `-`, `@`, a tab or a carriage return is executed
as a formula when a CSV is opened in Excel, Sheets or LibreOffice, which
makes an export of user-supplied data a delivery mechanism for
[CSV injection](https://owasp.org/www-community/attacks/CSV_Injection).

`CsvExporter` and `toClipboardText` neutralise such values with a leading
apostrophe **by default**, inside the quotes so a reader cannot strip it
along with them. Leading spaces do not hide a formula from the check, and a
negative number is still exported as a number.

You can turn it off with `sanitizeFormulas: false` for a file that is
machine-read and must round-trip exactly. Do not turn it off for a file a
person will open.

## Untrusted input

- A saved view or a stored query is read back with `GridViewState.fromJSON`
  or `GridQuery.fromJSON`. Both are stamped with a schema version, refuse a
  document from a newer build rather than misreading it, and skip an entry
  they cannot read instead of failing the whole document.
- A filter tree restored from JSON carries no code. Functions — a column's
  accessors, an aggregation's reducer, a group spec's bucketing — are never
  serialised and are supplied again by your own code on restore.
- Pasted clipboard text is parsed, coerced to each column's type and put
  through that column's validator before anything is written.
