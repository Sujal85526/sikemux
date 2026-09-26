const run = (page, action, arg) => page.evaluate(action, arg);

const openWindow = (page, sessionId, windowId) =>
  run(
    page,
    ([session, window]) => {
      showcase.cmd.selectSession(session);
      showcase.cmd.selectWindowId(window);
    },
    [sessionId, windowId],
  );

export const SCENES = [
  {
    name: "hero",
    settle: 1500,
    setup: async (page) => {
      await openWindow(page, "s-front", "w-agent-hero");
      await run(page, () =>
        showcase.cmd.openBrowserPane("agent-hero", { focus: false }),
      );
    },
    crops: { stage: ".stage" },
  },
  {
    name: "agents",
    setup: (page) => openWindow(page, "s-sikemux", "w-agent-rail"),
    crops: { chat: ".stage", rail: ".workspace-rail" },
  },
  {
    name: "files",
    setup: (page) => openWindow(page, "s-sikemux", "w-sikemux-files"),
    crops: { editor: ".stage", tree: ".ed-tree" },
  },
  {
    name: "terminals",
    setup: (page) => openWindow(page, "s-sikemux", "w-sikemux-term"),
    crops: { stage: ".stage" },
  },
  {
    name: "git",
    setup: (page) => openWindow(page, "s-sikemux", "w-sikemux-git"),
    crops: { stage: ".stage" },
  },
  {
    name: "command-deck",
    setup: async (page) => {
      await openWindow(page, "s-sikemux", "w-agent-rail");
      await run(page, () => showcase.cmd.openCommandPalette());
    },
    crops: { deck: "[role=dialog]" },
  },
  {
    name: "rundeck",
    settle: 1400,
    setup: async (page) => {
      await openWindow(page, "s-rundeck", "w-rundeck");
      await page.waitForTimeout(500);
      await run(page, async () => {
        const rundeck = await import("/src/plugins/rundeck/state.ts");
        rundeck.rundeckPush("p-rundeck", { kind: "matrix" });
      });
    },
    crops: { stage: ".stage" },
  },
  {
    name: "rundeck-deploy",
    settle: 1400,
    setup: async (page) => {
      await openWindow(page, "s-rundeck", "w-rundeck");
      await page.waitForTimeout(500);
      await run(page, async () => {
        const rundeck = await import("/src/plugins/rundeck/state.ts");
        rundeck.rundeckPush("p-rundeck", {
          kind: "execution",
          executionId: 48199,
          project: "platform",
          jobId: "job-production-billing-service",
          name: "billing-service",
          group: "deploy/production",
        });
      });
    },
    crops: { stage: ".stage" },
  },
  {
    name: "signoz",
    settle: 1400,
    setup: async (page) => {
      await openWindow(page, "s-signoz", "w-signoz");
      await page.waitForTimeout(500);
      await run(page, async () => {
        const signoz = await import("/src/plugins/signoz/state.ts");
        signoz.showService("p-signoz", "api-gateway", "overview");
      });
    },
    crops: { stage: ".stage" },
  },
  {
    name: "signoz-dashboard",
    settle: 1600,
    setup: async (page) => {
      await openWindow(page, "s-signoz", "w-signoz");
      await page.waitForTimeout(500);
      await run(page, async () => {
        const signoz = await import("/src/plugins/signoz/state.ts");
        signoz.openDashboard("p-signoz", "dash-api");
      });
    },
    crops: { stage: ".stage" },
  },
  {
    name: "projects-rail",
    setup: (page) => openWindow(page, "s-sikemux", "w-agent-rail"),
    crops: { rail: ".side-rail" },
  },
];
