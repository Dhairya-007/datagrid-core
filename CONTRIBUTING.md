# Contributing

Thanks for looking. Issues and pull requests are welcome.

## Before you say something works

```sh
npm install
npm run verify    # typecheck, lint, format check, test, build
```

`npm run verify` is what CI runs. Do not claim a check passed that you did
not run.

## The rule that matters most

**Behaviour goes in the engine; only painting and events go in an adapter.**

If you are about to put a comparator, a filter decision, a selection rule, a
page calculation or an expansion toggle into a component, stop: it belongs
here, where it can be unit tested without rendering a frame, and where every
other adapter gets it for free.

## Conventions

- **No runtime dependencies.** The engine is pure computation on purpose, so
  that auditing it is tractable and it runs anywhere.
- **No DOM.** Nothing in `src/` may touch `window`, `document` or any browser
  API. It has to run in Node and in a worker.
- **Comments explain why.** The code already says what it does. A comment
  earns its place by recording a decision, a trade-off or a trap.
- **Public API carries doc comments.** Every exported member gets one, and
  anything with a non-obvious rule says what the rule is.
- `T` is the row type throughout.
- Prettier decides layout; do not hand-wrap against it.

## Tests

Every behavioural change needs a test, and the test goes at the lowest layer
that can express it.

Name tests as a sentence about behaviour, not about the method:

```ts
it('places nulls last in both directions by default', ...)   // yes
it('sortRows works', ...)                                     // no
```

Cover the edge first. The bugs in a grid live in empty data, a single row, a
filter that matches nothing, a column that was hidden while selected, a page
past the end, and a response that arrives after a newer one.

## Commits

- One concern per pull request.
- Imperative subject under ~72 characters, then a body that explains **why**
  if it is not obvious.
- Keep commits small and self-contained.
