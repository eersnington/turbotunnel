# Code preferences

- Use strict TypeScript and model invariants in types. Avoid defensive checks for impossible typed states.
- Use Effect for services, layers, scoped resources, and async workflows. Keep pure functions pure.
- Parse external input at boundaries and use typed errors for expected failures.
- Keep raw platform types inside adapter modules.
- Hide mutable state behind lifecycle-oriented operations.
- Prefer small, cohesive modules over speculative abstractions.
- Preserve behavior unless a change is explicitly requested.
- Test through real seams. No module mocks or spies.