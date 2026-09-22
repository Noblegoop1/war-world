'use strict';
// Shared monotonically increasing id for every simulated object (structures, units, attacks, projectiles).
let next = 1;
module.exports = { newId: () => next++ };
