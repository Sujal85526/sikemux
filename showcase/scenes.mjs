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

export const README_SCREENSHOTS = {
  "hero-framed": "sikemux-hero.png",
  files: "project-editor-view.png",
  terminals: "project-term-view.png",
  git: "project-git-view.png",
  agents: "project-agents-view.png",
  "aws-billing": "cloud-aws-billing-view.png",
  "aws-ecs-logs": "cloud-aws-ecs-tasks-logs-view.png",
  "rundeck-deploy": "cicd-rundeck-deploy-view.png",
  "signoz-dashboard": "observability-signoz-view.png",
  bruno: "api-bruno-pane-view.png",
};

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
    setup: (page) => openWindow(page, "s-sikemux", "w-agent-replay"),
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
    name: "aws-ecs-logs",
    settle: 1500,
    setup: (page) =>
      run(page, async () => {
        const aws = await import("/src/plugins/aws/state.ts");
        aws.setAwsProfile("acme-prod");
        aws.setAwsService("ecs");
        aws.setEcsLevel("acme-prod", {
          kind: "service",
          cluster: "prod",
          service: "api-gateway",
          tab: "logs",
        });
        aws.openAwsSession();
      }),
    crops: { stage: ".stage" },
  },
  {
    name: "aws-billing",
    settle: 1500,
    setup: (page) =>
      run(page, async () => {
        const aws = await import("/src/plugins/aws/state.ts");
        aws.setAwsProfile("acme-prod");
        aws.setAwsService("billing");
        aws.openAwsSession();
      }),
    crops: { stage: ".stage" },
  },
  {
    name: "bruno",
    settle: 1500,
    setup: async (page) => {
      await run(page, async () => {
        const bruno = await import("/src/plugins/bruno/state.ts");
        const collection = "/Users/edon/api/acme-store";
        bruno.brunoSettings.update((settings) => ({
          ...settings,
          selectedEnvs: { [collection]: "production" },
        }));
        bruno.openBrunoSession(collection);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const state = showcase.store.getState();
        const paneId =
          state.windows[state.sessions[state.activeSessionId].activeWindowId]
            .activePaneId;
        for (const request of [
          "catalog/search.bru",
          "users/me.bru",
          "checkout/create.bru",
        ]) {
          bruno.brunoSelectRequest(paneId, `${collection}/${request}`);
        }
      });
      await page.waitForTimeout(500);
      await page.keyboard.press("Meta+Enter");
      await page.getByRole("button", { name: "Trust collection" }).click();
      await page.locator(".bruno-tab", { hasText: /^body/i }).first().click();
    },
    crops: { stage: ".stage" },
  },
  {
    name: "projects-rail",
    setup: (page) => openWindow(page, "s-sikemux", "w-agent-rail"),
    crops: { rail: ".side-rail" },
  },
];
