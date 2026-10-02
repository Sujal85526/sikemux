import { Show, SignIn, UserButton } from "@clerk/react";

import { Devices } from "./Devices.tsx";

export function App() {
  return (
    <div className="shell">
      <header className="top">
        <span className="wordmark">Sikemux</span>
        <Show when="signed-in">
          <UserButton />
        </Show>
      </header>
      <main>
        <Show when="signed-out">
          <section className="welcome">
            <h1>Your Sikemux account</h1>
            <p>Sign in to see the Macs and phones on your account.</p>
            <SignIn routing="hash" />
          </section>
        </Show>
        <Show when="signed-in">
          <Devices />
        </Show>
      </main>
    </div>
  );
}
