// ...existing code...
const WebSocket = require('ws');

const url = 'wss://ws.derivws.com/websockets/v3?app_id=1089'; // change app_id if needed
const connection = new WebSocket(url);

connection.on('open', () => {
  console.log('✅ Connected to Deriv API');

  // request active symbols (full or brief). Use product_type to limit results.
  const req = { active_symbols: 'full', product_type: 'basic', req_id: 1 };
  connection.send(JSON.stringify(req));

  // safety timeout in case no response
  setTimeout(() => {
    console.error('⚠️ Timeout waiting for response');
    connection.terminate();
  }, 10000);
});

connection.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    // response may contain active_symbols
    const symbols = msg.active_symbols || (msg.msg_type === 'active_symbols' && msg.active_symbols) || null;
    if (symbols && Array.isArray(symbols)) {
      const jump = symbols.filter(s => s.symbol && s.symbol.includes('JD')).map(s => s.symbol);
      console.log('📊 Jump Indices:', jump);
      // console.log('📊 All Indices:', symbols);
      connection.close();
    } else {
      // ignore other messages (authorize, heartbeat, etc.)
    }
  } catch (err) {
    console.error('⚠️ Failed to parse message:', err);
  }
});

connection.on('close', () => console.log('❌ Connection closed'));
connection.on('error', (err) => console.error('⚠️ Connection error:', err));