import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudDesktops } from '../src/desktops.mjs';

test('desktop accepts Docker capability aliases but rejects any changed capability set', () => {
  const image = 'sha256:' + 'a'.repeat(64), volume = 'fixture-home', edge = '/fixture/desktop';
  const desktop = Object.create(CloudDesktops.prototype);
  Object.assign(desktop, { image, checkLabels() {}, names: () => ({ volume, edge }), password: () => 'synthetic' });
  const value = {
    Config: { Image: image, User: '0:0', Hostname: 'donebot-desktop', Entrypoint: ['/bin/sh'],
      Cmd: ['-c', `set -eu
mkdir -p /run/user/1000 /var/log/supervisor
chown 1000:1000 /run/user/1000
chmod 700 /run/user/1000
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf`], Env: ['VNC_PW=synthetic'] },
    HostConfig: { ExtraHosts: ['donebot-desktop:127.0.0.1'], ShmSize: 536870912,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777', '/run': 'rw,nosuid,nodev,size=16m,mode=755', '/var/log': 'rw,nosuid,nodev,size=64m,mode=755' },
      ReadonlyRootfs: true, Privileged: false, Memory: 2147483648, MemorySwap: 2147483648, NanoCpus: 1e9, PidsLimit: 512,
      CapDrop: ['ALL'], CapAdd: ['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_FOWNER', 'CAP_SETGID', 'CAP_SETUID'],
      SecurityOpt: ['no-new-privileges'], NetworkMode: 'none', PortBindings: {}, RestartPolicy: { Name: 'no' }, PidMode: '', IpcMode: 'private', CgroupnsMode: 'private' },
    Mounts: [{ Type: 'volume', Name: volume, Destination: '/home/cua', RW: true }, { Type: 'bind', Source: edge, Destination: '/run/donebot-desktop', RW: true }],
    NetworkSettings: { Networks: { none: {} } },
  };
  const capabilities = value.HostConfig.CapAdd;
  assert.doesNotThrow(() => desktop.check(value, 'fixture'));
  value.HostConfig.CapAdd = capabilities.map(cap => cap.slice(4));
  assert.doesNotThrow(() => desktop.check(value, 'fixture'));
  for (const changed of [[...capabilities, 'CAP_NET_ADMIN'], capabilities.slice(1), [...capabilities, capabilities[0]], ['CAP_ALL'], []]) {
    value.HostConfig.CapAdd = changed;
    assert.throws(() => desktop.check(value, 'fixture'), { code: 'desktop_resource_spec_mismatch' });
  }
});
