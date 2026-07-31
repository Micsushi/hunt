# ADR 0001: One strict TypeScript package

Status: accepted

## Decision

C3 v3 is one private ESM package targeting Node 22.18 or newer. TypeScript uses
strict checking, and tests run with Node's built-in test runner.

`npm test -- <path>` accepts a test file or directory. `npm run quality` runs
the type check and the complete test suite.

Component source may import its own implementation, the shared contracts, and
external packages. It may not import another component's implementation or any
C3 v2 path. The composition root may import component implementations solely
to assemble them. Every source path must have an explicit owner. The
architecture test parses TypeScript imports and exports to enforce these rules.

## Consequences

- F1 owns the package, test command, and dependency rule.
- Later component branches add source and tests inside this package.
- Contracts and the contract test kit remain empty until their F1 tasks.
- There is no test framework, component package, build wrapper, code generator,
  plugin loader, or service scaffold.
