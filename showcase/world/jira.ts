type Params = Record<string, unknown>;

const SITE = "acme-labs.atlassian.net";

const iso = (hoursAgo: number) =>
  new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

const person = (accountId: string, name: string) => ({
  accountId,
  name,
  avatarUrl: null,
});

const EDON = person("u-edon", "Edon Ramos");
const MAYA = person("u-maya", "Maya Chen");
const SAM = person("u-sam", "Sam Okafor");
const PRIYA = person("u-priya", "Priya Nair");
const LENA = person("u-lena", "Lena Fischer");
const JONAS = person("u-jonas", "Jonas Weber");
const THEO = person("u-theo", "Theo Laurent");
const ANA = person("u-ana", "Ana Silva");
const PEOPLE = [EDON, MAYA, SAM, PRIYA, LENA, JONAS, THEO, ANA];

const COLUMNS = [
  { name: "To Do", category: "new", statusIds: ["1"] },
  { name: "In Progress", category: "indeterminate", statusIds: ["3"] },
  { name: "In Review", category: "indeterminate", statusIds: ["4"] },
  { name: "Done", category: "done", statusIds: ["5"] },
  { name: "Deployed", category: "done", statusIds: ["6"] },
] as const;

const SPRINT = "Orbit Sprint 24";

type Row = [
  number,
  string,
  number,
  string,
  string,
  (typeof PEOPLE)[number] | null,
  number,
];

const ROWS: Row[] = [
  [
    212,
    "Offline mode keeps the last synced itinerary readable without a connection",
    0,
    "Story",
    "High",
    EDON,
    30,
  ],
  [
    218,
    "Trip sharing link expires after seven days instead of thirty",
    0,
    "Bug",
    "Medium",
    MAYA,
    52,
  ],
  [
    224,
    "Currency picker remembers the last choice per traveller",
    0,
    "Task",
    "Low",
    null,
    70,
  ],
  [
    227,
    "Seat map loads in under a second on a cold start",
    0,
    "Story",
    "Highest",
    SAM,
    8,
  ],
  [
    205,
    "Checkout asks for the passport number only for international legs",
    1,
    "Story",
    "High",
    EDON,
    3,
  ],
  [
    209,
    "Price alerts batch into one push a day per route",
    1,
    "Task",
    "Medium",
    THEO,
    11,
  ],
  [
    215,
    "Calendar export writes the right time zone for overnight flights",
    1,
    "Bug",
    "High",
    LENA,
    19,
  ],
  [
    198,
    "Booking history paginates by month on the account page",
    2,
    "Story",
    "Medium",
    JONAS,
    6,
  ],
  [
    201,
    "Retry the payment webhook with backoff when the bank times out",
    2,
    "Task",
    "High",
    EDON,
    14,
  ],
  [
    184,
    "Search results show the baggage allowance on each fare",
    3,
    "Story",
    "Medium",
    MAYA,
    40,
  ],
  [
    190,
    "Duplicate traveller profiles merge on sign in",
    3,
    "Bug",
    "Low",
    SAM,
    60,
  ],
  [
    176,
    "Itinerary emails render the map at retina size",
    4,
    "Task",
    "Lowest",
    ANA,
    90,
  ],
  [
    179,
    "Gift cards apply before taxes on mixed carts",
    4,
    "Bug",
    "Medium",
    null,
    120,
  ],
];

const issue = ([
  number,
  summary,
  column,
  issueType,
  priority,
  assignee,
  hours,
]: Row) => {
  const status = COLUMNS[column]!;
  const key = `ORB-${number}`;
  return {
    key,
    summary,
    status: status.name,
    statusCategory: status.category,
    priority,
    assignee,
    issueType,
    sprint: SPRINT,
    updated: iso(hours),
    url: `https://${SITE}/browse/${key}`,
    column,
  };
};

const ISSUES = ROWS.map(issue);

const byPeople = (params: Params) => {
  const people = (params.people as string[] | undefined) ?? [];
  const mine = params.mine === true;
  const unassigned = params.unassigned === true;
  if (!people.length && !mine && !unassigned) return ISSUES;
  return ISSUES.filter(
    (each) =>
      (mine && each.assignee?.accountId === EDON.accountId) ||
      (unassigned && !each.assignee) ||
      (each.assignee && people.includes(each.assignee.accountId)),
  );
};

