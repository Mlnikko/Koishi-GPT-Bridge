'use strict';

// A real 1x1, red/blue, two-frame looping GIF (100 ms per frame).
const animatedGif = () => Buffer.from(
  '47494638396101000100800000ff00000000ff'
  + '21ff0b4e45545343415045322e300301000000'
  + '21f904000a0000002c0000000001000100000202440100'
  + '21f904000a0000002c00000000010001000002024c0100'
  + '3b', 'hex');

module.exports = { animatedGif };
