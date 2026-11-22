import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fault } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TEAM_SECCOMP_PATH = resolve(HERE, '../deploy/security/team-seccomp.json');
export const DEFAULT_TEAM_APPARMOR_PROFILE = 'donebot-team-container';

const REQUIRED_BWRAP_SYSCALLS = ['clone', 'unshare', 'mount', 'umount2', 'pivot_root', 'sethostname'];
const FORBIDDEN_UNCONDITIONAL_SYSCALLS = new Set([
  'bpf', 'ptrace', 'process_vm_readv', 'process_vm_writev', 'kexec_load', 'kexec_file_load', 'init_module', 'finit_module', 'delete_module',
  'io_uring_setup', 'io_uring_enter', 'io_uring_register', 'open_by_handle_at', 'perf_event_open',
  'userfaultfd', 'reboot', 'swapon', 'swapoff', 'chroot', 'setns', 'add_key', 'request_key', 'keyctl',
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function validateTeamSeccompDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Fault(400, 'invalid_team_seccomp');
  if (value.defaultAction !== 'SCMP_ACT_ERRNO') throw new Fault(400, 'invalid_team_seccomp');
  if (!Array.isArray(value.syscalls) || value.syscalls.length === 0) throw new Fault(400, 'invalid_team_seccomp');
  const unconditionalAllow = new Set();
  for (const rule of value.syscalls) {
    if (!rule || typeof rule !== 'object' || !Array.isArray(rule.names)) throw new Fault(400, 'invalid_team_seccomp');
    if (rule.action !== 'SCMP_ACT_ALLOW') continue;
    const restricted = Boolean(rule.includes?.caps?.length || rule.args?.length);
    if (!restricted) {
      for (const name of rule.names) {
        if (FORBIDDEN_UNCONDITIONAL_SYSCALLS.has(name)) throw new Fault(400, 'forbidden_team_seccomp_syscall');
        unconditionalAllow.add(name);
      }
    }
  }
  for (const needed of REQUIRED_BWRAP_SYSCALLS) {
    if (!unconditionalAllow.has(needed)) throw new Fault(400, 'incomplete_team_seccomp');
  }
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function loadTeamSeccomp(seccompPath = DEFAULT_TEAM_SECCOMP_PATH) {
  if (typeof seccompPath !== 'string' || !seccompPath || seccompPath === 'unconfined' || !isAbsolute(seccompPath)) {
    throw new Fault(400, 'invalid_team_seccomp_path');
  }
  const stat = lstatSync(seccompPath);
  if (!stat.isFile() || stat.size > 512 * 1024) throw new Fault(400, 'invalid_team_seccomp_path');
  let parsed;
  try { parsed = JSON.parse(readFileSync(seccompPath, 'utf8')); }
  catch { throw new Fault(400, 'invalid_team_seccomp'); }
  const digest = validateTeamSeccompDocument(parsed);
  return { path: seccompPath, digest };
}

export function validateAppArmorProfileName(name = DEFAULT_TEAM_APPARMOR_PROFILE) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name) || name === 'unconfined' || name === 'docker-default') {
    throw new Fault(400, 'invalid_team_apparmor_profile');
  }
  return name;
}

export function hostAppArmorState(profile = DEFAULT_TEAM_APPARMOR_PROFILE) {
  const cleanProfile = validateAppArmorProfileName(profile);
  if (process.platform !== 'linux') return { enabled: false, profileLoaded: false, profile: cleanProfile };
  const enabledPath = '/sys/module/apparmor/parameters/enabled';
  if (!existsSync(enabledPath)) return { enabled: false, profileLoaded: false, profile: cleanProfile };
  let enabled = false;
  try { enabled = readFileSync(enabledPath, 'utf8').trim() === 'Y'; } catch { return { enabled: false, profileLoaded: false, profile: cleanProfile }; }
  if (!enabled) return { enabled: false, profileLoaded: false, profile: cleanProfile };
  try {
    const profiles = readFileSync('/sys/kernel/security/apparmor/profiles', 'utf8').split('\n');
    const loaded = profiles.some(line => line.trim() === `${cleanProfile} (enforce)`);
    return { enabled: true, profileLoaded: loaded, profile: cleanProfile };
  } catch {
    return { enabled: true, profileLoaded: false, profile: cleanProfile };
  }
}

export function teamSecurityArgs(config) {
  const args = ['--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${config.seccomp.path}`];
  if (config.appArmor.enabled) {
    if (!config.appArmor.profileLoaded) throw new Fault(503, 'team_apparmor_profile_missing');
    args.push('--security-opt', `apparmor=${config.appArmor.profile}`);
  }
  return args;
}

export function checkContainerSecurityOpts(securityOpt, teamConfig) {
  const opts = Array.isArray(securityOpt) ? securityOpt : [];
  if (!opts.includes('no-new-privileges') && !opts.includes('no-new-privileges:true')) return false;
  if (opts.some(opt => /(?:^|:|=)unconfined$/i.test(opt))) return false;
  if (!teamConfig) {
    return !opts.some(opt => /^(?:seccomp|apparmor)[=:]/i.test(opt));
  }
  const seccompOpt = opts.find(opt => /^seccomp[=:]/i.test(opt));
  if (!seccompOpt) return false;
  const seccompVal = seccompOpt.slice('seccomp='.length);
  if (seccompVal !== teamConfig.seccomp.path) {
    try {
      const digest = validateTeamSeccompDocument(JSON.parse(seccompVal));
      if (digest !== teamConfig.seccomp.digest) return false;
    } catch {
      return false;
    }
  }
  const apparmorOpt = opts.find(opt => /^apparmor[=:]/i.test(opt));
  if (teamConfig.appArmor.enabled) {
    if (!apparmorOpt || apparmorOpt.slice('apparmor='.length) !== teamConfig.appArmor.profile) return false;
  } else if (apparmorOpt) {
    return false;
  }
  return true;
}

export function resolveTeamSecurityConfig({ teamsEnabled, seccompPath, appArmorProfile, readAppArmor = hostAppArmorState }) {
  if (!teamsEnabled) return null;
  const seccomp = loadTeamSeccomp(seccompPath || DEFAULT_TEAM_SECCOMP_PATH);
  const profile = validateAppArmorProfileName(appArmorProfile || DEFAULT_TEAM_APPARMOR_PROFILE);
  return { seccomp, profile, readAppArmor };
}
