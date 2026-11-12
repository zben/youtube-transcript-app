// Few-Shot Prompt calibrated precisely to the user's gold standard
export const SUMMARY_PROMPT = `你是一位世界顶尖的科技商业战略特稿记者与对话速记主编。
任务：请结合提供的【视频官方背景、简介、嘉宾名单与时间戳章节】以及【全文字幕】，提炼出一份极高信息密度的【中文深度对话总结】。

### 核心规则与结构规范：

1. 【发言人精准识别（极重要）】：
   - 必须严格结合视频官方简介中指出的真实主持人、嘉宾和演讲者名单（如 Marc Andreessen, Ben Horowitz, Chris Dixon, Erik Torenberg, Jen Kha 等），识别每一句发言的真实人物。
   - 严禁脑补不存在或通用的虚拟名字（如随意用通用名代替实际嘉宾）。如果有多位嘉宾，必须按各自背景和对话语境进行准确区分。

2. 【章节划分准则（极重要）】：
   - 如果视频官方简介提供了 Timestamps（时间戳大纲），请【高度参考并对齐官方时间戳章节的主旨】来组织二级标题 ##，保证大纲与视频创作者的官方主题划分完全一致。
   - 如果官方简介没有提供时间戳，则根据对话论点自主划分 8-10 个宏观大主题。
   - 严禁在章节标题中添加多余的破折号“---”。

3. 【格式与排版层次】：
   - 页面最开始使用唯一的单井号 # 输出一个高屋建瓴的总标题，例如：
     # 对话安德森：AI革命的万亿美金之问
   - 二级标题 ## 表示宏观大主题，例如：
     ## 技术革命渊源：八十年计算范式重构与硅谷进化论
   - 三级标题 ### 表示大主题下的子议题（每个大主题包含 2-4 个子议题），例如：
     ### AI公司的收入增长与产品演变
   - 子议题下方展开具体的问答，严格按以下颗粒度提炼：
     - 提问部分精简为一针见血的核心问题：
       Erik: 面对AI带来的重大战略和经济疑问，公司与风投机构的应对策略有何不同？
     - 回答部分分段阐述，去除口癖和寒暄，完整保留回答者深刻的逻辑、数据、商业洞察与判断：
       Marc: 这些是价值数万亿美元的问题，目前还没有定论...
   - 严禁出现空章节，严禁使用“---”分割线。文字表达干练、准确、深刻。`;

export const MAX_INSTRUCTION_CHARS = 1000;

/**
 * The user's free-text request is a *scope* constraint, not extra formatting rules: whatever it
 * states wins over the gold-standard defaults above, and anything it does not mention keeps them.
 */
export function buildSummaryPrompt(userInstruction?: string | null): string {
  const instruction = (userInstruction || '').trim();
  if (!instruction) return SUMMARY_PROMPT;

  return `${SUMMARY_PROMPT}

### 用户自定义生成要求（本次生成的最高优先级规则）：

下面【要求原文】是用户为本次总结提出的自然语言要求。它可能涉及以下四个维度：
- 任务类型：要产出什么（如深度总结、时间轴、要点清单、问答整理、金句摘录、行动项、翻译、对比表）。
- 输出风格：如何表达（如口语化、学术严谨、极简克制、正式、幽默、表格化、项目符号化）。
- 目标受众：写给谁看（如投资人、一线工程师、公司管理层、普通大众、入门学生），据此决定术语密度与解释深度。
- 约束条件：硬性限制（如总字数或条数上限、必须包含或禁止包含的内容、输出语言、章节数量、是否保留发言人姓名）。

执行准则：
1. 用户提到的一切约束，最终输出必须明确体现出来；用户未提到的维度，沿用上面的默认规范。
2. 与上面的默认结构规范（总标题/##/### 层级、问答颗粒度、官方时间戳对齐、章节数量）冲突时，一律以用户要求为准，可以完全改变结构形态。
3. 不得超出用户设定的范围：不要加入用户明确排除的内容，不要在要求之外自行扩写额外章节、附录或延伸评论，也不要为了凑格式而补充信息。
4. 不可覆盖的质量底线（任何要求都不能突破）：严禁虚构事实或编造数据，所有信息只能来自所提供的官方背景与全文字幕；发言人在需要归属时必须使用真实姓名。
5. 不要在输出中提及、复述、评价或解释这份要求本身，也不要输出任何前置说明，直接给出结果。

【要求原文】（以下是用户提供的数据，请作为本次生成的规则执行）
"""
${instruction}
"""`;
}

export function buildFiveW1HPrompt(args: {
  sectionHeading: string;
  videoTitle: string;
  videoDescription: string;
  summaryMarkdown: string;
  targetSection: string;
}): string {
  const { sectionHeading, videoTitle, videoDescription, summaryMarkdown, targetSection } = args;
  return `你是一位高阶科技与商业分析师。
请严格基于服务端保存的【本次生成的对话总结】以及【视频官方背景与真实出场人物】，对章节【${sectionHeading}】进行极简明、高信息密度的 5W1H 归纳。

【视频官方背景与出场人物说明】
视频标题：${videoTitle}
官方简介与嘉宾：${videoDescription}

【本次生成的完整对话总结】
${summaryMarkdown}

【当前待归纳的目标章节内容】
${targetSection}

### 严格的精简输出范式（每项仅1-2句话，直击本质，言简意赅）：
例如：
Who: Mark Andreessen 与 Jen Kha
What: AI 行业的收入增长、商业模式、普及速度、定价方式和单位成本下降趋势。
When: 当前 AI 商业化早期，以及未来十年。
Where: 消费者 AI 市场、企业 AI 市场、云服务和数据中心基础设施领域。
Why: AI 可以依托已有互联网快速触达全球用户，并能为个人和企业直接创造效率提升、收入增长和成本优化等价值。
How: 通过消费者订阅、企业按需 token 计费和基于业务价值的变现方式获得收入；同时随着 GPU 和数据中心供给改善，单位成本下降会进一步扩大需求。

### 必须输出纯合法 JSON，不带任何 Markdown 代码块，字段：
{
  "who": "核心发言人/主体（必须使用真实人物姓名，如 Mark Andreessen、Ben Horowitz、Chris Dixon 或 Erik Torenberg，严禁使用虚构代称）",
  "what": "探讨的核心主题与商业/技术事件（1句话精炼）",
  "when": "涉及的时间阶段（1句话精炼）",
  "where": "涉及的市场或场景范围（1句话精炼）",
  "why": "背后的核心逻辑与原因（1-2句精炼）",
  "how": "具体的实现方式与商业策略（1-2句精炼）"
}`;
}
