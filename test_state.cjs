const state = require('./bot/state.cjs');
state.addPosition({ positionPubKey: 'test', poolAddress: 'test' });
state.removePosition('test');
console.log('done');
