import { describe, expect, it } from "vitest";

import {
  bundle,
  collect,
  openapi,
  rust,
  typescript,
} from "../scripts/generator.mjs";

function document(file: string, $defs: Record<string, unknown>) {
  return {
    [file]: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: file,
      $defs,
    },
  };
}

const device = {
  ...document("devices.json", {
    Device: {
      description: "A registered device.",
      type: "object",
      properties: {
        key: { $ref: "common.json#/$defs/DeviceKey" },
        role: { $ref: "#/$defs/DeviceRole" },
        name: { type: "string", maxLength: 64 },
        lastSeenAt: { type: ["string", "null"], format: "date-time" },
        channel: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        load: { type: "number" },
      },
      required: ["key", "role", "name", "lastSeenAt", "tags", "load"],
      additionalProperties: false,
    },
    DeviceRole: { type: "string", enum: ["host", "client", "device.revoked"] },
  }),
  ...document("common.json", {
    DeviceKey: {
      description: "An iroh public key, in hex.",
      type: "string",
      pattern: "^[0-9a-f]{64}$",
    },
  }),
};

describe("collect", () => {
  it("accepts the supported shapes", () => {
    expect([...collect(device).keys()].sort()).toEqual([
      "Device",
      "DeviceKey",
      "DeviceRole",
    ]);
  });

  const rejects: [string, Record<string, unknown>, RegExp][] = [
    [
      "open objects",
      { A: { type: "object", properties: {} } },
      /additionalProperties: false/,
    ],
    [
      "inline enums",
      {
        A: {
          type: "object",
          properties: { a: { type: "string", enum: ["x"] } },
          additionalProperties: false,
        },
      },
      /enums need their own definition/,
    ],
    [
      "inline objects",
      {
        A: {
          type: "object",
          properties: { a: { type: "object" } },
          additionalProperties: false,
        },
      },
      /objects and enums need their own definition/,
    ],
    [
      "optional nullable properties",
      {
        A: {
          type: "object",
          properties: { a: { type: ["string", "null"] } },
          additionalProperties: false,
        },
      },
      /optional or nullable, not both/,
    ],
    [
      "names that do not survive snake_case",
      {
        A: {
          type: "object",
          properties: { deviceID: { type: "string" } },
          additionalProperties: false,
        },
      },
      /camelCase words/,
    ],
    [
      "dangling references",
      {
        A: {
          type: "object",
          properties: { a: { $ref: "#/$defs/B" } },
          additionalProperties: false,
        },
      },
      /points at nothing/,
    ],
    [
      "the reserved enum value",
      { A: { type: "string", enum: ["unknown"] } },
      /reserved/,
    ],
    [
      "unsupported keywords",
      { A: { type: "string", oneOf: [] } },
      /"oneOf" is not supported/,
    ],
    ["lowercase definition names", { a: { type: "string" } }, /PascalCase/],
  ];
  for (const [what, $defs, message] of rejects) {
    it(`rejects ${what}`, () => {
      expect(() => collect(document("a.json", $defs))).toThrow(message);
    });
  }

  it("rejects a name defined twice", () => {
    const twice = {
      ...document("a.json", { A: { type: "string" } }),
      ...document("b.json", { A: { type: "string" } }),
    };
    expect(() => collect(twice)).toThrow(/already defined in a.json/);
  });
});

describe("typescript", () => {
  it("writes interfaces, unions and a definition map", () => {
    const out = typescript(collect(device));
    expect(out).toContain(
      "/** A registered device. */\nexport interface Device {",
    );
    expect(out).toContain(
      "  lastSeenAt: string | null;\n  channel?: string;\n  tags: string[];",
    );
    expect(out).toContain(
      'export type DeviceRole = "host" | "client" | "device.revoked";',
    );
    expect(out).toContain(
      "/** An iroh public key, in hex. */\nexport type DeviceKey = string;",
    );
    expect(out).toContain(
      "export interface Definitions {\n  Device: Device;\n  DeviceKey: DeviceKey;",
    );
  });
});

describe("rust", () => {
  const out = rust(collect(device));

  it("maps optional and nullable fields to Option, skipping only the optional ones", () => {
    expect(out).toContain("    pub last_seen_at: Option<String>,\n");
    expect(out).toContain(
      '    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub channel: Option<String>,\n',
    );
  });

  it("leaves Eq off structs holding floats", () => {
    expect(out).toContain(
      "#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]\n#[serde(rename_all",
    );
  });

  it("gives every enum an Unknown variant for values added later", () => {
    expect(out).toContain(
      '    #[serde(rename = "device.revoked")]\n    DeviceRevoked,\n',
    );
    expect(out).toContain("    #[serde(other)]\n    Unknown,\n}");
  });

  it("keeps code within rustfmt's width, so cargo fmt leaves the file alone", () => {
    const code = out
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"));
    for (const line of code) expect(line.length).toBeLessThanOrEqual(100);
  });
});

describe("bundle and openapi", () => {
  it("rewrites references for each document", () => {
    const definitions = collect(device);
    expect(bundle(definitions).$defs.Device.properties.key).toEqual({
      $ref: "#/$defs/DeviceKey",
    });
    const api = openapi(
      new Map([
        ...definitions,
        ...collect(document("common.json", { ApiError: { type: "string" } })),
      ]),
      {
        routes: [
          {
            method: "get",
            path: "/v1/devices/{key}",
            operationId: "getDevice",
            summary: "One device",
            auth: "session",
            responses: {
              "200": { description: "The device.", body: "Device" },
            },
          },
        ],
      },
    );
    const operation = api.paths["/v1/devices/{key}"].get;
    expect(operation.parameters).toEqual([
      { name: "key", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(
      operation.responses["200"].content["application/json"].schema,
    ).toEqual({
      $ref: "#/components/schemas/Device",
    });
    expect(api.components.schemas.Device.properties.key).toEqual({
      $ref: "#/components/schemas/DeviceKey",
    });
  });

  it("refuses routes outside /v1", () => {
    expect(() =>
      openapi(collect(device), {
        routes: [
          {
            method: "get",
            path: "/devices",
            operationId: "x",
            summary: "",
            auth: "none",
            responses: {},
          },
        ],
      }),
    ).toThrow(/versioned under \/v1/);
  });
});
