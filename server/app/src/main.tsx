import { ClerkProvider } from "@clerk/react";
import { dark } from "@clerk/ui/themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { config } from "./config.ts";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={config.clerkPublishableKey}
      appearance={{ theme: dark }}
    >
      <App />
    </ClerkProvider>
  </StrictMode>,
);
