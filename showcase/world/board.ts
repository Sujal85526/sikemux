import type { BoardCard, ProjectBoard } from "../../src/agents/agentBoard";
import { SIKEMUX } from "./projects";
import { AGENTS } from "./workspace";

const OTTER = AGENTS.rail;
const MAPLE = AGENTS.replay;
const HOUR = 3_600_000;
const now = Date.now();

const card = (
  fields: Partial<BoardCard> & Pick<BoardCard, "id" | "title" | "status">,
): BoardCard => ({
  details: "",
  owner: null,
  ownerName: null,
  ownerCli: null,
  team: OTTER.id,
  teamName: OTTER.name,
  parent: null,
  dependsOn: [],
  waitsOn: [],
  createdBy: OTTER.id,
  createdByName: OTTER.name,
  result: null,
  ticket: null,
  at: now - 3 * HOUR,
  updatedAt: now - fields.id * 600_000,
  ...fields,
});

const otter = { owner: OTTER.id, ownerName: OTTER.name, ownerCli: OTTER.type };
const maple = { owner: MAPLE.id, ownerName: MAPLE.name, ownerCli: MAPLE.type };
const person = {
  team: null,
  teamName: null,
  createdBy: null,
  createdByName: "the person",
};

/** The sikemux project's board: Otter's team splitting a ticket, and tickets nobody has taken yet. */
export const DEMO_BOARD: ProjectBoard = {
  project: SIKEMUX,
  cards: [
    card({
      id: 1,
      title: "Store amounts in cents across billing",
      status: "progress",
      ...otter,
      createdBy: null,
      createdByName: "the person",
      ticket: { key: "PROJ-12", source: "Story", provider: "jira" },
    }),
    card({
      id: 2,
      title: "Migration for the amounts table",
      status: "done",
      parent: 1,
      owner: "agent-flint",
      ownerName: "Flint",
      ownerCli: "codex",
      result: "Added migration 0042 and a backfill for old rows.",
    }),
    card({
      id: 3,
      title: "Ledger import onto amounts",
      status: "progress",
      parent: 1,
      dependsOn: [2],
      ...maple,
    }),
    card({
      id: 4,
      title: "Date formatting in reports",
      status: "progress",
      parent: 1,
      owner: "agent-comet",
      ownerName: "Comet",
      ownerCli: "claude",
    }),
    card({
      id: 5,
      title: "Export CSV of a month's invoices",
      status: "open",
      ...person,
      ticket: { key: "PROJ-19", source: "Story", provider: "jira" },
    }),
    card({
      id: 6,
      title: "Totals are off by a cent on refunds",
      status: "open",
      ...person,
      dependsOn: [3],
      waitsOn: [3],
      ticket: { key: "PROJ-23", source: "Bug", provider: "jira" },
    }),
  ],
};
