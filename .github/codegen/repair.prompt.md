The scaffold must build and lint clean, but a verification command failed.

## Failing command

`{{FAILING_COMMAND}}`

## Output (tail)

```
{{FAILING_OUTPUT}}
```

# Task

Make the **minimal** change needed to fix this, while preserving the scaffold and
every rule in `AGENTS.md`. Do not delete planned files or drop features — fix
types, imports, configuration usage, or missing stubs.

Re-run `{{PNPM_INVOCATION}} build` to confirm the fix before you stop. Do **not**
edit `{{CONFIG_DIR}}/server.ts` or `{{CONFIG_DIR}}/db.ts`.
