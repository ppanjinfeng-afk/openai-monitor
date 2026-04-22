# OpenAI Monitor

Ubuntu VPS 部署建议直接看：

- [docs/deploy-ubuntu-vps.md](./docs/deploy-ubuntu-vps.md)

## GitHub 一键拉取思路

先把本项目推到 GitHub，然后在 VPS 上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/<你的GitHub用户名>/<你的仓库名>/main/deploy/bootstrap-ubuntu.sh | sudo bash -s -- https://github.com/<你的GitHub用户名>/<你的仓库名>.git /opt/openai-monitor
```

注意：

- `data/monitor.db` 默认不会提交到 GitHub
- 账号、令牌、支付、Telegram、工作区等数据都在这个数据库里
- 代码可以走 GitHub，数据库建议单独传一次到 VPS
- Ubuntu 默认部署直接走 `Nginx -> 127.0.0.1:3000`

数据库单独上传示例：

```bash
scp ./data/monitor.db root@<你的VPSIP>:/opt/openai-monitor/data/monitor.db
```
