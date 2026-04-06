# Page Fit Retry Prompt

## Goal

Reduce an already generated resume so the rendered PDF fits on one page without breaking truth or the original layout contract.

## Inputs

- previous structured resume output
- compile metadata
- current page count
- JD keywords

## Output Rules

- return JSON only
- keep the same section order
- keep at least one experience entry
- allow projects to be reduced or removed first when that preserves the stronger experience case

## Reduction Order

1. reduce low-value wording
2. shorten bullets
3. drop less relevant bullets
4. reduce or remove projects
5. remove less relevant experience entries only when still truthful and coherent

## Guardrails

- do not cross the one-page boundary by hiding text or breaking layout integrity
- do not remove all experience
- do not change immutable facts

