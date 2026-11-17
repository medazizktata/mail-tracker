import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isApplePrefetch } from '../src/shared.js';

// Apple Mail Privacy Protection fetches every image through Apple's proxy when a mail is DELIVERED,
// whether or not it is ever read. The IPv4 block is Apple's own /8; the IPv6 block is from memory.
describe('isApplePrefetch', () => {
  test('addresses in 17.0.0.0/8 are Apple', () => {
    for (const ip of ['17.0.0.1', '17.58.63.12', '17.241.200.9', '17.255.255.255']) assert.equal(isApplePrefetch(ip), true, ip);
  });

  test('addresses that merely start with the same digits are not', () => {
    for (const ip of ['170.1.2.3', '117.5.5.5', '172.16.0.4', '1.17.0.0', '27.1.1.1', '16.255.255.255', '18.0.0.1']) {
      assert.equal(isApplePrefetch(ip), false, ip);
    }
  });

  test('Apple\'s IPv6 block, any case, but not its neighbours', () => {
    assert.equal(isApplePrefetch('2620:149:af0::1'), true);
    assert.equal(isApplePrefetch('2620:0149:AF0::1'), true);
    assert.equal(isApplePrefetch('2620:14a::1'), false);
    assert.equal(isApplePrefetch('2620:1490::1'), false);
    assert.equal(isApplePrefetch('2a00:1450::1'), false);
  });

  test('not an address, or missing, is not Apple', () => {
    for (const ip of ['unknown', '', undefined, null, '17.x.1.1', '17.1.1', '17.1.1.1.1', '17.300.1.1']) assert.equal(isApplePrefetch(ip), false, String(ip));
  });
});
