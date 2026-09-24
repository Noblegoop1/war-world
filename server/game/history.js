'use strict';
// World history: the story of the game, told on the game-over screen. Who allied with whom, who
// betrayed whom, who declared war and made peace, the first bomb each nation dropped on another, which
// nations fell and to whom, and (in Zombie mode) the outbreaks, the great waves and the cure.
// Recorded from the same events the clients get, once per packet, so nothing is counted twice.
// Mixed into Game.prototype.
const { PlayerType } = require('./config');

const HISTORY_CAP = 400;
const RECORDED = new Set(['allied', 'betrayed', 'warDeclared', 'peace', 'death', 'nuke', 'doomed', 'win', 'shareGranted',
  'outbreak', 'hordeWave', 'hordeWiped', 'cureStep', 'immune', 'sporeLanding', 'allianceExpired', 'rebelled']);

module.exports = {
  recordHistory(events) {
    if (!events || !events.length) return;
    this.history ||= [];
    this.historySeen ||= new Set();
    for (const e of events) {
      if (!RECORDED.has(e.k)) continue;
      // tribes rising and falling is noise; only nations and players make history
      const who = (sm) => { const p = this.playersBySmall[sm]; return p && p.type !== PlayerType.BOT ? p : null; };
      let a = null, b = null, once = null;
      switch (e.k) {
        case 'allied': a = who(e.a); b = who(e.b); if (!a || !b) continue; once = 'al' + Math.min(e.a, e.b) + '-' + Math.max(e.a, e.b); break;
        case 'betrayed': a = who(e.by); b = who(e.p); if (!a || !b) continue; break;
        case 'warDeclared': a = who(e.by); b = who(e.on); if (!a || !b) continue; break;
        case 'peace': a = who(e.by); b = who(e.with); if (!a || !b) continue; break;
        case 'death': a = who(e.p); if (!a) continue; b = e.by ? this.playersBySmall[e.by] : null; break;
        case 'nuke': a = who(e.by); b = e.target ? who(e.target) : null; if (!a) continue; once = 'nk' + e.by + '-' + (e.target || 0); break;
        case 'doomed': a = who(e.p); if (!a) continue; once = 'dm' + e.p; break;
        case 'shareGranted': a = who(e.by); b = who(e.rcv); if (!a || !b) continue; once = 'sh' + e.by + '-' + e.rcv + '-' + e.id; break;
        case 'allianceExpired': a = who(e.a); b = who(e.b); if (!a || !b) continue; break;
        case 'win': a = e.p ? this.playersBySmall[e.p] : null; break;
        case 'cureStep': a = who(e.p); if (!a || e.step >= 3) continue; break;
        case 'immune': a = who(e.p); if (!a) continue; break;
        case 'rebelled': a = who(e.p); b = who(e.from); break;
        default: break;   // zombie-mode events carry their own fields
      }
      if (once) { if (this.historySeen.has(once)) continue; this.historySeen.add(once); }
      this.history.push({ t: Math.max(0, this.tick - (this.spawnTicks || 0)), k: e.k, a: a ? [a.smallID, a.name] : null, b: b ? [b.smallID, b.name] : null, x: e.type || e.id || e.step || e.team || e.bar || e.size || null });
      if (this.history.length > HISTORY_CAP) this.history.splice(1, 1);   // keep the opening, drop the oldest after it
    }
  },
  historyPacket() { return (this.history || []).map((h) => [h.t, h.k, h.a, h.b, h.x]); },
};
