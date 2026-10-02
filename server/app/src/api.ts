import type { ApiError, DeviceList } from "@sikemux/protocol";

import { config } from "./config.ts";

export class ApiProblem extends Error {}

async function get<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new ApiProblem(
      body?.error.message ?? `The API answered ${response.status}.`,
    );
  }
  return (await response.json()) as T;
}

export const api = {
  devices: (token: string) => get<DeviceList>("/v1/devices", token),
};
