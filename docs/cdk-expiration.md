# CDK 1 天自动过期

这个功能会把超过指定天数仍未使用的 CDK 标记为 `expired`。

默认规则：

- 只处理 `cdk_cards.status = 'unused'` 的 CDK
- 默认过期时间是 1 天，也就是创建时间超过 24 小时
- 不处理 `used`、`processing`，也不会改正在处理中的任务
- 过期时保留买家邮箱、绑定邮箱、订单号等历史信息，只更新 `status` 和 `updated_at`

## 手动运行

先预览，不改数据库：

```bash
cd /opt/openai-monitor
npm run cdk:expire -- --dry-run --days=1
```

确认无误后执行：

```bash
cd /opt/openai-monitor
npm run cdk:expire -- --days=1
```

如果只想处理已经由订单发出的 CDK：

```bash
cd /opt/openai-monitor
npm run cdk:expire -- --days=1 --only-delivered
```

## VPS systemd 定时运行

项目内已经提供：

- `deploy/systemd/openai-monitor-cdk-expire.service`
- `deploy/systemd/openai-monitor-cdk-expire.timer`

安装或更新到 VPS 后执行：

```bash
sudo cp /opt/openai-monitor/deploy/systemd/openai-monitor-cdk-expire.service /etc/systemd/system/
sudo cp /opt/openai-monitor/deploy/systemd/openai-monitor-cdk-expire.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openai-monitor-cdk-expire.timer
```

查看状态和日志：

```bash
sudo systemctl status openai-monitor-cdk-expire.timer --no-pager
sudo journalctl -u openai-monitor-cdk-expire.service -n 100 --no-pager
```
