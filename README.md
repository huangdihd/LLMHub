# LLMHub

A unified LLM gateway that aggregates multiple LLM providers behind OpenAI and Claude compatible API endpoints.

## Features

- **Dual Protocol Support**: Exposes both OpenAI-compatible (`/api/openai/*`) and Claude-compatible (`/api/claude/v1/*`) endpoints
- **Multi-Provider Aggregation**: Connect multiple LLM providers (OpenAI, Claude, DeepSeek, etc.) through a single gateway
- **API Key Management**: Create and manage API keys with per-key rate limiting and model access control
- **Brute-Force Protection**: Configurable login protection with IP-based lockout
- **Usage Tracking**: Monitor API calls and token usage per key
- **Web Dashboard**: Manage providers, models, API keys, and security settings

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Open http://localhost:3000 and set up your admin password.

## Configuration

### Adding Providers

Navigate to **Providers** page to add your LLM providers:

| Field | Description |
|-------|-------------|
| Name | Unique identifier (e.g., `openai`, `deepseek`) |
| Protocol | `openai` or `claude` |
| Base URL | Provider API endpoint |
| API Key | Your provider API key |

### Creating API Keys

Navigate to **API Keys** page to create keys for your applications:

- Set monthly token limits
- Restrict access to specific providers or models
- Track usage per key

## API Endpoints

### OpenAI Compatible

```
POST /api/openai/chat/completions
POST /api/openai/completions
POST /api/openai/responses
GET  /api/openai/models
```

### Claude Compatible

```
POST /api/claude/v1/messages
POST /api/claude/v1/complete
GET  /api/claude/v1/models
```

### Usage Example

```bash
# OpenAI SDK
curl http://localhost:3000/api/openai/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]}'

# Claude SDK
curl http://localhost:3000/api/claude/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-sonnet-20240229", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'
```

## Architecture

### Directory Structure

```
LLMHub/
├── pages/                    # Frontend (Vue 3)
│   ├── index.vue             #   Dashboard
│   ├── chat.vue              #   Chat playground
│   ├── models.vue            #   Model list
│   ├── providers.vue         #   Provider management
│   ├── api-keys.vue          #   API key management
│   ├── security.vue          #   Brute-force config
│   └── login.vue             #   Admin login
│
├── server/                   # Backend (Nitro)
│   ├── api/                  #   API routes
│   │   ├── auth/             #     Authentication
│   │   ├── hub/              #     Dashboard APIs
│   │   ├── openai/           #     OpenAI-compatible endpoints
│   │   └── claude/v1/        #     Claude-compatible endpoints
│   ├── protocols/            #   Request/response parsers
│   │   ├── openai-chat.ts    #     OpenAI Chat parser
│   │   ├── claude-messages.ts#     Claude Messages parser
│   │   └── ...               #     Serializers
│   ├── providers/            #   Provider adapters
│   │   ├── loader.ts         #     Config & model loader
│   │   ├── manager.ts        #     Adapter manager
│   │   ├── openai.ts         #     OpenAI adapter
│   │   └── claude.ts         #     Claude adapter
│   ├── stores/               #   Data persistence
│   │   ├── auth.store.ts     #     Keys, sessions, brute-force
│   │   └── provider.store.ts #     Provider configs
│   └── middleware/           #   Auth middleware
│       ├── openai-auth.ts    #     Validate OpenAI API keys
│       ├── claude-auth.ts    #     Validate Claude API keys
│       └── hub-auth.ts       #     Validate admin session
│
└── .data/                    # Runtime storage (gitignored)
    ├── auth/                 #   Sessions, API keys, brute-force
    ├── providers/            #   Provider configs
    └── stats/                #   Usage counters
```

### Request Flow

```
Client Request
      │
      ▼
┌─────────────────┐
│  Auth Middleware │  Validate API key / Session
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   API Route     │  /api/openai/chat/completions
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Protocol Parser │  Convert to unified LLMRequest
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│Provider Manager │  Resolve model → provider
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│Provider Adapter │  Convert to provider-native format
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  LLM Provider   │  OpenAI / Claude / DeepSeek / ...
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│Protocol Serialze│  Convert response back to client format
└─────────────────┘
```

### Key Design Decisions

1. **Dual Protocol Gateway**: Single backend serves both OpenAI and Claude clients, allowing seamless migration between SDKs
2. **Adapter Pattern**: Each provider has an adapter that converts unified requests to native format, making it easy to add new providers
3. **File-Based Storage**: No database required; all data persisted to `.data/` directory using Nitro's FS driver
4. **Model Name Format**: Models are namespaced as `provider/model-id` (e.g., `openai/gpt-4`, `deepseek/deepseek-chat`)

## Tech Stack

- **Framework**: Nuxt 3 (Vue 3 + Nitro)
- **Language**: TypeScript
- **UI**: Nuxt UI + Tailwind CSS
- **Storage**: File-based (Nitro FS driver)

## License

MIT
