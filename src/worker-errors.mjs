import { Fault } from './common.mjs';

const reasons = new Set([
  'API_KEY_NOT_FOUND', 'USER_NOT_FOUND', 'DONEBOT_DISABLED', 'DONEBOT_INSTALL_NOT_FOUND',
  'DONEBOT_INSTALL_CONFLICT', 'DONEBOT_INSTALL_INACTIVE', 'DONEBOT_GROUP_UNAVAILABLE', 'DONEBOT_USER_INACTIVE',
  'CLOUD_RUNTIME_UNAVAILABLE', 'CLOUD_RUNTIME_INACTIVE', 'CLOUD_RUNTIME_INVALID', 'CLOUD_RUNTIME_INTERNAL',
  'CLOUD_NODE_REQUIRED', 'CLOUD_COMMAND_EXPIRED', 'CLOUD_PURGE_CANCELLED', 'CLOUD_RENEWED', 'CLOUD_REPORT_INVALID',
]);
const steps = new Set([
  'node_auth', 'begin_transaction', 'authorize_runtime', 'credential_cipher', 'read_credential',
  'decrypt_credential', 'validate_installation', 'claim_installation', 'rotate_installation', 'persist_credential', 'commit',
]);
const localCodes = new Set([
  'master_unavailable', 'invalid_master_response', 'invalid_master_lease', 'master_http_not_found', 'master_request_failed',
  'runtime_operation_failed', 'runtime_lease_expired', 'invalid_runtime_lease', 'runtime_gateway_unsupported',
  'agent_timeout', 'agent_failed', 'agent_closing', 'instance_not_ready', 'docker_failed', 'docker_timeout',
  'docker_resource_missing', 'resource_ownership_mismatch', 'resource_spec_mismatch', 'network_spec_mismatch',
  'storage_spec_mismatch', 'storage_ownership_mismatch', 'storage_mount_ownership_mismatch', 'storage_mount_failed',
  'egress_firewall_failed', 'storage_setup_failed', 'host_storage_insufficient', 'runtime_health_timeout',
]);

export function masterFailure(res, result) {
  const reason = reasons.has(result?.reason) ? result.reason : undefined;
  const code = reason ? 'master_' + reason.toLowerCase() : res.status === 404 ? 'master_http_not_found' : 'master_request_failed';
  const failure = new Fault(res.ok ? 502 : res.status, code);
  failure.diagnostic = {};
  if (reason) failure.diagnostic.reason = reason;
  if (steps.has(result?.metadata?.step)) failure.diagnostic.step = result.metadata.step;
  const requestID = res.headers.get('x-request-id');
  if (/^[a-zA-Z0-9_-]{1,128}$/.test(requestID || '')) failure.diagnostic.request_id = requestID;
  return failure;
}

export function errorFields(error) {
  const code = localCodes.has(error?.code) || [...reasons].some(reason => error?.code === 'master_' + reason.toLowerCase()) ? error.code : 'runtime_operation_failed';
  const fields = { code };
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) fields.status = error.status;
  if (reasons.has(error?.diagnostic?.reason)) fields.reason = error.diagnostic.reason;
  if (steps.has(error?.diagnostic?.step)) fields.step = error.diagnostic.step;
  if (/^[a-zA-Z0-9_-]{1,128}$/.test(error?.diagnostic?.request_id || '')) fields.request_id = error.diagnostic.request_id;
  return fields;
}
