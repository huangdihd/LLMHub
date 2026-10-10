# Webhook Alerts

An [LLMHub](https://github.com/huangdihd/LLMHub) plugin that sends a message
when a request through the gateway fails, so you find out before your users
tell you.

- Works with **Feishu / Lark**, **DingTalk** and **WeCom** group bots, or any
  endpoint that accepts JSON.
- The message names the model, the provider, the API key and the error.
- Alerts are spaced out (60 seconds apart by default). Failures in between are
  counted and mentioned in the next alert.

Prompts, responses and credentials are never sent.

## Set up

1. Create a group bot in Feishu, DingTalk or WeCom and copy its webhook URL.
2. In LLMHub, open **Plugins → Browse market**, install **Webhook Alerts**.
3. Click **Configure**, paste the URL, pick the service, and save.
4. Enable the plugin.

If your DingTalk bot uses a keyword filter, add `LLMHub` as the keyword.
