# Ubuntu VPS 部署指南

这套项目推荐在 Ubuntu VPS 上按下面结构运行：

- `server.js` 监听 `127.0.0.1:3000`
- `maintenance-gateway.js` 监听 `127.0.0.1:3001`
- `Nginx` 对外转发到 `127.0.0.1:3001`

这样主后端掉线时，公网不会直接看到 `502`，而是会显示项目里现成的维护页。

## 1. 准备上传文件

从当前电脑上传项目到 VPS 时：

- 一定要带上 `data/monitor.db`
- 不要带 `node_modules`
- 临时目录 `.tmp_*`、日志文件、截图文件可以不传

建议最终目录：

- `/opt/openai-monitor`

## 2. Ubuntu 安装基础环境

```bash
sudo apt update
sudo apt install -y curl git unzip build-essential python3 nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 3. 安装 Puppeteer 运行库

```bash
sudo apt install -y \
  ca-certificates \
  fonts-liberation \
  libasound2t64 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  xdg-utils
```

## 4. 上传项目并安装依赖

```bash
cd /opt
sudo mkdir -p /opt/openai-monitor
sudo chown -R $USER:$USER /opt/openai-monitor
cd /opt/openai-monitor
```

把你的项目文件上传到这个目录后执行：

```bash
cd /opt/openai-monitor
npm install
```

如果 Puppeteer 浏览器没有自动下载，再补一次：

```bash
npx puppeteer browsers install chrome
```

## 5. 关键数据确认

确认这些文件已经存在：

- `/opt/openai-monitor/data/monitor.db`
- `/opt/openai-monitor/public/maintenance.html`
- `/opt/openai-monitor/server.js`
- `/opt/openai-monitor/maintenance-gateway.js`

如果你没有带现成数据库，也可以先启动一次 `server.js` 让它自动建库；  
但这样账号、支付、Telegram、工作区等数据都不会自动带过去。

## 6. 先本机测试

### 启动主服务

```bash
cd /opt/openai-monitor
PORT=3000 BIND_HOST=127.0.0.1 node server.js
```

新开一个终端测试：

```bash
curl http://127.0.0.1:3000/api/checks/status
```

### 启动维护网关

```bash
cd /opt/openai-monitor
PUBLIC_GATEWAY_PORT=3001 PUBLIC_GATEWAY_ORIGIN_HOST=127.0.0.1 PUBLIC_GATEWAY_ORIGIN_PORT=3000 node maintenance-gateway.js
```

再测试：

```bash
curl -I http://127.0.0.1:3001/buy
```

## 7. 配置 systemd 开机自启

把下面两个模板复制到系统目录：

- `/etc/systemd/system/openai-monitor.service`
- `/etc/systemd/system/openai-monitor-gateway.service`

模板文件已经放在：

- `/opt/openai-monitor/deploy/systemd/openai-monitor.service`
- `/opt/openai-monitor/deploy/systemd/openai-monitor-gateway.service`

复制后执行：

```bash
sudo cp /opt/openai-monitor/deploy/systemd/openai-monitor.service /etc/systemd/system/
sudo cp /opt/openai-monitor/deploy/systemd/openai-monitor-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openai-monitor
sudo systemctl enable --now openai-monitor-gateway
```

查看状态：

```bash
sudo systemctl status openai-monitor --no-pager
sudo systemctl status openai-monitor-gateway --no-pager
```

查看日志：

```bash
journalctl -u openai-monitor -f
journalctl -u openai-monitor-gateway -f
```

## 8. 配置 Nginx

模板文件：

- `/opt/openai-monitor/deploy/nginx/openai-monitor.conf`

复制并启用：

```bash
sudo cp /opt/openai-monitor/deploy/nginx/openai-monitor.conf /etc/nginx/sites-available/openai-monitor.conf
sudo ln -sf /etc/nginx/sites-available/openai-monitor.conf /etc/nginx/sites-enabled/openai-monitor.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 9. 配置域名

如果你的域名还是 `penqda.com / www.penqda.com`：

- 把 `A` 记录指向 VPS 公网 IP
- Nginx 监听这两个域名

如果你继续使用 Cloudflare：

- `A` 记录仍指向 VPS IP
- 可以开橙云代理
- 不再需要 Windows 上那套 `cloudflared tunnel`

## 10. 配置 HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d penqda.com -d www.penqda.com
```

## 11. 验证 24 小时运行

```bash
systemctl is-active openai-monitor
systemctl is-active openai-monitor-gateway
curl -I http://127.0.0.1:3000/
curl -I http://127.0.0.1:3001/
curl -I https://penqda.com/
```

## 12. 推荐上线方式

推荐按这个顺序：

1. 先上传项目和数据库
2. 本机测试 `3000`、`3001`
3. 配好 `systemd`
4. 配好 `nginx`
5. 最后切域名

## 13. 更新项目

以后更新代码时：

```bash
cd /opt/openai-monitor
npm install
sudo systemctl restart openai-monitor
sudo systemctl restart openai-monitor-gateway
```

## 14. 常见问题

### 启动后 Puppeteer 报库缺失

重新安装第 3 步的依赖，然后重启服务。

### `maintenance-gateway.js` 启动失败

通常是 `data/monitor.db` 不存在。先确认数据库已经带过去，或者先启动一次主服务建库。

### 主站正常但公网打不开

优先检查：

- `sudo systemctl status nginx`
- `sudo systemctl status openai-monitor`
- `sudo systemctl status openai-monitor-gateway`
- 域名 DNS 是否已经指向 VPS

