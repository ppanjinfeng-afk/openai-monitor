# Ubuntu VPS 部署指南

当前默认部署方式：

- `server.js` 监听 `127.0.0.1:3000`
- `Nginx` 对外转发到 `127.0.0.1:3000`

这套最简单，适合你现在直接上线。  
注意：如果主后端 `3000` 掉线，公网会直接返回 `502`，不会显示维护页。

## 1. 项目目录

建议目录：

- `/opt/openai-monitor`

## 2. 安装环境

```bash
sudo apt update
sudo apt install -y curl git unzip build-essential python3 nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

## 3. 安装 Puppeteer 依赖

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

## 4. 拉取代码

```bash
cd /opt
sudo mkdir -p /opt/openai-monitor
sudo chown -R $USER:$USER /opt/openai-monitor
cd /opt/openai-monitor
git clone <你的仓库地址> .
```

## 5. 安装依赖

```bash
cd /opt/openai-monitor
npm install
npx puppeteer browsers install chrome
```

## 6. 数据库

如果仓库里已经带了 `data/monitor.db`，直接继续。  
如果没有，就单独把数据库放到：

- `/opt/openai-monitor/data/monitor.db`

## 7. 安装 systemd

```bash
sudo cp /opt/openai-monitor/deploy/systemd/openai-monitor.service /etc/systemd/system/
sudo cp /opt/openai-monitor/deploy/systemd/openai-monitor-healthcheck.service /etc/systemd/system/
sudo cp /opt/openai-monitor/deploy/systemd/openai-monitor-healthcheck.timer /etc/systemd/system/
sudo chmod +x /opt/openai-monitor/deploy/scripts/openai-monitor-healthcheck.sh
sudo systemctl daemon-reload
sudo systemctl enable --now openai-monitor
sudo systemctl enable --now openai-monitor-healthcheck.timer
```

检查：

```bash
sudo systemctl status openai-monitor --no-pager
sudo systemctl status openai-monitor-healthcheck.timer --no-pager
```

## 8. 安装 Nginx

```bash
sudo cp /opt/openai-monitor/deploy/nginx/openai-monitor.conf /etc/nginx/sites-available/openai-monitor.conf
sudo ln -sf /etc/nginx/sites-available/openai-monitor.conf /etc/nginx/sites-enabled/openai-monitor.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 9. 本机检查

```bash
curl http://127.0.0.1:3000/api/checks/status
curl -I http://127.0.0.1:3000/buy
```

## 10. HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d penqda.com -d www.penqda.com
```

## 11. 更新项目

```bash
cd /opt/openai-monitor
git pull origin main
npm install
sudo systemctl restart openai-monitor
sudo systemctl restart openai-monitor-healthcheck.timer
sudo systemctl reload nginx
```

## 12. 常用排查

```bash
sudo systemctl status openai-monitor --no-pager
sudo systemctl status openai-monitor-healthcheck.timer --no-pager
sudo systemctl status nginx --no-pager
journalctl -u openai-monitor -n 100 --no-pager
journalctl -u openai-monitor-healthcheck -n 50 --no-pager
curl http://127.0.0.1:3000/api/checks/status
```

## 14. 自动拉起说明

- `openai-monitor.service` 本身已经配置了 `Restart=always`
- 如果 Node 进程崩掉，systemd 会在 5 秒后自动拉起
- `openai-monitor-healthcheck.timer` 每分钟跑一次
- 如果发现 `http://127.0.0.1:3000/admin-login` 不通，或者服务卡在 `deactivating / stop-sigterm` 这类非 `active/running` 状态，会自动强制拉起 `openai-monitor`

## 13. 让 3000 端口支持账密登录

如果你想从其他电脑直接打开 `http://你的VPSIP:3000` 管理后台：

1. 修改 systemd 配置：

```bash
sudo nano /etc/systemd/system/openai-monitor.service
```

把这几行加到 `[Service]` 里：

```ini
Environment=BIND_HOST=0.0.0.0
Environment=ADMIN_BASIC_AUTH_ENABLED=true
Environment=ADMIN_BASIC_AUTH_USER=admin
Environment=ADMIN_BASIC_AUTH_PASS=change-this-password
```

2. 重载并重启：

```bash
sudo systemctl daemon-reload
sudo systemctl restart openai-monitor
```

3. 云服务器安全组放通：

- TCP `3000`

4. 然后在其他电脑浏览器打开：

- `http://你的VPSIP:3000`

浏览器会先弹出用户名/密码输入框，验证通过后才能进入后台。
