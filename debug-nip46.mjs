import WebSocket from 'ws';

const BUNKER_PUBKEY = '3f770d65d3a764a9c5cb503ae123e62ec7598ad035d836e2a810f3877a745b24';
const CLIENT_PUBKEY = 'ec3e65bd1891b8619b86f9b4655607d285362d0e7e1ec398424bae784b370567';
const RELAY_URL = 'wss://relay.nsec.app';

console.log('Checking relay.nsec.app for NIP-46 events...\n');

const ws = new WebSocket(RELAY_URL);
let requestCount = 0, responseCount = 0;

ws.on('open', () => {
  ws.send(JSON.stringify(['REQ', 'req', { kinds: [24133], authors: [CLIENT_PUBKEY], '#p': [BUNKER_PUBKEY], limit: 5 }]));
  ws.send(JSON.stringify(['REQ', 'resp', { kinds: [24133], authors: [BUNKER_PUBKEY], '#p': [CLIENT_PUBKEY], limit: 5 }]));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg[0] === 'EVENT') {
    const ev = msg[2];
    const time = new Date(ev.created_at * 1000).toLocaleTimeString();
    if (msg[1] === 'req') { requestCount++; console.log(`REQUEST  ${ev.id.slice(0,8)} @ ${time}`); }
    else { responseCount++; console.log(`RESPONSE ${ev.id.slice(0,8)} @ ${time}`); }
  }
  if (msg[0] === 'EOSE' && msg[1] === 'resp') {
    console.log(`\nRequests on relay: ${requestCount}`);
    console.log(`Responses on relay: ${responseCount}`);
    if (requestCount > 0 && responseCount === 0) console.log('\n⚠️  Amber is NOT responding to requests!');
    ws.close();
  }
});

setTimeout(() => ws.close(), 5000);
