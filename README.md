# 面试助教

内部培训用的 Windows 实时面试辅助工具。学生端只负责采集音频、提交本场补充包和展示答案；机密主线程包只保存在机构后端。

## 数据边界

- 主线程包：发布方通过管理接口写入，AES-256-GCM 加密落盘。学生接口没有读取能力。
- 补充包：学员每场开始时输入，只保存在服务端会话内存，结束或超时后清空。
- 转写与答案：只保存在当前服务端会话内存，不写客户端数据库或日志。
- 学员凭据：Windows `safeStorage` 加密保存；机构 API Key、ASR Key 和 LLM Key 不进入客户端。

## 本机启动

```powershell
npm install
npm --workspace server run setup:dev
npm --workspace server start
```

`setup:dev` 会生成 `server/.env` 和本机激活码。默认 `LLM_PROVIDER=codex-config`，运行时读取本机 Codex provider 地址和 token，直接调用 Responses API；模型使用 `gpt-5.6-sol`，推理档覆盖为 `low`。token 不会复制到项目配置或学生包。该模式仅用于发布方本机验证。

另开终端，从仓库外部文件上传主包并启动学生端：

```powershell
node --env-file=server/.env server/scripts/publish-master.mjs --file D:/secure/master-pack.md
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
LLM_PROVIDER=api
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=<机构专用密钥>
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
