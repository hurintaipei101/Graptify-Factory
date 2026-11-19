const TERMINAL_DEPENDENCY_STATES = new Set(['READY', 'COMPLETE', 'DONE']);

function isPresent(value) {
  return value !== undefined && value !== null && value !== false && value !== '';
}

function hasReleaseGateB(issue) {
  const gateB = issue.gateB;
  return Boolean(
    gateB &&
      gateB.approved === true &&
      typeof gateB.candidateHash === 'string' &&
      gateB.candidateHash !== '' &&
      typeof issue.candidateHash === 'string' &&
      gateB.candidateHash === issue.candidateHash,
  );
}

function dependencyIsReady(dependency, issue) {
  if (typeof dependency === 'object' && dependency !== null) {
    return TERMINAL_DEPENDENCY_STATES.has(dependency.status);
  }
  return TERMINAL_DEPENDENCY_STATES.has(issue.dependencyStatus?.[dependency]);
}

function missingDependencies(issue) {
  if (!Array.isArray(issue.dependencies)) return ['malformed dependencies'];
  return issue.dependencies.filter((dependency) => !dependencyIsReady(dependency, issue));
}

function missingEvidence(issue) {
  const evidence = issue.evidence ?? {};
  if (!Array.isArray(issue.requiredEvidence)) return ['malformed required evidence'];
  return issue.requiredEvidence.filter((name) => evidence[name] !== true);
}

function decision(status, reasons, extras = {}) {
  return {
    status,
    gate: status === 'STOP' ? 'A' : null,
    automaticMergeAllowed: false,
    reasons,
    ...extras,
  };
}

/**
 * Deterministically evaluates a structured issue without performing I/O.
 * The caller supplies all dependency and evidence state; no state is inferred.
 */
export function evaluateIssue(issue) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    return decision('STOP', ['invalid structured issue input']);
  }

  const securityBoundary = issue.securityBoundary === true || issue.permissionBoundary === true;
  if (securityBoundary) {
    return decision('STOP', ['security or permission boundary requires Gate A']);
  }

  if (issue.failedRepairCycles !== undefined && !Number.isInteger(issue.failedRepairCycles)) {
    return decision('STOP', ['malformed failed repair cycle count requires Gate A']);
  }

  const failedRepairCycles = Number.isInteger(issue.failedRepairCycles)
    ? issue.failedRepairCycles
    : 0;
  if (failedRepairCycles >= 3) {
    return decision('STOP', ['three failed repair cycles require Gate A']);
  }

  if (issue.environment === 'production' && !hasReleaseGateB(issue)) {
    return decision('STOP', ['Production requires release-specific Gate B approval']);
  }

  const missing = missingDependencies(issue);
  if (missing.length > 0) {
    return decision('BLOCKED', [`missing dependencies: ${missing.map(String).join(', ')}`]);
  }

  const evidenceMissing = missingEvidence(issue);
  if (evidenceMissing.length > 0) {
    return decision('BLOCKED', [`missing required evidence: ${evidenceMissing.join(', ')}`]);
  }

  const checksVerified = issue.githubChecksOperationallyVerified === true;
  const mergeRequested = issue.autoMergeRequested === true;
  if (mergeRequested && !checksVerified) {
    return decision('BLOCKED', ['required GitHub checks are not operationally verified'], {
      automaticMergeAllowed: false,
    });
  }

  return decision('READY', ['dependencies and required evidence verified'], {
    automaticMergeAllowed: mergeRequested && checksVerified,
  });
}

export const STATES = Object.freeze({ READY: 'READY', BLOCKED: 'BLOCKED', STOP: 'STOP' });
