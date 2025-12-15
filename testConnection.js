// test-deriv-connection.js
const DerivAPI = require('./lib/DerivAPI');

async function testConnection() {
  const broker = new DerivAPI('0P94g4WdSrSrzir');
  
  try {
    await broker.connect();
    await broker.authorize();
    
    console.log('✅ API Connection successful');
    
    // Test proposal (no money at risk)
    const proposal = await broker.getProposal({
      amount: 10,
      basis: 'stake',
      contract_type: 'CALL',
      currency: 'USD',
      duration: 5,
      duration_unit: 'm',
      symbol: 'EURUSD'
    });
    
    console.log('✅ Proposal received:', proposal.id);
    console.log('⚠️  This was a TEST - no trade executed');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    broker.disconnect();
  }
}

testConnection();