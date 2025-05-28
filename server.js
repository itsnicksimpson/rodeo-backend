const express = require('express');
const axios = require('axios');
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(require('cors')());

console.log('🚀 Starting Linear Connect...');

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple storage for MVP
const integrations = new Map();
const usage = new Map();

// Subscription tiers
const TIERS = {
  FREE: { tickets: 100, ai: 'basic' },
  PRO: { tickets: 1000, ai: 'advanced' },
  ENTERPRISE: { tickets: 10000, ai: 'premium' }
};

// AI ticket enhancement
async function enhanceTicket(conversation, tier = 'FREE') {
  const customer = conversation.contacts?.contacts?.[0];
  const content = conversation.conversation_message?.body || '';
  
  console.log(`🤖 Enhancing ticket with ${tier} AI...`);
  
  try {
    const completion = await openai.chat.completions.create({
      model: tier === 'FREE' ? 'gpt-3.5-turbo' : 'gpt-4',
      messages: [
        {
          role: 'system',
          content: tier === 'FREE' 
            ? 'Create a clear, concise support ticket from this customer conversation.'
            : 'Create a comprehensive, engineer-ready Linear ticket with detailed analysis, business impact, and specific next steps. Include acceptance criteria and technical context.'
        },
        {
          role: 'user',
          content: `CUSTOMER INFO:
Name: ${customer?.name || 'Unknown'}
Email: ${customer?.email || 'No email'}
Plan: ${customer?.custom_attributes?.plan || 'Unknown'}

MESSAGE: ${content}

Please create a properly formatted ticket with title, description, and action items.`
        }
      ],
      max_tokens: tier === 'FREE' ? 300 : 800,
      temperature: 0.3
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('🚨 AI Error:', error);
    return `# Customer Issue

**Customer:** ${customer?.name || 'Unknown'}
**Email:** ${customer?.email || 'No email'}

**Issue Description:**
${content}

**Next Steps:**
- [ ] Investigate the issue
- [ ] Contact customer for more details
- [ ] Implement solution
- [ ] Follow up with customer`;
  }
}

// Setup integration endpoint
app.post('/api/setup', ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { linearToken, intercomToken, teamId } = req.body;
    
    console.log(`🔧 Setting up integration for user: ${userId}`);
    
    // Test Linear connection
    const linearResponse = await axios.post('https://api.linear.app/graphql', 
      { query: '{ user(id: "me") { id name email } }' },
      { headers: { 'Authorization': `Bearer ${linearToken}` } }
    );

    if (linearResponse.data.errors) {
      return res.status(400).json({ error: 'Invalid Linear token' });
    }

    const linearUser = linearResponse.data.data.user;
    console.log(`✅ Linear connected for: ${linearUser.name}`);

    // Store integration
    integrations.set(userId, {
      linearToken,
      intercomToken, 
      teamId,
      webhookUrl: `${process.env.BASE_URL}/webhook/${userId}`,
      linearUser: linearUser.name
    });

    res.json({ 
      success: true, 
      webhookUrl: `${process.env.BASE_URL}/webhook/${userId}`,
      linearUser: linearUser.name,
      message: 'Integration configured! Add the webhook URL to your Intercom app settings.'
    });
  } catch (error) {
    console.error('🚨 Setup error:', error);
    res.status(500).json({ error: 'Setup failed: ' + error.message });
  }
});

