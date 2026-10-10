# Request Log

An [LLMHub](https://github.com/huangdihd/LLMHub) plugin that keeps a list of
recent requests so you can see what is going through the gateway.

- Adds a **Requests** page to the dashboard: time, model, API key, client
  protocol, input and output tokens, and the error if the request failed.
- Adds a **Requests today** card to the home page.
- Keeps the most recent 200 requests by default; change the number on the
  plugin's Configure page.

Only metadata is recorded. Prompts, responses and credentials are never
stored.

## Install

Open **Plugins → Browse market** in LLMHub and install **Request Log**, then
enable it.
