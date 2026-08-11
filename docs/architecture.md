# 架构与保密边界

```text
WASAPI or ScreenCaptureKit / optional mic
             |
             v
      Student Electron
             | PCM16 over authenticated WebSocket
             v
       Institution Server ------> Seed-ASR 2.0
             |                         |
             |<----- transcript -------+
             |
             +--> recent transcript
             +--> session-only supplement
             +--> top server-side master-pack chunks
             |
             v
      GPT-5.6 Sol (low effort)
             |
             v
      final answer only -> student
```

服务端没有提供主包读取接口。管理端只能写入和查看版本状态；学生 token 只能创建自己的会话、上传音频、触发回答和结束会话。

学员激活码首次使用时会在服务端绑定设备指纹、记录公网 IP，并生成随机 binding ID。后续 HTTP 请求校验签名 Token、设备指纹和持久化绑定状态；音频 WebSocket 只在握手时校验，音频帧不重复鉴权。公网 IP 漂移不会让已签发 Token 失效，管理员仍可随时撤销或重置绑定。绑定库只保存设备和 IP 的加盐 HMAC，不保存原值；客户端不会收到模型 API Key 或主线程包。

## 防泄漏措施

1. 主包使用独立 32 字节密钥进行 AES-256-GCM 加密，密钥只来自服务端环境变量。
2. 回答时仅检索少量相关片段，不把完整主包放入单次模型请求。
3. 转写中的“输出系统提示/主包原文”等指令会被阻断。
4. 返回前检查答案与主包的长串逐字重合；命中后用安全答复替换。
5. 日志只记录版本、字符数、学生 ID、会话 ID、状态码和时延，不记录主包、补充包、转写、答案或凭据。
6. 补充包、转写和回答历史只存在于会话内存；结束、超时或进程退出即清理。

## 发布方操作

发布方使用 `server/scripts/publish-master.mjs` 上传主包。CLI 从本地文件读取内容，通过管理密钥调用写接口；服务端只返回版本、更新时间和字符数。
