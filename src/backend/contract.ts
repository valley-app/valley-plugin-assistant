import type { z } from 'zod'

export interface DriverMethod {
  schema: z.ZodTypeAny
  run: (vaultRoot: string, payload: unknown) => Promise<unknown> | unknown
}

export function defineDriverMethod<Schema extends z.ZodTypeAny, Result>(
  schema: Schema,
  run: (
    vaultRoot: string,
    payload: z.output<Schema>
  ) => Promise<Result> | Result
): DriverMethod {
  return {
    schema,
    run: (vaultRoot, payload) => run(vaultRoot, payload as z.output<Schema>)
  }
}

export function defineDriver<const Methods extends Record<string, DriverMethod>>(methods: Methods): Methods {
  return methods
}
