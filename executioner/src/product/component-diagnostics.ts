const components = [
  "page_state", "field_recognition", "answer_matching", "authentication",
  "browser_interaction", "uploads", "workflow", "review",
] as const;
export type C3Component = typeof components[number];

export interface ComponentFailure {
  component: C3Component;
  operation: string;
}

// Keep the innermost observed failure. Messages and employer page content stay out of this record.
const failures = new WeakMap<object, ComponentFailure>();

export function recordComponentFailure(error: unknown, component: C3Component, operation: string): void {
  if (error instanceof Error && !failures.has(error) && components.includes(component) &&
      typeof operation === "string" && /^[a-z][a-z0-9_.-]{0,79}$/.test(operation)) {
    failures.set(error, { component, operation });
  }
}

export function componentFailure(error: unknown): ComponentFailure | undefined {
  return error instanceof Error ? failures.get(error) : undefined;
}
