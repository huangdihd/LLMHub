# Plugin Studio

Write LLMHub plugins in VS Code, with an AI agent that uses this gateway's own models.
Plugin Studio builds on existing tools rather than its own editor or agent:

- **Editor**: [OpenVSCode Server](https://github.com/gitpod-io/openvscode-server),
  [code-server](https://github.com/coder/code-server) or `code serve-web`, started on the gateway
  machine and opened on the plugin's folder in its own browser tab.
- **Agent**: [Continue](https://github.com/continuedev/continue), installed into that VS Code from
  Open VSX and configured with every model your LLMHub API key can use. It is told how LLMHub
  plugins are written through a Continue rule.

The **Studio** page lists the plugins in the runtime plugin folder (`.data/plugins/<id>/`),
creates new ones from a template (a request hook, a page backed by a route, or an empty plugin)
and opens any of them in VS Code. Load a new plugin with **Plugins → Scan** and pick up edits
with **Reload**.

## Setup

1. Install a VS Code server on the gateway machine, for example OpenVSCode Server, and put
   `openvscode-server` on `PATH` (or set its path in the settings).
2. Create an LLMHub API key for the agent and enter it in Plugin Studio's settings.
3. Open **Studio**, pick a plugin and click **Open in VS Code**. The first start installs Continue,
   which needs access to `open-vsx.org`. Open the printed link; Continue is in the sidebar.

With `code serve-web`, install Continue yourself from the Extensions view; the configuration is
still written for it.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| API key | empty | The LLMHub API key Continue uses. Its requests count against this key |
| Model listed first | empty | `provider/model` shown first in Continue |
| Install and configure Continue | on | Turn off to use VS Code alone or another agent |
| Base URL | this gateway | OpenAI-compatible base URL written into Continue's configuration |
| Plugin folder | `.data/plugins` | Where plugins are listed and created |
| VS Code server command | found on `PATH` | `openvscode-server`, `code-server` or `code`, or an absolute path |
| VS Code address / port | `127.0.0.1` / `3100` | Where the server listens |
| VS Code public URL | empty | An `https://` address of your reverse proxy in front of it; enables the Open button |

Continue's configuration is written to `.data/plugin-studio/continue/config.yaml` and given to
VS Code through `CONTINUE_GLOBAL_DIR`, so your own `~/.continue` is left alone. It is rewritten
each time VS Code starts, with the models the key can use at that moment.

## Security

- The plugins you write run inside the gateway with its full privileges. Review what the agent
  wrote before enabling it.
- A VS Code server can run any command as the gateway's user, and its link contains the access
  token. Keep it on `127.0.0.1` and reach it through an SSH tunnel
  (`ssh -L 3100:127.0.0.1:3100 server`) or an HTTPS reverse proxy with its own authentication.
- The API key is stored in plain text in Continue's configuration under `.data`, like other
  LLMHub secrets. Give it only the models the agent needs.