const search = ({ jql }: Params) => {
  const text = String(jql ?? "");
  const words = /text ~ "([^"]*)"/.exec(text)?.[1]?.toLowerCase();
  let found = ISSUES;
  if (words)
    found = ISSUES.filter((each) => each.summary.toLowerCase().includes(words));
  else if (/assignee = currentUser\(\)/.test(text))
    found = ISSUES.filter((each) => each.assignee === EDON);
  else if (/assignee is EMPTY/.test(text))
    found = ISSUES.filter((each) => !each.assignee && each.column < 3);
  else if (/statusCategory != Done/.test(text))
    found = ISSUES.filter((each) => each.column < 3);
  return {
    issues: [...found].sort(
      (a, b) => Date.parse(b.updated) - Date.parse(a.updated),
    ),
    next: null,
  };
};

const DESCRIPTION = `Travellers on a train or a plane open the app to check their gate and find a spinner. The itinerary they synced an hour ago should still be there.

### What done looks like

- [x] The last synced itinerary is kept on the device
- [ ] It opens without a connection, marked with when it was synced
- [ ] Boarding passes open offline too

Tickets and seats are read only while offline; changing a booking still needs a connection.`;

const COMMENTS = [
  {
    id: "c1",
    author: "Maya Chen",
    created: iso(28),
    body: "The boarding pass needs the barcode cached as an image, not the payload. The airline SDK will not render offline.",
  },
  {
    id: "c2",
    author: "Edon Ramos",
    created: iso(6),
    body: "Agreed. I will store the rendered pass beside the itinerary and drop both when the trip ends.",
  },
];

const full = (key: string) => {
  const found = ISSUES.find((each) => each.key === key) ?? ISSUES[0]!;
  const position = ISSUES.indexOf(found);
  return {
    ...found,
    project: "Orbit",
    reporter: PEOPLE[(position + 1) % PEOPLE.length],
    labels: position % 2 === 0 ? ["mobile", "offline"] : ["web"],
    created: iso(24 * 9),
    description:
      position === 0
        ? DESCRIPTION
        : `${found.summary}.\n\nSteps and acceptance are in the linked design.`,
    comments: position === 0 ? COMMENTS : COMMENTS.slice(0, 1),
    commentCount: position === 0 ? 4 : 1,
    transitions: COLUMNS.filter((_, index) => index !== found.column).map(
      (column, index) => ({
        id: String(index + 11),
        name: `Move to ${column.name}`,
        to: column.name,
      }),
    ),
    subtasks: [],
    blockedBy: [],
    blocks: [],
  };
};

export const JIRA: Record<string, (params: Params) => unknown> = {
  status: () => ({
    configured: true,
    sites: [{ host: SITE, displayName: "Acme Labs", default: true }],
    ok: true,
    authFailed: false,
    message: null,
    browserSignIn: true,
  }),
  filters: () => [
    {
      id: "10021",
      name: "Bugs this sprint",
      jql: `type = Bug AND sprint in openSprints()`,
    },
    { id: "10022", name: "Waiting on review", jql: `status = "In Review"` },
  ],
  projects: () => [
    { key: "ORB", name: "Orbit" },
    { key: "PAY", name: "Payments" },
  ],
  boards: () => [
    { id: 7, name: "Orbit board", kind: "scrum", project: "ORB" },
    { id: 9, name: "Payments kanban", kind: "kanban", project: "PAY" },
  ],
  board: (params) => {
    const shown = byPeople(params);
    return {
      id: Number(params.id ?? 7),
      name: "Orbit board",
      kind: "scrum",
      sprint: {
        id: 24,
        name: SPRINT,
        end: new Date(Date.now() + 4 * 86_400_000).toISOString(),
        goal: "Offline itineraries ship to every traveller on iOS and Android.",
      },
      columns: COLUMNS.map((column, index) => ({
        name: column.name,
        statusIds: [...column.statusIds],
        issues: shown.filter((each) => each.column === index),
      })),
      truncated: false,
    };
  },
  search,
  issue: ({ key }) => full(String(key)),
  assignable: () => PEOPLE,
  keys: () => [],
  image: () => "",
  moveIssue: () => null,
  transition: () => ({ status: null, transitions: [] }),
  assign: () => null,
  comment: ({ body }) => ({
    id: "c9",
    author: "Edon Ramos",
    created: iso(0),
    body,
  }),
};
