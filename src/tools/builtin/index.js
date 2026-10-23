import { createReadTool } from "./read.js";
import { createLsTool } from "./ls.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createShellTool } from "./shell.js";
import { createTestTool } from "./test.js";
import { createGitTool } from "./git.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createMemoryTool } from "./memory.js";
import { createTaskTool } from "./task.js";
import { createAskUserTool } from "./ask-user.js";
import { createDeferredEditTools } from "./edit-deferred.js";

export function createBuiltinTools(options = {}) {
  return [
    createReadTool(),
    createLsTool(),
    createGrepTool(),
    createGlobTool(),
    createShellTool(),
    createTestTool(),
    createGitTool(),
    createWebFetchTool(options.webFetch || {}),
    createMemoryTool(),
    createTaskTool(options.task || {
      delegationService: options.taskDelegationService || null,
      getDelegationService: options.getTaskDelegationService || null
    }),
    createAskUserTool(),
    ...createDeferredEditTools({ editService: options.editService || null })
  ];
}
