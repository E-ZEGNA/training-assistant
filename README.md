# 面试助教

内部培训用的 Windows 实时面试辅助工具。学生端只负责采集音频、提交本场补充包和展示答案；机密主线程包只保存在机构后端。

## 数据边界

- 主线程包：发布方通过管理接口写入，AES-256-GCM 加密落盘。学生接口没有读取能力。
- 补充包：学员每场开始时输入，只保存在服务端会话内存，结束或超时后清空。
- 转写与答案：只保存在当前服务端会话内存，不写客户端数据库或日志。
- 学员凭据：Windows `safeStorage` 加密保存；机构 API Key、ASR Key 和 LLM Key 不进入客户端。
- 激活绑定：激活码首次使用后绑定设备并记录公网 IP；后续请求校验 Token、设备和绑定状态，不因正常公网 IP 漂移失效。同一设备重新激活时会更新 IP 记录，不同设备仍会被拒绝。绑定数据只保存不可逆 HMAC，不保存原始设备标识或 IP。

## 本机启动

```powershell
npm install
npm --workspace server run setup:dev
npm --workspace server start
```

`setup:dev` 会生成 `server/.env` 和本机激活码。默认 `LLM_PROVIDER=codex-config`，运行时读取本机 Codex provider 地址和 token，直接调用 Responses API；模型使用 `gpt-5.6-sol`，推理档覆盖为 `low`。token 不会复制到项目配置或学生包。该模式仅用于发布方本机验证。

另开终端，从仓库外部文件上传主包并启动学生端：

```powershell
node --env-file=server/.env server/scripts/publish-master.mjs --file D:/secure/student-a-master.md --student-id student-a
npm --workspace student run dev
```

主包、主包密文、机构密钥、API Key 和本机 Codex token 均不得提交到代码仓库。

## 接入 Seed-ASR 2.0

在 `server/.env` 中设置：

```dotenv
STT_PROVIDER=seed-asr
SEED_ASR_API_KEY=<机构密钥>
SEED_ASR_RESOURCE_ID=volc.seedasr.sauc.duration
```

学生端通过随安装包分发的原生 Windows WASAPI 组件采集默认回放设备，转换并发送 PCM16、16kHz、单声道、200ms 音频包；麦克风按需单独采集。后端连接 Seed-ASR，并从主包和本场补充包生成有限热词。

## 发布配置

发布时使用机构专用模型 API：

```dotenv
LLM_PROVIDER=responses-api
LLM_BASE_URL=https://fushengyunsuan.cn/v1
LLM_API_KEY=<机构专用密钥，仅保存在服务端>
LLM_MODEL=gpt-5.6-sol
LLM_REASONING_EFFORT=low
```

构建 Windows 安装包和便携版：

```powershell
npm run test
npm run build:student
```

产物位于 `student/release/`。

## 后端容器

复制 `deploy/server.env.example` 为 `deploy/server.env`，填入机构密钥后运行：

```powershell
docker compose -f deploy/docker-compose.yml up -d --build
```

容器以非 root 用户运行，根文件系统只读，主包密文保存在 `interview-data` 卷。Compose 只监听本机 `127.0.0.1:8787`；对外发布时应在前面配置 HTTPS 反向代理，并将学生端服务地址设为公开 HTTPS 域名。

当前正式客户端地址为 `https://119.29.213.205`，地址内置于客户端且不会显示给学员。公网 Nginx 将 `443` 端口转发到服务器内部的 `127.0.0.1:8787`。

生产环境经本机 Nginx 反代时设置 `TRUST_PROXY=true`。Nginx 必须覆盖而不是透传 `X-Real-IP`，并禁止公网访问 `/v1/admin/`。参考配置见 `deploy/nginx-interview-assistant.conf.example`。

公网 IP 证书使用 Certbot 5.4+ 和 Let’s Encrypt `shortlived` profile 签发，有效期约 6 天，必须配置自动续期及 Nginx reload hook：

```bash
certbot certonly --webroot -w /www/wwwroot/interview-acme \
  --preferred-profile shortlived --ip-address 119.29.213.205
certbot renew --deploy-hook "/www/server/nginx/sbin/nginx -s reload"
```

管理员在服务器容器内管理学员绑定：

```bash
docker compose -f deploy/docker-compose.yml exec interview-server node scripts/manage-bindings.mjs list
docker compose -f deploy/docker-compose.yml exec interview-server node scripts/manage-bindings.mjs revoke student-1
docker compose -f deploy/docker-compose.yml exec interview-server node scripts/manage-bindings.mjs reset student-1
```

`revoke` 会立即让已有 Token 失效但保留占用；`reset` 会删除绑定，允许该学员在新的设备或 IP 上重新激活。`STUDENT_TOKEN_SECRET` 轮换后，已有 Token 和绑定均需重置。

发布前可分别验证真实模型和转写链路：

```powershell
npm --workspace server run smoke:llm
npm --workspace server run smoke:asr -- ../reports/interview-audio/q01-kubernetes.wav
```
