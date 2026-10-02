import { useAuth } from "@clerk/react";
import type { Device } from "@sikemux/protocol";
import { useEffect, useEffectEvent, useState } from "react";

import { api } from "./api.ts";
import { LaptopIcon, PhoneIcon } from "./icons.tsx";

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; devices: Device[] };

const PLATFORMS: Record<Device["platform"], string> = {
  macos: "macOS",
  ios: "iOS",
  android: "Android",
};

function added(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function Devices({ ready }: { ready: boolean }) {
  const { isSignedIn, getToken } = useAuth();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const read = useEffectEvent(async () => {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to see your devices.");
    return api.devices(token);
  });

  useEffect(() => {
    if (!ready || !isSignedIn) return;
    let live = true;
    read()
      .then(
        (list) => live && setLoad({ state: "loaded", devices: list.devices }),
      )
      .catch(
        (error: unknown) =>
          live &&
          setLoad({
            state: "failed",
            message: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      live = false;
    };
  }, [ready, isSignedIn]);

  if (load.state === "failed") return <p className="problem">{load.message}</p>;

  const devices = load.state === "loaded" ? load.devices : null;
  return (
    <div className="groups">
      <DeviceGroup
        title="Hosts"
        empty="No hosts yet. In Sikemux on your computer, open Settings, then Devices, and sign in."
        devices={devices?.filter((device) => device.role === "host") ?? null}
      />
      <DeviceGroup
        title="Clients"
        empty="No clients yet. Sign in to Sikemux on your phone."
        devices={devices?.filter((device) => device.role === "client") ?? null}
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
  devices: Device[] | null;
}) {
  return (
    <section className="group">
      <h2>
        {title}
        {devices ? <span className="count">{devices.length}</span> : null}
      </h2>
      {devices === null ? (
        <ul className="rows" aria-busy="true">
          <li className="row placeholder" />
        </ul>
      ) : devices.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <ul className="rows">
          {devices.map((device) => (
            <li key={device.key} className="row">
              <span className="glyph">
                {device.role === "host" ? (
                  <LaptopIcon size={18} />
                ) : (
                  <PhoneIcon size={18} />
                )}
              </span>
              <span className="name">{device.name}</span>
              <span className="detail">
                {PLATFORMS[device.platform] ?? device.platform}
                {device.channel ? ` · ${device.channel}` : ""}
                {` · added ${added(device.createdAt)}`}
              </span>
              <code className="key" title={device.key}>
                {device.key.slice(0, 8)}
              </code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
