import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { Fault, instanceID } from './common.mjs';

const execute = promisify(execFile);
// IANA special-use ranges plus Azure's platform virtual address. IPv6 is denied entirely.
export const blockedIPv4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3', '168.63.129.16/32'];
function cidr(value) {
  const parts = value.split('/');
  if (!isIPv4(parts[0]) || parts.length > 2 || (parts.length === 2 && !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1]))) throw new Error('invalid egress IPv4 range');
  return parts.length === 1 ? `${value}/32` : value;
}
function contains(range, value) {
  const [address, bits] = range.split('/'), number = ip => ip.split('.').reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return ((number(address) & mask) >>> 0) === ((number(value) & mask) >>> 0);
}

export class Egress {
  constructor({ namespace, store, dns = ['1.1.1.1', '9.9.9.9'], denyIPv4 = [], binary = '/usr/sbin/nft' }) {
    instanceID(namespace);
    this.namespace = namespace; this.store = store; this.binary = binary;
    this.denied = [...new Set([...blockedIPv4, ...denyIPv4.map(cidr)])];
    if (!dns.length || dns.length > 3 || dns.some(ip => !isIPv4(ip) || this.denied.some(range => contains(range, ip)))) throw new Error('egress DNS must use public IPv4 resolvers');
    this.dns = [...new Set(dns)]; this.table = `dbc_${namespace.replaceAll('-', '')}`;
    this.owner = `donebot-cloud:${namespace}`;
    store.db.exec('CREATE TABLE IF NOT EXISTS egress_instances(id TEXT PRIMARY KEY)');
    this.queue = Promise.resolve();
  }
  bridge(id) { instanceID(id); return 'dbc' + createHash('sha256').update(`${this.namespace}:${id}`).digest('hex').slice(0, 12); }
  async nft(args, input) {
    try {
      const result = execute(this.binary, args, { timeout: 10000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
      if (input !== undefined) { result.child.stdin.on('error', () => {}); result.child.stdin.end(input); }
      await result;
    } catch { throw new Fault(503, 'egress_firewall_failed'); }
  }
  rules(bridges) {
    return `table inet ${this.table} {
      comment "${this.owner}"
      set bridges { type ifname; ${bridges.length ? `elements = { ${bridges.map(b => `"${b}"`).join(', ')} };` : ''} }
      set denied { type ipv4_addr; flags interval; auto-merge; elements = { ${this.denied.join(', ')} }; }
      set dns { type ipv4_addr; elements = { ${this.dns.join(', ')} }; }
      chain input { type filter hook input priority -10; policy accept; iifname @bridges counter drop; }
      chain output { type filter hook output priority -10; policy accept; oifname @bridges counter drop; }
      chain forward { type filter hook forward priority -10; policy accept;
        iifname @bridges jump outbound;
        oifname @bridges ct state established,related counter accept;
        oifname @bridges counter drop;
      }
      chain outbound {
        ct state invalid counter drop;
        meta nfproto ipv6 counter drop;
        fib daddr type local counter drop;
        ip daddr @denied counter drop;
        oifname @bridges counter drop;
        ip daddr @dns udp dport 53 counter accept;
        ip daddr @dns tcp dport 53 counter accept;
        tcp dport { 80, 443 } counter accept;
        counter drop;
      }
    }`;
  }
  update(id, present) {
    instanceID(id);
    const work = this.queue.catch(() => {}).then(async () => {
      if (present) this.store.run('INSERT OR IGNORE INTO egress_instances VALUES(?)', id);
      else this.store.run('DELETE FROM egress_instances WHERE id=?', id);
      const bridges = this.store.all('SELECT id FROM egress_instances ORDER BY id').map(row => this.bridge(row.id));
      // Refuse to interpret permission/command failures as an absent table.
      let exists;
      try {
        const value = await execute(this.binary, ['-j', 'list', 'tables'], { timeout: 10000, maxBuffer: 1024 * 1024 });
        const table = JSON.parse(value.stdout).nftables.find(item => item.table?.family === 'inet' && item.table.name === this.table)?.table;
        if (table && table.comment !== this.owner) throw new Error('firewall ownership mismatch');
        exists = !!table;
      } catch { throw new Fault(503, 'egress_firewall_failed'); }
      // A single nft transaction: no interval with missing rules during updates.
      await this.nft(['-f', '-'], `${exists ? `delete table inet ${this.table}\n` : ''}${bridges.length ? this.rules(bridges) : ''}\n`);
    });
    this.queue = work; return work;
  }
}
