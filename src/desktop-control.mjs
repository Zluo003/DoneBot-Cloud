import { Fault } from './common.mjs';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export class DesktopControl {
  constructor(store) {
    this.store = store; this.seats = new Map(); this.resets = new Set();
    store.db.exec('CREATE TABLE IF NOT EXISTS desktop_control(id TEXT PRIMARY KEY, uncertain INTEGER NOT NULL)');
  }
  status(id) {
    return { occupied: this.seats.has(id), review_required: this.seats.get(id)?.uncertain === true || !this.seats.has(id) && !!this.store.get('SELECT uncertain FROM desktop_control WHERE id=?', id)?.uncertain };
  }
  enter(id, owner) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(owner)) throw new Fault(400, 'invalid_desktop_controller');
    if (this.resets.has(id)) throw new Fault(409, 'desktop_control_occupied');
    if (this.status(id).review_required) throw new Fault(409, 'desktop_interrupted_action_requires_review');
    let seat = this.seats.get(id);
    if (seat && seat.owner !== owner) throw new Fault(409, 'desktop_control_occupied');
    if (!seat) { seat = { owner, references: 0, pending: new Set(), uncertain: false }; this.seats.set(id, seat); }
    seat.references++;
    let released = false;
    return {
      begin: key => {
        if (released || seat.uncertain || this.resets.has(id) || this.seats.get(id) !== seat || seat.pending.has(key)) throw new Fault(409, 'desktop_control_lost');
        seat.pending.add(key);
        this.store.run('INSERT OR REPLACE INTO desktop_control VALUES(?,1)', id);
      },
      finish: key => {
        seat.pending.delete(key);
        if (!seat.uncertain && !seat.pending.size && this.seats.get(id) === seat) this.store.run('DELETE FROM desktop_control WHERE id=?', id);
      },
      interrupt: () => { if (seat.retired) return; seat.uncertain = true; this.store.run('INSERT OR REPLACE INTO desktop_control VALUES(?,1)', id); },
      release: () => {
        if (released) return; released = true;
        if (--seat.references === 0 && this.seats.get(id) === seat) this.seats.delete(id);
      },
    };
  }
  reset(id) {
    if (this.seats.has(id)) throw new Fault(409, 'desktop_control_occupied');
    this.store.run('DELETE FROM desktop_control WHERE id=?', id);
  }
  async stopAndReset(id, stop) {
    if (this.resets.has(id)) throw new Fault(409, 'desktop_control_occupied');
    this.resets.add(id);
    try {
      await stop();
      const seat = this.seats.get(id); if (seat) seat.retired = true;
      this.seats.delete(id); this.store.run('DELETE FROM desktop_control WHERE id=?', id);
    } finally { this.resets.delete(id); }
  }
}

export function desktopController(req) {
  return req.headers['x-donebot-desktop-controller'] ?? 'cloud-runtime';
}

export function trackDesktopMcp(lease, write) {
  const prefix = randomUUID(), pending = new Set(), decoder = new StringDecoder('utf8'), outputDecoder = new StringDecoder('utf8');
  let buffer = '', output = '', stopped = false;
  return {
    input(chunk) {
      if (stopped) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Fault(413, 'desktop_mcp_message_too_large');
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method === 'tools/call') {
          if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new Fault(400, 'desktop_mcp_id_required');
          const key = prefix + JSON.stringify(message.id);
          lease.begin(key); pending.add(key);
        }
        write(Buffer.from(line + '\n'));
      }
    },
    output(chunk) {
      output += outputDecoder.write(chunk);
      if (Buffer.byteLength(output) > 20 * 1024 * 1024) throw new Fault(413, 'desktop_mcp_message_too_large');
      for (;;) {
        const end = output.indexOf('\n'); if (end < 0) break;
        const line = output.slice(0, end); output = output.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (!('id' in message) || !('result' in message || 'error' in message)) continue;
        const key = prefix + JSON.stringify(message.id);
        if (pending.delete(key)) lease.finish(key);
      }
    },
    close() { stopped = true; if (pending.size) lease.interrupt(); lease.release(); },
  };
}
