import type { Health } from "@sikemux/protocol";
import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:4000";

type Reach =
  { state: "checking" } | { state: "up"; health: Health } | { state: "down" };

export function App() {
  const [reach, setReach] = useState<Reach>({ state: "checking" });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/v1/health`, { signal: controller.signal })
      .then((response) => response.json() as Promise<Health>)
      .then((health) => setReach({ state: "up", health }))
      .catch(() => {
        if (!controller.signal.aborted) setReach({ state: "down" });
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>Sikemux</h1>
      <p>
        Your account, and the devices signed in to it, will be managed here.
      </p>
      <p className="status">
        {reach.state === "checking" && "checking the API…"}
        {reach.state === "down" && "the API cannot be reached"}
        {reach.state === "up" &&
          `api ${reach.health.status} · ${reach.health.version.slice(0, 8)}`}
      </p>
    </main>
  );
}
