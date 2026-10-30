'use strict';
// Used only by the child server in integration/browser tests. Production does
// not load this file and always uses crypto.randomInt.
const crypto = require('crypto');
const original = crypto.randomInt;
let spins = 0;
crypto.randomInt = function deterministicRandomInt(...args) {
  if (args.length === 1 && args[0] === 100) return 0;
  if (args.length === 1 && args[0] === 2) return spins++ % 2;
  return original.apply(crypto, args);
};
