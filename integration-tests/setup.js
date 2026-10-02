const { MetadataStorage } = require("@medusajs/framework/mikro-orm/core")
const { WorkflowManager } = require("@medusajs/framework/orchestration")

MetadataStorage.clear()

// Specs compose each workflow from the TS source and the test app composes it again from the
// build. On the second pass a step's `.config()` re-registers the flow built so far, which
// `register` then rejects as a different definition. Let the last composition win instead.
const register = WorkflowManager.register.bind(WorkflowManager)

WorkflowManager.register = function (workflowId, flow, ...rest) {
  if (flow && WorkflowManager.getWorkflow(workflowId)) {
    WorkflowManager.unregister(workflowId)
  }

  return register(workflowId, flow, ...rest)
}
