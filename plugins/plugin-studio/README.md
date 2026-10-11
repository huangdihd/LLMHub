# Plugin Studio

Write LLMHub plugins inside LLMHub. Adds a **Studio** page with:

- **Plugins in the runtime plugin folder** (`.data/plugins/<id>/`), created from a template:
  a request hook, a page backed by a route, or an empty plugin. Load a new one with
  **Plugins → Scan**, and pick up edits with **Reload**.
- **An editor** with syntax highlighting, line numbers and Ctrl/⌘+S.
- **An assistant** that uses the models behind this gateway. It reads, writes and edits the
  plugin's files, looks up the plugin documentation and checks the manifest and JavaScript
  syntax. It works only inside the selected plugin's folder.
- **VS Code**: starts an [OpenVSCode Server](https://github.com/gitpod-io/openvscode-server),
  [code-server](https://github.com/coder/code-server) or `code serve-web` on the gateway
  machine, opened on the plugin's folder, in its own browser tab.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Assistant model | empty | `provider/model` chosen first in the model list |
| API key | empty | An LLMHub API key the assistant uses, so its requests count against that key. Empty: your dashboard session is used |
| Base URL | this gateway | Any OpenAI-compatible base URL, such as `http://127.0.0.1:3000/api/openai` |
| Steps per message | 25 | Model calls the assistant may make before it stops and asks to continue |
| Plugin folder | `.data/plugins` | Where plugins are created and edited |
| VS Code server command | found on `PATH` | `openvscode-server`, `code-server` or `code`, or an absolute path |
| VS Code address / port | `127.0.0.1` / `3100` | Where the server listens |
| VS Code public URL | empty | An `https://` address of your reverse proxy in front of it; enables the Open button |

## Using models from VS Code

Inside the VS Code server, any extension that speaks the OpenAI API (Continue, Cline, Roo Code
and others) can use this gateway: set its base URL to `http://127.0.0.1:3000/api/openai` (your
gateway address) and its API key to an LLMHub API key.

## Security

- The plugins you write run inside the gateway with its full privileges. So does the
  assistant's work, once you load it: review what it wrote before enabling it.
- A VS Code server can run any command as the gateway's user. Its link contains the access
  token. Keep it on `127.0.0.1` and reach it through an SSH tunnel
  (`ssh -L 3100:127.0.0.1:3100 server`) or an HTTPS reverse proxy with its own authentication.
- Without an API key the assistant borrows the dashboard session of whoever pressed Send, only
  to call the gateway's own model endpoint.
- Conversations are kept in the plugin's storage, per plugin being written.
