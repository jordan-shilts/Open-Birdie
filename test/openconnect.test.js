'use strict';
// The Open Connect server (lib/openconnect.js) over a real local socket: replies stay
// GSPro-shaped and name Open-Birdie, so a launch monitor can show what it's connected to.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { OpenConnectServer, SIMULATOR_NAME } = require('../lib/openconnect');

// Every JSON reply the server sends, until `count` have arrived.
function collect(sock, count) {
  return new Promise((resolve) => {
    let buf = '';
    const replies = [];
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // replies are bare objects back to back
      for (let end = buf.indexOf('}{'); end >= 0 || buf.endsWith('}'); end = buf.indexOf('}{')) {
        const cut = end >= 0 ? end + 1 : buf.length;
        replies.push(JSON.parse(buf.slice(0, cut)));
        buf = buf.slice(cut);
        if (end < 0) break;
      }
      if (replies.length >= count) resolve(replies);
    });
  });
}

test('replies keep the GSPro shape and name the simulator', async (t) => {
  const oc = new OpenConnectServer(0);
  oc.start();
  await new Promise((resolve) => oc.server.once('listening', resolve));
  t.after(() => oc.server.close());
  const sock = net.connect(oc.server.address().port, '127.0.0.1');
  t.after(() => sock.destroy());
  const replies = collect(sock, 2);
  await new Promise((resolve) => sock.once('connect', resolve));
  sock.write(JSON.stringify({ DeviceID: 'test', ShotNumber: 1, ShotDataOptions: { IsHeartBeat: true } }));
  const [greeting, heartbeat] = await replies;
  assert.equal(SIMULATOR_NAME, 'Open-Birdie');
  assert.equal(greeting.Code, 201);
  assert.equal(greeting.Message, 'GSPro Player Information', 'GSPro clients key on the code and message');
  assert.equal(greeting.Player.Club, 'DR');
  assert.equal(greeting.Simulator, 'Open-Birdie');
  assert.deepEqual(heartbeat, { Code: 200, Message: 'Heartbeat OK', Simulator: 'Open-Birdie' });
});
