# Code preferences

- Use strict TypeScript and model invariants in types. Avoid defensive checks for impossible typed states.
- Use Effect for services, layers, scoped resources, and async workflows. Keep pure functions pure.
- Parse external input at boundaries and use typed errors for expected failures.
- Keep raw platform types inside adapter modules.
- Hide mutable state behind lifecycle-oriented operations.
- Prefer small, cohesive modules over speculative abstractions.
- Preserve behavior unless a change is explicitly requested.
- Test through real seams. No module mocks or spies.

# Verification Commands

- Use `bun run lint`, `bun run format`, and `bun run format:fix`.
- Use `bun run check-types` for type checking, `bun run test` for tests, and `bun run build` for production builds.
- Do not use `bunx` for linting, formatting, type checking, testing, or builds; use the repository scripts above.
