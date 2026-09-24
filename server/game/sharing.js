'use strict';
// Research sharing between allies.
//
// An ally can lend you one of its doctrines, and you can ask for one. Each lender lends at most one
// doctrine to each ally at a time. A borrowed doctrine works exactly as if you had researched it, but it
// is not yours: the lender can take it back at any moment (no penalty, no hard feelings), you can hand it
// back, and it goes home by itself when the alliance ends. It does not use up one of your research slots,
// and if you later research the same doctrine yourself it becomes yours for good.
//
// A borrowed doctrine sits in the borrower's \`researches\` like any other, so every effect in the game
// sees it; \`borrowed\` (doctrine id -> lender smallID) records which ones are on loan.
// Mixed into Game.prototype.
const { PlayerType } = require('./config');
const { RESEARCH_BY_ID } = require('./research');

const NOT_LENDABLE = new Set(['cure_1', 'cure_2', 'cure_3']);   // zombie-mode cure steps stay with whoever did the work
const SHARE_REQUEST_TICKS = 300;                               // an unanswered ask lapses after 30s

module.exports = {
  allied(a, b) { return a !== b && a.alive && b.alive && a.isFriendly(b); },
  ownsDoctrine(p, id) { return p.researches.has(id) && !p.borrowed.has(id); },
  // What \`lender\` currently lends \`borrower\` (doctrine id) or null.
  lentTo(lender, borrower) {
    for (const [id, sm] of borrower.borrowed) if (sm === lender.smallID) return id;
    return null;
  },
  canLend(lender, borrower, id) {
    if (!this.allied(lender, borrower)) return { ok: false, reason: 'You can only share doctrines with an ally' };
    if (!RESEARCH_BY_ID[id] || NOT_LENDABLE.has(id)) return { ok: false, reason: 'That doctrine cannot be shared' };
    if (!this.ownsDoctrine(lender, id)) return { ok: false, reason: `${lender.name} has not researched that themselves` };
    if (borrower.researches.has(id)) return { ok: false, reason: `${borrower.name} already has it` };
    const cur = this.lentTo(lender, borrower);
    if (cur) return { ok: false, reason: `${lender.name} already lends ${borrower.name} ${RESEARCH_BY_ID[cur].name} (take it back first)` };
    return { ok: true };
  },
  lendDoctrine(lender, borrower, id) {
    const c = this.canLend(lender, borrower, id);
    if (!c.ok) return c;
    borrower.researches.add(id);
    borrower.borrowed.set(id, lender.smallID);
    this.shareRequests.delete(`${borrower.id}|${lender.id}`);
    lender.updateRelation(borrower, 10); borrower.updateRelation(lender, 20);
    this.unitsChanged = true;
    this.events.push({ k: 'shareGranted', by: lender.smallID, rcv: borrower.smallID, id });
    if (borrower.ai && borrower.ai.onResearch) borrower.ai.onResearch();
    return { ok: true };
  },
  // The lender takes it back, or the borrower hands it back: same thing, no penalty either way.
  endLoan(lender, borrower, reason = 'revoked') {
    const id = this.lentTo(lender, borrower);
    if (!id) return { ok: false, reason: 'Nothing is being lent there' };
    borrower.borrowed.delete(id);
    borrower.researches.delete(id);
    this.unitsChanged = true;
    this.events.push({ k: 'shareEnded', by: lender.smallID, rcv: borrower.smallID, id, reason });
    if (borrower.ai && borrower.ai.onResearch) borrower.ai.onResearch();
    return { ok: true };
  },
  // Alliance over (broken, expired, someone died): every loan between the two goes home.
  endSharing(a, b) {
    if (this.lentTo(a, b)) this.endLoan(a, b, 'alliance');
    if (this.lentTo(b, a)) this.endLoan(b, a, 'alliance');
    this.shareRequests.delete(`${a.id}|${b.id}`); this.shareRequests.delete(`${b.id}|${a.id}`);
  },
  // Researching a doctrine you were only borrowing makes it yours.
  onDoctrineResearched(p, id) {
    if (p.borrowed.has(id)) { p.borrowed.delete(id); this.events.push({ k: 'shareOwned', p: p.smallID, id }); }
  },
  askDoctrine(borrower, lender, id) {
    const c = this.canLend(lender, borrower, id);
    if (!c.ok) return c;
    const key = `${borrower.id}|${lender.id}`;
    if (this.shareRequests.has(key)) return { ok: false, reason: `You already asked ${lender.name} - wait for an answer` };
    this.shareRequests.set(key, { borrower, lender, id, tick: this.tick });
    if (lender.type === PlayerType.HUMAN) this.events.push({ k: 'shareAsk', to: lender.id, from: borrower.smallID, id });
    return { ok: true };
  },
  answerDoctrine(lender, borrower, accept) {
    const key = `${borrower.id}|${lender.id}`;
    const r = this.shareRequests.get(key);
    if (!r) return { ok: false, reason: 'No such request' };
    this.shareRequests.delete(key);
    if (accept) return this.lendDoctrine(lender, borrower, r.id);
    this.events.push({ k: 'shareDenied', by: lender.smallID, rcv: borrower.smallID, id: r.id });
    return { ok: true };
  },
  tickSharing() {
    if (this.tick % 10 || !this.shareRequests.size) return;
    for (const [key, r] of this.shareRequests) {
      if (!this.allied(r.lender, r.borrower) || this.tick - r.tick > SHARE_REQUEST_TICKS) this.shareRequests.delete(key);
      else if (r.lender.ai && r.lender.ai.answerShare) { this.shareRequests.delete(key); this.answerDoctrine(r.lender, r.borrower, r.lender.ai.answerShare(r.borrower, r.id)); }
    }
  },
  // For the stats row: [[doctrine, lender smallID], ...]
  borrowedPacket(p) { return [...p.borrowed].map(([id, sm]) => [id, sm]); },
};
