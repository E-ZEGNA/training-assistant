# 中文面试 ASR 选型记录

评估时间：2026-08-09。目标场景是普通话为主、夹杂英文缩写和技术专有名词的实时面试。

## 当前结论

主链路选择火山引擎 Seed-ASR 2.0 流式接口。它不一定在所有公开数据集上都是绝对最低 CER，但在本项目最关键的四项上组合最完整：中文与英文混说、动态热词、低延迟双向流、官方托管服务。

- 端点：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`
- 资源：`volc.seedasr.sauc.duration`
- 音频：PCM16、16kHz、单声道、约 200ms 一包
- 热词：后端从主包和本场补充包生成，按约 90 token 截断
- 二遍识别：启用 `enable_nonstream`，兼顾实时首字与最终准确率

学生端不持有火山密钥，也不直接连接火山。后端统一处理协议、热词、重连、缓冲和错误状态，因此原来依赖学员机器配置的豆包转写链路被移除。

## 对照模型

| 模型 | 优点 | 当前不作为主链路的原因 |
| --- | --- | --- |
| Fun-ASR-Nano-2512 | 约 800M，支持中英日、方言口音、动态热词和实时 WebSocket，可自部署 | 需要机构维护推理服务和 GPU/CPU 容量，首版运维成本更高 |
| Qwen3-ASR-1.7B | 开源流式准确率强，公开 Fleurs-zh streaming WER 约 2.84 | 未确认动态热词能力，技术名词可控性弱于当前方案 |
| FireRedASR2 | 公开普通话测试平均 CER 约 2.89%，准确率有竞争力 | 官方主要验证 Linux，实时服务和 Windows 发行链路不够成熟 |
| Whisper 系列 | 生态成熟、可离线 | 中文夹英文技术词、实时延迟和热词控制不是本场景最佳组合 |

备用路线保留 Fun-ASR-Nano-2512。机构规模扩大或对第三方服务依赖不可接受时，可在后端增加相同会话接口的 Fun-ASR provider，不需要修改学生端。

## 上线前语料门槛

不能只用公开普通话数据集定案。正式切换 Seed-ASR 前，至少用 100 段真实或脱敏面试音频做盲测：

1. 中文 CER、英文 WER。
2. 技术专有名词准确率，单独统计 Kubernetes、CUDA、NCCL、OpenTelemetry 等词。
3. 首个稳定文本延迟、最终文本延迟和 30 分钟断线次数。
4. 安静房间、扬声器外放、蓝牙耳机、网络抖动四类环境。
5. 关闭热词、补充包热词、主包加补充包热词三组对照。

验收建议：技术词准确率不低于 95%，首个稳定文本 P95 小于 900ms，30 分钟会话无不可恢复断流。

## 资料

- 火山引擎流式语音识别文档：<https://www.volcengine.com/docs/6561/1354869>
- Seed-ASR SAUC 协议整理：<https://github.com/GizClaw/doubao-speech-go/blob/main/docs/streaming_asr.md>
- Fun-ASR：<https://github.com/QwenAudio/Fun-ASR>
- Qwen3-ASR：<https://github.com/QwenLM/Qwen3-ASR>
- FireRedASR：<https://github.com/FireRedTeam/FireRedASR>
