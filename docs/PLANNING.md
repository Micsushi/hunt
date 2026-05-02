# Planning First

Use this when starting a new project, a new component, or a meaningful new feature.

The rule: plan with CI in mind before implementation starts.

## Order

1. Add lint and style checks first.
   - Pick the formatter and lint tools before writing much code.
   - Make sure they can run locally and in automation.
   - Prefer one short entrypoint per area instead of ad hoc commands.
2. Define the pipeline next.
   - Decide what runs on every change.
   - Decide the smallest target that can validate one component quickly.
   - Decide when full CI should run across the whole system.
3. Design the architecture.
   - Name the main boundaries, responsibilities, inputs, outputs, and shared contracts.
   - Be explicit about what can run independently and what is intentionally coupled.
4. Design the components.
   - Break the architecture into concrete modules, services, pages, jobs, or adapters.
   - Define ownership and interfaces before wiring everything together.
5. Break the work into stages.
   - Make MVP the first stage.
   - Keep stage 1 small enough to verify quickly.
   - Add later stages only after MVP is clear.
6. Document confirmed decisions as you go.
   - Update the local project docs people will actually read.
   - Update the internal project memory or knowledge base so decisions do not disappear.

## Minimum Outputs

Before building, we should be able to answer:

- What lint and style tools are required?
- What command runs the smallest useful check?
- What command runs the component or feature CI target?
- What is the MVP?
- What are the later stages?
- What architecture and component boundaries are confirmed?
- Where were the confirmed decisions documented?

## Hunt Notes

For Hunt, prefer keeping this flow aligned with:

- `python quality.py <target>` for lint and style checks
- `python test.py <target>` for tests
- `python ci.py <target>` for the combined verification path

If the work crosses component boundaries, use the shared or full CI target instead of guessing.
