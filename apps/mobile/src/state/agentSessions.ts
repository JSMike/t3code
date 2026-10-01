import { createAgentSessionResumeAtoms } from "@t3tools/client-runtime/state/agentSessions";
import { connectionAtomRuntime } from "../connection/runtime";

export const {
  lookup: agentSessionLookup,
  attach: agentSessionAttach,
  list: agentSessionList,
} = createAgentSessionResumeAtoms(connectionAtomRuntime);
