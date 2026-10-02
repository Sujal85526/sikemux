import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { schema, validator } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "../fixtures");
const names = Object.keys(schema.$defs) as (keyof typeof schema.$defs)[];
const { validate } = validator();

describe("contract fixtures", () => {
  it("cover every definition, so the Rust round trip sees every type", () => {
    expect(readdirSync(fixtures).sort()).toEqual([...names].sort());
  });

  for (const name of names) {
    for (const file of readdirSync(join(fixtures, name))) {
      it(`${name}/${file} matches its definition`, () => {
        const value: unknown = JSON.parse(
          readFileSync(join(fixtures, name, file), "utf8"),
        );
        expect(validate(name, value)).toEqual({ ok: true, value });
      });
    }
  }
});

describe("validator", () => {
  it("names every problem with where it is", () => {
    const result = validate("Health", {
      status: "fine",
      version: 7,
      extra: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(
      expect.arrayContaining([
        "the value must have required property 'database'",
        "the value must NOT have additional properties",
        "/status must be equal to one of the allowed values",
        "/version must be string",
      ]),
    );
  });
});
