/**
 * Minimal reactive behavior tree. Nodes are stateless and shared by every
 * agent (the agent is the blackboard), so forty bots cost one tree instance.
 * The tree is re-evaluated from the root on each think tick, which makes
 * higher-priority branches pre-empt lower ones automatically.
 */

export const Status = Object.freeze({ FAILURE: 0, SUCCESS: 1, RUNNING: 2 });

/**
 * @template A
 * @typedef {{ tick: (agent: A) => number }} BTNode
 */

/**
 * Runs children in order until one does not fail.
 * @template A @param {...BTNode<A>} children @returns {BTNode<A>}
 */
export function selector(...children) {
  return {
    tick(agent) {
      for (let i = 0; i < children.length; i++) {
        const s = children[i].tick(agent);
        if (s !== Status.FAILURE) return s;
      }
      return Status.FAILURE;
    },
  };
}

/**
 * Runs children in order until one does not succeed.
 * @template A @param {...BTNode<A>} children @returns {BTNode<A>}
 */
export function sequence(...children) {
  return {
    tick(agent) {
      for (let i = 0; i < children.length; i++) {
        const s = children[i].tick(agent);
        if (s !== Status.SUCCESS) return s;
      }
      return Status.SUCCESS;
    },
  };
}

/**
 * @template A @param {(agent: A) => boolean} test @returns {BTNode<A>}
 */
export function condition(test) {
  return { tick: (agent) => (test(agent) ? Status.SUCCESS : Status.FAILURE) };
}

/**
 * Leaf that labels the agent's current state (for debugging / HUD) and runs.
 * @template {{state: string}} A
 * @param {string} name
 * @param {(agent: A) => number|void} run  returning nothing counts as RUNNING
 * @returns {BTNode<A>}
 */
export function action(name, run) {
  return {
    tick(agent) {
      const s = run(agent);
      const status = s === undefined ? Status.RUNNING : s;
      if (status !== Status.FAILURE) agent.state = name;
      return status;
    },
  };
}
