// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ResumeSessionPicker } from "./ResumeSessionPicker";

const mocks = vi.hoisted(() => ({ attach: vi.fn(), navigate: vi.fn(), waitForThread: vi.fn() }));
vi.mock("../state/agentSessions", () => ({
  agentSessionList: () => null,
  agentSessionAttach: "attach",
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.attach }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("./ChatView.logic", () => ({
  waitForStartedServerThread: (...args: unknown[]) => mocks.waitForThread(...args),
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { sessions: [session], truncated: false },
    isPending: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
const session = {
  provider: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  sessionId: "5c119ee3-f063-4999-87ce-a062d004c37c",
  title: "External worktree task",
  cwd: "/repo-worktrees/feature",
  branch: "feature",
  updatedAt: "2026-10-01T00:00:00Z",
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.attach.mockResolvedValue({ _tag: "Success", value: { threadId: "imported-thread" } });
  mocks.navigate.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function selectSession() {
  await act(async () => {
    root.render(
      <ResumeSessionPicker
        projectRef={{
          environmentId: EnvironmentId.make("remote"),
          projectId: ProjectId.make("project"),
        }}
      />,
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="Resume a session"]')!.click();
  });
  const option = document.querySelector<HTMLElement>('[role="option"]');
  expect(option?.textContent).toContain("External worktree task");
  await act(async () => option!.click());
}

it("keeps the picker busy until the imported thread arrives in the shell stream", async () => {
  let finish!: (value: boolean) => void;
  mocks.waitForThread.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await selectSession();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Opening session…");
  await act(async () => finish(true));
  expect(mocks.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      params: { environmentId: "remote", threadId: "imported-thread" },
    }),
  );
});

it("leaves an actionable error instead of navigating when the thread stream times out", async () => {
  mocks.waitForThread.mockResolvedValue(false);
  await selectSession();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Open it from the thread list.");
});
