# LLMHub

[English](README.md) | 简体中文

LLMHub 是一个可以自己部署的开源模型网关。把你手上的各家模型接进来,对外只给一个地址和一把 key,客户端用 OpenAI、Claude、Gemini 哪种协议都可以。功能通过插件扩展,后台自带插件市场。

## 它能做什么

- **一个地址,一把 key**:把多个上游(OpenAI、Anthropic、Gemini、DeepSeek、本地模型等)聚合在一起,客户端只需要配置一次。
- **三种协议互通**:同时提供 OpenAI、Claude、Gemini 三套兼容接口。客户端用哪种协议,和请求最终发给哪家上游无关。比如用 Claude 的 SDK 调 OpenAI 的模型。
- **接入订阅**:除了 API key,还可以接入 ChatGPT、Claude、Google Antigravity 的订阅,把订阅里的额度当成 API 来用。
- **管理 key**:给每把 key 设置月度额度、限速、可用的模型,模型不可用时自动降级到备选,并查看每把 key 的用量。
- **插件**:改写请求、接入新的上游、订阅事件、给后台加字段和页面,都可以用插件完成。安装、启用、更新都不需要重启网关。
- **管理后台**:以上所有事情都在网页上完成,另有一个可以直接和模型对话的页面。

## 安装

### 一行命令(Linux / macOS)

需要先装好 Git、Node(20.19 以上或 22.12 以上)和 npm。

```sh
curl -fsSL https://raw.githubusercontent.com/huangdihd/LLMHub/main/install.sh | sh
```

脚本会把 LLMHub 装到 `~/llmhub` 并完成构建。在带 systemd 的 Linux 上,它会询问是否注册成系统服务(开机自启),同意后才会用到 sudo;不同意或者在 macOS 上,它会打印一条手动启动的命令。

装好后打开 http://127.0.0.1:3000 ,**先设置管理员密码**。

常用的配置项通过环境变量传给 `sh`(注意是加在 `sh` 前面,不是 `curl` 前面):

```sh
curl -fsSL https://raw.githubusercontent.com/huangdihd/LLMHub/main/install.sh | LLMHUB_PORT=8080 sh
```

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `LLMHUB_INSTALL_DIR` | `$HOME/llmhub` | 安装目录 |
| `LLMHUB_PORT` | `3000` | 监听端口 |
| `LLMHUB_HOST` | `127.0.0.1` | 监听地址 |
| `LLMHUB_SERVICE` | `auto` | `no` 表示不注册系统服务 |
| `LLMHUB_REF` | 最新的正式版本 | 指定要安装的分支或标签 |
| `LLMHUB_DRY_RUN` | `0` | `1` 表示只打印将要做什么,不实际执行 |
| `LLMHUB_ACTION` | `install` | `uninstall` 表示移除系统服务(保留程序和数据) |

默认只监听本机。要让其他机器访问,把 `LLMHUB_HOST` 设为 `0.0.0.0`,并且务必先设好管理员密码,再配上防火墙和 HTTPS。

所有数据都在安装目录下的 `.data/` 里。升级和卸载都不会动它,备份这个目录就是备份全部数据。

### Docker

```sh
git clone https://github.com/huangdihd/LLMHub.git
cd LLMHub
docker compose up -d --build
```

然后访问 http://127.0.0.1:3000 。数据保存在名为 `llmhub-data` 的卷里;`docker compose down` 不会删除数据,加上 `-v` 才会。

## 上手

1. 打开后台,设置管理员密码。
2. 在 **Providers** 页面添加上游:填 API key,或者选择订阅类型后按提示登录。
3. 在 **API Keys** 页面创建一把 key,按需设置额度和可用模型。
4. 把客户端的接口地址指向 LLMHub,用刚创建的 key 调用。模型名的格式是 `上游名/模型名`,比如 `openai/gpt-4o`。

```sh
curl http://127.0.0.1:3000/api/openai/chat/completions \
  -H "Authorization: Bearer 你的key" \
  -H "Content-Type: application/json" \
  -d '{"model": "openai/gpt-4o", "messages": [{"role": "user", "content": "你好"}]}'
```

三套接口的地址:

| 协议 | 地址前缀 | 鉴权请求头 |
| --- | --- | --- |
| OpenAI | `/api/openai` | `Authorization: Bearer <key>` |
| Claude | `/api/claude/v1` | `x-api-key: <key>` |
| Gemini | `/api/gemini/v1` | `x-goog-api-key: <key>` |

完整的接口列表和更多调用示例见[英文 README](README.md#api-endpoints)。

## 更新

网关会定期检查有没有新的正式版本,有的话在后台首页和导航栏给出提示。这个检查可以在 **Updates** 页面关掉。

- **用安装脚本装成系统服务的**:在 Updates 页面点一下就能更新。新版本会先在旁边构建好再切换;如果新版本启动失败,会自动换回原来的版本。更新期间服务会短暂中断。
- **手动启动的**:先停掉进程,重新运行一次安装命令,再启动。
- **Docker**:Updates 页面会给出一条可以直接复制的命令。

更新不会改动 `.data/`,但也不会替你备份它。数据重要的话,更新前自己备份一份。

## 插件

在后台的 **Plugins** 页面可以浏览插件市场、从 GitHub 仓库安装、启用、配置、更新和卸载插件,全程不需要重启。

官方提供了以下插件,既能直接用,也可以当作写插件的例子:

| 插件 | 作用 |
| --- | --- |
| `llmhub-plugin-system-prompt` | 给请求加上系统提示词,可以全局设置,也可以按模型设置 |
| `llmhub-plugin-request-log` | 在后台增加一个请求日志页面 |
| `llmhub-plugin-webhook` | 请求失败时通知飞书、钉钉、企业微信或任意 webhook |
| `llmhub-plugin-plugin-studio` | 插件制作器:后台内的编辑器、可启动的 VS Code 服务器,以及用网关自己的模型帮你写插件的助手 |

**插件运行在网关进程里,拥有网关的全部权限,没有沙箱。** 插件市场里的内容没有经过审核,只安装你信任的插件。

### 写一个插件

一个插件就是一个带 `package.json` 的目录,最少只需要一个文件、十几行代码。把它放进 `.data/plugins/<插件名>/`,在后台点重新扫描就能看到。

- [第一个插件](docs/plugins/getting-started.md)
- [接口参考](docs/plugins/reference.md)
- [插件文档总览](docs/plugins/README.md)
- 示例:[`examples/plugins/`](examples/plugins)

插件文档目前是英文的。

LLMHub 自己的大部分功能也是插件:三套协议接口、各家上游的接入、额度、限速、降级等策略都在 `builtin/` 目录里,和你写的插件用的是同一套接口。

## 关于订阅接入

ChatGPT、Claude、Google Antigravity 的订阅接入用的都不是官方公开的 API,上游随时可能调整或关闭,也可能不符合对应服务的使用条款。请自行判断是否适合你的账号。

Google Antigravity 还需要在服务端配置 `ANTIGRAVITY_OAUTH_CLIENT_ID` 和 `ANTIGRAVITY_OAUTH_CLIENT_SECRET` 两个环境变量。各家的具体登录步骤见[英文 README](README.md#adding-providers)。

## 本地开发

```sh
git clone https://github.com/huangdihd/LLMHub.git
cd LLMHub
npm install
npm run dev
```

技术栈是 Nuxt 3(Vue 3 + Nitro)和 TypeScript,界面用 Nuxt UI。数据用文件存储,不需要数据库。架构说明见[英文 README](README.md#architecture)。

## 许可

MIT
