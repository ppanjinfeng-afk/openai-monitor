const fetch = require('node-fetch');
const db = require('./db');
const account = db.prepare('SELECT access_token FROM accounts WHERE id = 1').get();

async function test() {
  // Get orgs
  console.log('Fetching /v1/me...');
  const res = await fetch('https://api.openai.com/v1/me', {
    headers: { 'Authorization': 'Bearer ' + account.access_token }
  });
  
  const me = await res.json();
  const orgs = me.orgs?.data || [];
  console.log('Orgs found:', orgs.length);
  
  if (orgs.length === 0) {
    console.log('No orgs found');
    return;
  }
  
  // Use first org
  const targetOrg = orgs.find(o => !o.personal) || orgs[0];
  console.log('Using Org:', targetOrg.id, 'Title:', targetOrg.title);
  
  // Try to invite
  console.log('Sending invite...');
  const inviteRes = await fetch('https://api.openai.com/v1/organization/invites', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + account.access_token,
      'OpenAI-Organization': targetOrg.id,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email: 'test_invitation_99@example.com', role: 'reader' })
  });
  
  console.log('Invite Status:', inviteRes.status);
  console.log('Invite Response:', await inviteRes.text());
}

test().catch(console.error);