// Main webhook processor
app.post('/webhook/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const event = req.body;
    
    console.log(`📥 Webhook received for user: ${userId}, topic: ${event.topic}`);
    
    const config = integrations.get(userId);
    if (!config) {
      console.log('❌ Integration not found');
      return res.status(404).json({ error: 'Integration not found' });
    }

    // Check usage limits
    const userUsage = usage.get(userId) || { count: 0, tier: 'FREE' };
    const limit = TIERS[userUsage.tier].tickets;
    
    if (userUsage.count >= limit) {
      console.log(`⚠️ Usage limit exceeded: ${userUsage.count}/${limit}`);
      return res.status(429).json({ error: 'Monthly limit exceeded' });
    }

    // Process conversation events
    if (['conversation.user.created', 'conversation.user.replied'].includes(event.topic)) {
      const conversationId = event.data.item.id;
      
      console.log(`🎫 Processing conversation: ${conversationId}`);
      
      // Get conversation from Intercom
      const intercomResponse = await axios.get(
        `https://api.intercom.io/conversations/${conversationId}`,
        { headers: { 'Authorization': `Bearer ${config.intercomToken}` } }
      );
      
      const conversation = intercomResponse.data;
      const customer = conversation.contacts?.contacts?.[0];
      
      // Generate AI-enhanced ticket
      const ticketContent = await enhanceTicket(conversation, userUsage.tier);
      
      // Create Linear ticket
      const mutation = `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier title url }
          }
        }
      `;

      const title = `[${userUsage.tier}] ${customer?.name || 'Customer'} - ${conversation.conversation_message?.subject || 'Support Request'}`;
      
      const linearResponse = await axios.post('https://api.linear.app/graphql', {
        query: mutation,
        variables: {
          input: {
            teamId: config.teamId,
            title: title.substring(0, 80), // Linear title limit
            description: ticketContent,
            priority: 3
          }
        }
      }, {
        headers: { 'Authorization': `Bearer ${config.linearToken}` }
      });

      if (linearResponse.data.errors) {
        throw new Error('Linear API error: ' + JSON.stringify(linearResponse.data.errors));
      }

      const issue = linearResponse.data.data.issueCreate.issue;
      console.log(`✅ Created Linear ticket: ${issue.identifier}`);

      // Update usage
      userUsage.count++;
      usage.set(userId, userUsage);

      // Add note to Intercom conversation
      try {
        await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
          message_type: 'note',
          type: 'admin',
          body: `🤖 **Linear Ticket Created**

📋 **Ticket:** ${issue.identifier}
🔗 **Link:** ${issue.url}
🎯 **AI Enhancement:** ${userUsage.tier} tier
📊 **Usage:** ${userUsage.count}/${limit} tickets this month

*Automatically generated by Linear Connect*`
        }, {
          headers: { 'Authorization': `Bearer ${config.intercomToken}` }
        });
        
        console.log('✅ Added note to Intercom conversation');
      } catch (noteError) {
        console.log('⚠️ Failed to add Intercom note:', noteError.message);
      }

      res.json({ 
        success: true, 
        ticket: {
          id: issue.id,
          identifier: issue.identifier,
          url: issue.url,
          title: issue.title
        },
        usage: `${userUsage.count}/${limit}`,
        tier: userUsage.tier
      });
    } else {
      console.log(`ℹ️ Ignoring event: ${event.topic}`);
      res.json({ status: 'ignored', topic: event.topic });
    }
  } catch (error) {
    console.error('🚨 Webhook error:', error);
    res.status(500).json({ error: 'Processing failed: ' + error.message });
  }
});

// Get user stats
app.get('/api/stats', ClerkExpressRequireAuth(), (req, res) => {
  const userId = req.auth.userId;
  const userUsage = usage.get(userId) || { count: 0, tier: 'FREE' };
  const config = integrations.get(userId);
  const limit = TIERS[userUsage.tier].tickets;
  
  res.json({
    tier: userUsage.tier,
    usage: userUsage.count,
    limit: limit,
    percentage: Math.round((userUsage.count / limit) * 100),
    hasIntegration: !!config,
    linearUser: config?.linearUser || null
  });
});

// Update user tier (for testing)
app.post('/api/upgrade', ClerkExpressRequireAuth(), (req, res) => {
  const userId = req.auth.userId;
  const { tier } = req.body;
  
  if (!TIERS[tier]) {
    return res.status(400).json({ error: 'Invalid tier' });
  }
  
  const userUsage = usage.get(userId) || { count: 0, tier: 'FREE' };
  userUsage.tier = tier;
  usage.set(userId, userUsage);
  
  console.log(`🎯 User ${userId} upgraded to ${tier}`);
  
  res.json({ success: true, tier: tier });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    integrations: integrations.size,
    totalTickets: Array.from(usage.values()).reduce((sum, u) => sum + u.count, 0),
    uptime: Math.floor(process.uptime())
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: 'Linear Connect API is working!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Linear Connect running on port ${PORT}`);
  console.log(`📊 Ready to process tickets!`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🧪 Test endpoint: http://localhost:${PORT}/api/test`);
});