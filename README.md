# 初中生错题本工作台

面向福州初中生的错题收集与复习工作台，纯静态响应式 Web App（手机 / iPad / 笔记本通用）。
线上地址：https://cjwx-bot.github.io/cuoti-workbench/

## 功能
- 错题库：拍照/相册选图录入、增删改查、难度/错因筛选、关键词搜索
- 题干 HTML 富文本：支持加粗/斜体/上下标/标红，可直接粘贴带格式的题目；分数以上下结构呈现
- 视觉大模型 OCR（推荐）：接入 SiliconFlow 视觉模型（Qwen3-VL-8B / GLM-4.1V，免费），能正确识别分数、根号等数学版式，识别后自动填入题干。需在 cloud.siliconflow.cn 免费注册获取 API Key，填入页面「API Key」框（仅存本机）。照片会上传到 SiliconFlow。
- 普通云端 OCR：OCR.space 识别纯文字（不支持分数），照片上传第三方
- 公共题库：从仓库只读 questions.json 加载示例题，一键加入本机错题库
- 错因统计 / 组卷重练 / JSON 导入导出（数据存浏览器本地）

## 隐私说明
- 学生错题数据默认存本机浏览器，不上传服务器，不含姓名/班级等个人信息
- 两种 OCR 均为可选功能，使用时照片会上传到对应第三方（SiliconFlow / OCR.space），首次使用有知情同意
- API Key 不写入源码，自填 Key 仅存本机 localStorage
- 题干富文本做白名单清洗，防脚本注入
