// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProviderInstanceId, ProjectId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SessionReferenceLookup } from "./SessionReferenceLookup";

vi.mock("./ChatView.logic", () => ({
  waitForStartedServerThread: (...args: unknown[]) => mocks.waitForThread(...args),
}));

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  attach: vi.fn(),
  navigate: vi.fn(),
  waitForThread: vi.fn(),
}));
vi.mock("../state/agentSessions", () => ({
  agentSessionLookup: "lookup",
  agentSessionAttach: "attach",
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.lookup }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.attach }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "local", label: "Laptop", connection: { phase: "connected" } },
      { environmentId: "remote", label: "Workstation", connection: { phase: "connected" } },
      { environmentId: "offline", label: "Offline", connection: { phase: "disconnected" } },
    ],
  }),
}));
const id = "5c119ee3-f063-4999-87ce-a062d004c37c";
const match = {
  session: {
    provider: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    sessionId: id,
    cwd: "/remote/repo",
    title: "Remote task",
    branch: "feature",
    updatedAt: "2026-09-30T00:00:00Z",
  },
  project: {
    path: "/remote/repo",
    title: "Repo",
    projectId: ProjectId.make("remote-project"),
    alreadyImported: true,
    sources: ["codex"],
    threadCount: 1,
    lastActiveAt: null,
  },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.lookup.mockImplementation(async ({ environmentId }) => ({
    _tag: "Success",
    value: { matches: environmentId === "remote" ? [match] : [], truncated: false },
  }));
  mocks.attach.mockResolvedValue({ _tag: "Success", value: { threadId: "imported-thread" } });
  mocks.navigate.mockResolvedValue(undefined);
  mocks.waitForThread.mockResolvedValue(true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("searches the chosen server first and attaches a remote match on its owning server", async () => {
  const onDone = vi.fn();
  await act(async () =>
    root.render(
      <SessionReferenceLookup
        input={{ sessionId: id }}
        environmentId={EnvironmentId.make("local")}
        onDone={onDone}
      />,
    ),
  );
  expect(mocks.lookup).not.toHaveBeenCalled();
  await click("Find session");
  expect(mocks.lookup.mock.calls.map(([target]) => target.environmentId)).toEqual(["local"]);
  await click("Search connected environments");
  expect(mocks.lookup.mock.calls.map(([target]) => target.environmentId)).toEqual([
    "local",
    "local",
    "remote",
  ]);
  expect(container.textContent).toContain("Workstation");
  await click("Resume");
  expect(mocks.attach).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { projectId: "remote-project", providerInstanceId: "codex", sessionId: id },
  });
  expect(mocks.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({ environmentId: "remote", threadId: "imported-thread" }),
    }),
  );
  expect(onDone).toHaveBeenCalledOnce();
});
it("ignores a lookup that finishes after another reference was pasted", async () => {
  let finish!: (value: unknown) => void;
  mocks.lookup.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <SessionReferenceLookup
        input={{ sessionId: id }}
        environmentId={EnvironmentId.make("local")}
        onDone={() => {}}
      />,
    ),
  );
  await click("Find session");
  await act(async () =>
    root.render(
      <SessionReferenceLookup
        input={{ sessionId: "different-id" }}
        environmentId={EnvironmentId.make("local")}
        onDone={() => {}}
      />,
    ),
  );
  await act(async () => finish({ _tag: "Success", value: { matches: [match], truncated: false } }));
  expect(container.textContent).not.toContain("Remote task");
  expect(container.textContent).toContain("Find session");
});
it("keeps successful matches when another connected environment fails", async () => {
  await act(async () =>
    root.render(
      <SessionReferenceLookup
        input={{ sessionId: id }}
        environmentId={EnvironmentId.make("local")}
        onDone={() => {}}
      />,
    ),
  );
  await click("Find session");
  mocks.lookup.mockImplementation(async ({ environmentId }) => {
    if (environmentId === "local") throw new Error("Disconnected");
    return { _tag: "Success", value: { matches: [match], truncated: false } };
  });
  await click("Search connected environments");
  expect(container.textContent).toContain("Laptop: Disconnected");
  expect(container.textContent).toContain("Remote task");
});

it("waits for imported history before navigating to the thread", async () => {
  let finish!: (value: boolean) => void;
  mocks.lookup.mockResolvedValue({
    _tag: "Success",
    value: { matches: [match], truncated: false },
  });
  mocks.waitForThread.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const onDone = vi.fn();
  await act(async () =>
    root.render(
      <SessionReferenceLookup
        input={{ sessionId: id }}
        environmentId={EnvironmentId.make("local")}
        onDone={onDone}
      />,
    ),
  );
  await click("Find session");
  await click("Resume");
  expect(mocks.navigate).not.toHaveBeenCalled();
  await act(async () => finish(true));
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledOnce();
});

it("can find a session before any project has selected an environment", async () => {
  await act(async () =>
    root.render(
      <SessionReferenceLookup input={{ sessionId: id }} environmentId={null} onDone={() => {}} />,
    ),
  );
  expect(container.textContent).toContain("on Laptop");
  await click("Find session");
  expect(mocks.lookup).toHaveBeenCalledWith({ environmentId: "local", input: { sessionId: id } });
});
