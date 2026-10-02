import { useAuth } from "@clerk/react";
import type { Device } from "@sikemux/protocol";
import { useEffect, useState } from "react";

import { api } from "./api.ts";

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; devices: Device[] };

const PLATFORMS: Record<Device["platform"], string> = {
  macos: "macOS",
  ios: "iOS",
  android: "Android",
};
const CHANNELS: Record<NonNullable<Device["channel"]>, string> = {
  dev: "dev",
  nightly: "nightly",
  stable: "stable",
};

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function Devices() {
  const { getToken } = useAuth();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let live = true;
    getToken()
      .then((token) => {
        if (!token) throw new Error("Sign in again to see your devices.");
        return api.devices(token);
      })
      .then(
        (list) => live && setLoad({ state: "loaded", devices: list.devices }),
      )
      .catch(
        (error: unknown) =>
          live &&
          setLoad({
            state: "failed",
            message: String((error as Error).message ?? error),
          }),
      );
    return () => {
      live = false;
    };
  }, [getToken]);

  if (load.state === "loading")
    return <p className="quiet">Loading your devices…</p>;
  if (load.state === "failed") return <p className="problem">{load.message}</p>;

  const hosts = load.devices.filter((device) => device.role === "host");
  const clients = load.devices.filter((device) => device.role === "client");
  return (
    <div className="devices">
      <DeviceGroup
        title="Macs"
        empty="No Macs yet. In Sikemux on your Mac, open Settings, Devices and sign in."
        devices={hosts}
      />
      <DeviceGroup
        title="Phones"
        empty="No phones yet. Sign in to Sikemux on your phone."
        devices={clients}
      />
    </div>
  );
}

function DeviceGroup({
  title,
  empty,
  devices,
}: {
  title: string;
  empty: string;
  devices: Device[];
}) {
  return (
    <section className="group">
      <h2>
        {title} <span className="count">{devices.length}</span>
      </h2>
      {devices.length === 0 ? (
        <p className="quiet">{empty}</p>
      ) : (
        <ul className="rows">
          {devices.map((device) => (
            <li key={device.key} className="row">
              <span className="name">{device.name}</span>
              <span className="detail">
                {PLATFORMS[device.platform] ?? device.platform}
                {device.channel
                  ? ` · ${CHANNELS[device.channel] ?? device.channel}`
                  : ""}
                {` · added ${when(device.createdAt)}`}
              </span>
              <code className="key">{device.key.slice(0, 8)}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
