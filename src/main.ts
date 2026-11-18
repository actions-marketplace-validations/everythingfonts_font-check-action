import * as core from '@actions/core';

export function readInputs() {
  return {
    apiKey: core.getInput('api-key', { required: true }),
    paths: core.getInput('paths'),
    changedOnly: core.getInput('changed-only'),
    failBelow: core.getInput('fail-below'),
    failOn: core.getInput('fail-on') || 'error',
    comment: core.getInput('comment'),
    failOnQuota: core.getBooleanInput('fail-on-quota'),
    apiUrl: core.getInput('api-url'),
    timeoutMinutes: Number(core.getInput('timeout-minutes') || '10'),
  };
}

async function run(): Promise<void> {
  const inputs = readInputs();
  core.setSecret(inputs.apiKey);
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
