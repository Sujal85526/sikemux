import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { schema } from "../generated/schema.ts";
import type { Definitions } from "../generated/types.ts";

export type Validation<Name extends keyof Definitions & string> =
  { ok: true; value: Definitions[Name] } | { ok: false; problems: string[] };

export interface Validator {
  validate<Name extends keyof Definitions & string>(
    name: Name,
    value: unknown,
  ): Validation<Name>;
}

/** Checks values against the protocol's schema, compiling each definition once. */
export function validator(): Validator {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  return {
    validate(name, value) {
      const check = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
      if (!check)
        throw new Error(`The protocol has no definition named ${name}`);
      if (check(value))
        return { ok: true, value: value as Definitions[typeof name] };
      const problems = (check.errors ?? []).map(
        (error) =>
          `${error.instancePath || "the value"} ${error.message ?? "is not valid"}`,
      );
      return { ok: false, problems };
    },
  };
}
