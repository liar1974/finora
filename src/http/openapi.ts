export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Finora Local API',
    version: '1.0.0',
    description: 'Versioned local API for accounts, statement imports, transactions, and summaries.',
  },
  servers: [{ url: 'http://127.0.0.1:3011' }],
  paths: {
    '/v1/health': { get: { summary: 'Health check', responses: { '200': { description: 'Healthy' } } } },
    '/v1/accounts': {
      get: { summary: 'List accounts', responses: { '200': { description: 'Account collection' } } },
      post: {
        summary: 'Create an account',
        responses: {
          '201': { description: 'Account created' },
          '409': { description: 'Account already exists' },
          '422': { description: 'Validation failed' },
        },
      },
    },
    '/v1/accounts/{accountId}': {
      get: {
        summary: 'Get an account',
        parameters: [{ name: 'accountId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Account' }, '404': { description: 'Account not found' } },
      },
      delete: {
        summary: 'Delete a local file-backed account',
        description: 'Provider-managed accounts must be removed through their provider connection.',
        parameters: [{ name: 'accountId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Account deleted' },
          '404': { description: 'Account not found' },
          '422': { description: 'Provider-managed account cannot be deleted directly' },
        },
      },
    },
    '/v1/imports': {
      post: {
        summary: 'Import a statement',
        description: 'Content-addressed per account and safe to retry with identical content.',
        responses: {
          '200': { description: 'Import result' },
          '404': { description: 'Account not found' },
          '415': { description: 'Statement format not supported' },
          '422': { description: 'Validation or parsing failed' },
        },
      },
    },
    '/v1/transactions': {
      get: {
        summary: 'List transactions',
        parameters: [
          { name: 'accountId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Cursor-paginated transaction collection' } },
      },
    },
    '/v1/summary': {
      get: {
        summary: 'Summarize cash flow by currency',
        responses: { '200': { description: 'Income, expense, and net totals' } },
      },
    },
    '/v1/provider-connections': {
      get: { summary: 'List provider connections', responses: { '200': { description: 'Provider connection collection' } } },
    },
    '/v1/plaid/link-token': {
      post: { summary: 'Create a Plaid Link token', responses: { '200': { description: 'Link token' }, '422': { description: 'Missing credentials' } } },
    },
    '/v1/plaid/exchange': {
      post: { summary: 'Exchange a Plaid public token', responses: { '200': { description: 'Plaid Item and account sync result' }, '422': { description: 'Validation failed' } } },
    },
    '/v1/plaid/remove': {
      post: { summary: 'Remove a Plaid Item connection', responses: { '200': { description: 'Removal result' }, '422': { description: 'Validation failed' } } },
    },
    '/v1/snaptrade/connect': {
      post: { summary: 'Create a SnapTrade Connection Portal URL', responses: { '200': { description: 'Portal URL' }, '422': { description: 'Missing credentials' } } },
    },
    '/v1/snaptrade/remove': {
      post: { summary: 'Remove a SnapTrade brokerage authorization', responses: { '200': { description: 'Removal result' }, '422': { description: 'Validation failed' } } },
    },
    '/v1/brokerage/summary': {
      get: { summary: 'Summarize brokerage holdings by currency', responses: { '200': { description: 'Brokerage summary collection' } } },
    },
    '/v1/brokerage/transactions': {
      get: { summary: 'List brokerage transactions', responses: { '200': { description: 'Cursor-paginated brokerage transaction collection' } } },
    },
    '/v1/brokerage/holdings': {
      get: { summary: 'List latest brokerage holdings', responses: { '200': { description: 'Holding collection' } } },
    },
    '/v1/account-balances': {
      get: { summary: 'List account balances', responses: { '200': { description: 'Balance collection' } } },
    },
    '/v1/credit-reports': {
      post: {
        summary: 'Validate and record a credit report PDF upload',
        responses: {
          '200': { description: 'Credit report import result' },
          '415': { description: 'Unsupported format' },
          '422': { description: 'Validation failed' },
        },
      },
    },
    '/v1/settings': {
      get: { summary: 'List app setting previews', responses: { '200': { description: 'Setting preview collection' } } },
      post: { summary: 'Save app settings', responses: { '200': { description: 'Save result' } } },
    },
    '/v1/chat': {
      post: { summary: 'Ask the local finance assistant', responses: { '200': { description: 'Assistant reply' }, '422': { description: 'Validation failed' } } },
    },
    '/v1/llm': {
      get: { summary: 'Get effective LLM configuration', responses: { '200': { description: 'LLM status' } } },
    },
    '/v1/llm/test': {
      post: { summary: 'Test the configured chat model', responses: { '200': { description: 'Connectivity result' }, '502': { description: 'Model request failed' } } },
    },
    '/v1/telegram/connect': {
      post: { summary: 'Bind the configured Telegram bot to a chat', responses: { '200': { description: 'Bound chat' }, '422': { description: 'Missing token or chat' } } },
    },
    '/v1/alert-rules': {
      get: { summary: 'List alert rules', responses: { '200': { description: 'Alert rule collection' } } },
      post: { summary: 'Create an alert rule', responses: { '201': { description: 'Alert rule created' }, '422': { description: 'Validation failed' } } },
    },
    '/v1/alert-rules/toggle': {
      post: { summary: 'Enable or disable an alert rule', responses: { '200': { description: 'Updated alert rule' }, '404': { description: 'Alert rule not found' } } },
    },
    '/v1/alert-rules/remove': {
      post: { summary: 'Remove an alert rule', responses: { '200': { description: 'Removal result' } } },
    },
    '/v1/alert-mutes': {
      get: { summary: 'List alert mutes', responses: { '200': { description: 'Alert mute collection' } } },
      post: { summary: 'Create an alert mute', responses: { '201': { description: 'Alert mute created' }, '422': { description: 'Validation failed' } } },
    },
    '/v1/alert-mutes/remove': {
      post: { summary: 'Remove an alert mute', responses: { '200': { description: 'Removal result' } } },
    },
  },
  components: {
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: { type: 'object' },
              requestId: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
    },
  },
} as const;
