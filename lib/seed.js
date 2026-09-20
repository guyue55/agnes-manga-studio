/**
 * seed.js — 首次运行的默认数据
 * ------------------------------------------------------------------
 * 只做一件事：给「提示词模板」铺一批能直接用的底子。
 * 原版模板表建了但界面没做，本地版把它补上了 —— 模板集中管理后，
 * 改提示词不用再翻代码。
 *
 * 模板里的 {{变量}} 由前端按 template_type 渲染成输入框。
 */
'use strict';

const { digestText } = require('./story.js');

/**
 * 内置提示词的历史内容指纹（批 8 补 28）——**"这一行是不是我们发出去的那一版"**。
 *
 * 为什么要它：`seedTemplates` 原来只写"库里没有的 key"，于是**改代码里的提示词对老用户完全无效** ——
 * 提示词是抽取质量最大的杠杆（要抽什么、怎么写、什么不许写全靠它），可它的改进永远到不了已经装过的人手里，
 * 而且没有任何提示。本项目每一轮都在改提示词，这个洞会一直吞掉改进。
 *
 * 安全边界：**绝不覆盖用户改过的模板**。判据是"内容指纹能证明它还是我们发的那一版"：
 *   ① 行上的 `builtin_digest` 等于它自己的内容指纹（我们上次写进去的就是这个）；
 *   ② 或内容指纹在本表的历史列表里（这个表就是给"本机制上线之前装的库"准备的 —— 那时行上还没有 digest 字段）。
 * 两条都不满足 → 一律**当成用户改过**，保留不动（宁可漏更新，也不覆盖人的劳动）。
 *
 * 维护约定：**改了某个内置模板的 content/system，就把它的旧内容指纹追加到这里，并 bump 它的 builtin_version。**
 * 旧指纹用 `node -e "console.log(require('./lib/story.js').digestText(旧内容))"` 算。
 */
const TEMPLATE_SUPERSEDED = {
  novel_extract: ['590134ed', '04ec3962'],
  story_bible: ['20ae1846'],
};

const DEFAULT_TEMPLATES = [
  {
    key: 'story_concept',
    name: '故事构思 · 爽文漫剧',
    template_type: 'story_concept',
    system: '你是专业的AI短视频漫剧编剧，擅长创作适合抖音、快手等平台的爽点密集型漫剧。请用中文回答，并按要求的 JSON 字段返回。',
    content: [
      '请根据以下信息生成漫剧故事构思，用JSON格式返回，字段：',
      'one_liner(一句话故事)、selling_points(故事卖点数组)、protagonist_goal(主角目标)、',
      'core_conflict(核心冲突)、antagonist(反派阻碍)、satisfaction_points(爽点设计数组)、hook(结尾钩子)。',
      '',
      '题材: {{题材}}',
      '主角身份: {{主角身份}}',
      '金手指: {{金手指}}',
      '核心冲突: {{核心冲突}}',
      '爽点方向: {{爽点方向}}',
      '目标平台: {{目标平台}}',
      '单集时长: {{单集时长}}',
      '风格要求: {{风格要求}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '生成一句话故事、卖点、爽点设计与结尾钩子',
  },
  {
    key: 'plot_summary',
    name: '剧情梗概',
    template_type: 'plot_summary',
    system: '你是专业的AI短视频漫剧编剧。请用中文回答，并按要求的 JSON 字段返回。',
    content: [
      '请根据故事想法生成剧情梗概，用JSON格式返回，字段：',
      'summary_short(300字梗概)、summary_long(800字梗概)、season_direction(分季方向)、',
      'conflict_lines(主要冲突线数组)、foreshadowing(暗线伏笔)、emotional_arc(情绪递进)。',
      '',
      '故事想法: {{故事想法}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '300 字 / 800 字双版本梗概 + 暗线伏笔',
  },
  {
    key: 'episode_outline',
    name: '分集大纲',
    template_type: 'episode_outline',
    system: '你是专业的AI短视频漫剧编剧。请用中文回答，返回 JSON 数组。',
    content: [
      '请根据剧情梗概生成分集大纲，用JSON数组格式返回，每集包含：',
      'episode(集数)、title(标题)、core_conflict(核心冲突)、plot(剧情简述)、satisfaction(爽点)、hook(结尾钩子)。',
      '',
      '剧情梗概: {{剧情梗概}}',
      '目标集数: {{目标集数}}集',
      '单集时长: {{单集时长}}',
      '每集留钩子: {{每集留钩子}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '按集数拆出冲突、爽点、钩子',
  },
  {
    key: 'episode_script',
    name: '单集脚本',
    template_type: 'episode_script',
    system: '你是专业的AI短视频漫剧编剧。请用中文回答，返回 JSON 数组。',
    content: [
      '请根据集大纲生成单集完整脚本，用JSON数组格式返回，每个镜头包含：',
      'shot_number(编号)、shot_type(景别)、scene_description(画面描述)、action(人物动作)、',
      'dialogue(台词)、narration(旁白)、sound_effect(音效)、duration_seconds(时长秒)、emotion_goal(情绪目标)。',
      '',
      '本集大纲: {{本集大纲}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '镜头级脚本，含景别、台词、音效、情绪目标',
  },
  {
    key: 'storyboard_script',
    name: '分镜脚本',
    template_type: 'storyboard_script',
    system: '你是专业的AI漫剧分镜导演。请用JSON数组格式返回分镜表，每个镜头必须包含所有字段，英文图片/视频提示词要专业、详细。提示词只写镜头内容（主体、动作、构图、局部光效），不要写整体画风或媒介词——画风由系统在使用点统一注入。',
    content: [
      '请将以下脚本转换为分镜脚本，用JSON数组格式返回，每个镜头包含：',
      'shot_number(编号)、shot_type(景别)、scene_description(画面描述)、characters(出场人物)、',
      'action(人物动作)、dialogue(台词)、narration(旁白)、sound_effect(音效)、duration_seconds(时长)、',
      'image_prompt(英文图片生成提示词，风格统一、细节丰富)、video_prompt(英文视频生成提示词，描述运动和镜头)。',
      '',
      '脚本内容: {{脚本内容}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '一次产出图片提示词与视频提示词',
  },
  // ── 批 8：原著解析（小说/故事 → 结构化卡片）──
  // 两段式：先按块抽取卡片（novel_extract），再全局归并出信息卡与剧情卡（story_bible）。
  // 竞品对照：04 号包只有一次调用、只抽 name/identity/mainPlot 三个字段且原文截断 1 万字；
  // 这里拆成"分块 map + 全局 reduce"，长篇才可能被真正读完。
  {
    key: 'novel_extract',
    builtin_version: 3,
    name: '原著解析 · 分块抽取',
    template_type: 'novel_extract',
    system: '你是资深的漫剧改编策划与剧本分析师。你只做信息抽取与归档，不做创作、不写剧本、不改写原文。严格按要求的 JSON 返回，不要输出 JSON 以外的任何文字、解释或代码块标记。',
    content: [
      '下面是一部长篇作品中的第 {{段落序号}} 段（共 {{段落总数}} 段）。请通读本段，抽取其中**明确出现**的设定信息。',
      '',
      '严格要求：',
      '1. 只抽本段文字里真实出现的内容；读不出来就少抽或不抽，**禁止推测、禁止补充常识、禁止编造名字**。',
      '2. 同一实体在别段出现是正常的，本段有多少抽多少，不用去重（系统会跨段合并）。',
      '3. 人物卡的 gender(性别)、age(年龄段)、appearance(外貌/衣着)、outfit(常穿服饰) 与 personality(性格)',
      '   是后续所有分镜保持一致的关键，原文有描写就必须抽全（age 写"少年/青年/中年/老年"这类年龄段即可）。',
      '4. name 用原文的称呼（不要加书名号/引号）；summary 用一句话概括，不要复述原文长句。',
      '5. 剧情卡按本段内的**事件顺序**排列，stage 填"起/承/转/合"中最贴切的一个。',
      '6. 剧情卡的 involved 只写**本段里出现过的人物本名**，多个用顿号分隔（如"林晚、顾寒"）；',
      '   不要写泛称（"众人""少女""女主"）、不要写代称、不要加括号说明 —— 系统要按名字把它们和人物卡对上。',
      '   本段没有明确人物就留空字符串，不要编。',
      '7. 地点卡的 region(地域)、time_of_day(常见时间或光线)、道具卡的 features(外观与材质) 会**直接进画面描述**，',
      '   是"同一个地方/同一件东西在不同镜头里长得一样"的关键；原文有就照原文写，没有就留空，不要为了填满而编造。',
      '   时间线卡的 order_note 写"与前后事件的先后关系"（如"在夜访之前"），原文没写先后就留空。',
      '',
      '返回 JSON：{"cards":[',
      '{"kind":"character","name":"人物名","aliases":["别名"],"role":"主角/配角/反派/龙套","identity":"身份","gender":"性别","age":"年龄段","appearance":"外貌衣着","outfit":"常穿服饰","personality":"性格","summary":"一句话"},',
      '{"kind":"location","name":"地点名","atmosphere":"氛围","region":"地域","time_of_day":"常见时间或光线","features":"特征","summary":"一句话"},',
      '{"kind":"prop","name":"道具名","owner":"持有者","usage":"用途","features":"外观与材质","summary":"一句话"},',
      '{"kind":"plot","name":"事件名","stage":"起/承/转/合","conflict":"冲突","turn":"转折","outcome":"结果","involved":"涉及人物","summary":"一句话"},',
      '{"kind":"world","name":"设定名","genre":"题材","tone":"基调","worldview":"世界观","summary":"一句话"},',
      '{"kind":"timeline","name":"时间节点名","when":"时间","order_note":"与前后事件的先后关系","summary":"一句话"}',
      ']}',
      '',
      '没有可抽内容的类别就不要出现在数组里；本段一条都没有就返回 {"cards":[]}。',
      '',
      '本段原文：',
      '{{原文段落}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '原著解析 · 每个文本块调用一次；由「故事脚本 → 原著解析」页自动批量执行',
  },
  {
    key: 'story_bible',
    builtin_version: 2,
    name: '原著解析 · 全局归并',
    template_type: 'story_bible',
    system: '你是资深的漫剧改编策划。你只做归纳与排序，不做创作、不新增设定、不改写人物。严格按要求的 JSON 返回，不要输出 JSON 以外的任何文字、解释或代码块标记。',
    content: [
      '下面是系统从整部作品中抽取并**已跨段合并**的卡片清单，以及作品的开头与结尾原文。',
      '请据此归纳出整部作品的信息卡与剧情主线，并**只使用清单里已有的名字**。',
      '',
      '严格要求：',
      '1. 人物名/地点名一律用清单里的写法，不得改名、不得合并两个不同的人、不得新增清单外的人。',
      '   plots 里的 involved 同样只能写清单里已有的人物本名，多个用顿号分隔；不要写泛称或代称。',
      '2. plots 按故事实际发生顺序排列，6〜12 条，每条对应一个明确的转折或推进；不要按"第几章"分段。',
      '3. mainline 讲清"主角是谁、想要什么、最大的阻碍是什么、结局走向"，200 字以内。',
      '4. 只输出归纳结论，不要复述清单。',
      '',
      '返回 JSON：',
      '{"world":{"name":"作品名或「未命名」","genre":"题材","tone":"整体基调","worldview":"世界观与规则","theme":"主题","logline":"一句话故事","mainline":"主线摘要"},',
      ' "plots":[{"name":"事件名","stage":"起/承/转/合","conflict":"冲突","turn":"转折","outcome":"结果","involved":"清单里的本名、本名","summary":"一句话"}]}',
      '',
      '【已抽取的卡片清单】',
      '{{卡片清单}}',
      '',
      '【作品开头】',
      '{{开头}}',
      '',
      '【作品结尾】',
      '{{结尾}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '原著解析 · 全部文本块抽完后调用一次，产出信息卡与剧情卡',
  },
  {
    key: 'card_inject',
    builtin_version: 1,
    name: '原著解析 · 补场景道具字段',
    template_type: 'card_inject',
    system: '你是资深的漫剧美术设定，但这一趟**只做一件事**：回到原文片段里找出这张地点卡/道具卡上缺失的那些字段。你不创作、不新增设定、不猜测。原文片段里没有写到的，一律用 found=false 如实说"没写"，绝不为了填满而编造。严格按要求的 JSON 返回，不要输出 JSON 以外的任何文字、解释或代码块标记。',
    content: [
      '下面是一份卡片清单（地点卡或道具卡），每张都附上了**它自己那段原文片段**，并写明了**这张卡要补哪几个字段**。',
      '请只从给出的片段里找出这些字段的内容。',
      '',
      '字段含义：',
      '- 地点卡：氛围（整体感觉：喧闹潮湿/肃杀冷清…）、地域（在哪：临江/北境…）、时段（什么时候：黄昏/深夜…）、特征（看得见的细节：雕花木窗、满地落叶…）；',
      '- 道具卡：持有者（在谁手上）、用途（用来做什么）、特征（看得见的样子：青铜、缺了一角…）。',
      '',
      '三条硬要求：',
      '1. **必须给出原文里的原话**（quote 字段）作为依据 —— 一字不改地照抄片段里的那几个字。',
      '   我们会把 quote 与原文片段逐字比对：**对不上的一律丢弃**，所以不要改写、不要拼接、不要用同义词替换。',
      '2. 片段里**确实没写**的，就返回 found=false（这是正确的答案，不是失败）。',
      '   宁可说没写，也不许凭名字想象一个 —— 编出来的描述会进每一次出图提示词，',
      '   而它和写对的在界面上长得一模一样。',
      '3. **只填这张卡列出的字段键名**（键名已在清单里给出，不要自己加字段、不要填别的卡要的字段）。',
      '   只写片段里**明确提到**的，不要写剧情、人物命运，也不要写"画风""镜头"这类画面指令。',
      '',
      '每个字段写一小句，简洁、具体、可直接用于出图。至少填一项；列出的字段片段里都没写就 found=false。',
      '',
      '返回 JSON（index 用清单里给的编号，键名用那张卡列出的键名）：',
      '{"fills":[{"index":1,"found":true,"atmosphere":"…","region":"…","time_of_day":"…","features":"…","quote":"原文里的原话"},{"index":2,"found":false}]}',
      '',
      '【卡片与原文片段】',
      '{{卡片与原文片段}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '原著解析 · 给"没有任何可注入描述"的地点卡/道具卡回原文补字段，一次调用；引文对不上就丢弃',
  },
  {
    key: 'timeline_when',
    builtin_version: 1,
    name: '原著解析 · 补时间点',
    template_type: 'timeline_when',
    system: '你是资深的漫剧编剧，但这一趟**只做一件事**：回到原文片段里找出这个时间节点**发生的时间**。你不创作、不推算、不换算、不猜测。片段里没有写时间的，一律用 found=false 如实说"没写"，绝不为了填满而编造或推算。严格按要求的 JSON 返回，不要输出 JSON 以外的任何文字、解释或代码块标记。',
    content: [
      '下面是一份时间线卡清单，每张都附上了**它自己那段原文片段**，并写明了要补的字段（when = 时间点）。',
      '请只从给出的片段里找出**这个节点**发生的时间。',
      '',
      '三条硬要求：',
      '1. **必须给出原文里的原话**（quote 字段）作为依据 —— 一字不改地照抄片段里的那几个字。',
      '   我们会把 quote 与原文片段逐字比对：**对不上的一律丢弃**，所以不要改写、不要拼接、不要用同义词替换。',
      '2. **quote 必须是"时间点"那几个字所在的句子**，不要拿片段里别的句子充数。',
      '   同一段里可能写了不止一个时间（既有"三年前"又有"次日"），认错是哪一句就算错 ——',
      '   时间点会当正史进剧本提示词，写错了和写对的在界面上长得一模一样。',
      '3. 片段里**确实没写时间**，就返回 found=false（这是正确的答案，不是失败）。',
      '   宁可说没写，也不许推算 —— 不要从人物年龄、剧情顺序或别的卡片倒推一个时间出来。',
      '',
      '写法：照原文的说法写（"三年前"、"次日清晨"、"第三天黄昏"…），**不要**换算成具体日期，**不要**补全成"第 N 天"。',
      '',
      '返回 JSON（index 用清单里给的编号）：',
      '{"whens":[{"index":1,"found":true,"when":"三年前","quote":"原文里的原话"},{"index":2,"found":false}]}',
      '',
      '【时间线卡与原文片段】',
      '{{时间线卡与原文片段}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '原著解析 · 给"没有时间点"的时间线卡回原文补 when，一次调用；引文对不上就丢弃，绝不推算',
  },
  {
    key: 'char_look',
    builtin_version: 1,
    name: '原著解析 · 补人物长相',
    template_type: 'char_look',
    system: '你是资深的漫剧编剧，但这一趟**只做一件事**：回到原文片段里找出这个人物的外貌与服装。你不创作、不新增设定、不猜测。原文片段里没有写到的，一律用 found=false 如实说"没写"，绝不为了填满而编造。严格按要求的 JSON 返回，不要输出 JSON 以外的任何文字、解释或代码块标记。',
    content: [
      '下面是一份人物清单，每个人都附上了**他/她自己那段原文片段**。',
      '请只从给出的片段里找出这个人物的**外貌**与**服装**。',
      '',
      '三条硬要求：',
      '1. **必须给出原文里的原话**（quote 字段）作为依据 —— 一字不改地照抄片段里的那几个字。',
      '   我们会把 quote 与原文片段逐字比对：**对不上的一律丢弃**，所以不要改写、不要拼接、不要用同义词替换。',
      '2. 片段里**确实没写**外貌或服装的，就返回 found=false（这是正确的答案，不是失败）。',
      '   宁可说没写，也不许凭名字、身份或常见印象编一个 —— 编出来的长相会进每一次出图提示词，',
      '   而它和写对的长相在界面上长得一模一样。',
      '3. 只写片段里**明确提到**的：外貌（年纪、身形、面容、发型、气质…）与服装（衣着、配饰、随身之物…）。',
      '   不要写性格、身份、命运这类片段里没写的东西，也不要写"画风""镜头"这类画面指令。',
      '',
      '每项写一句话，简洁、具体、可直接用于出图（例如「约二十岁，清瘦，长发以木簪束起，眉眼冷淡」）。',
      'appearance 与 outfit 至少填一项；两项片段里都没写就 found=false。',
      '',
      '返回 JSON（index 用上面给的编号）：',
      '{"looks":[{"index":1,"found":true,"appearance":"…","outfit":"…","quote":"原文里的原话"},{"index":2,"found":false}]}',
      '',
      '【人物与原文片段】',
      '{{人物与原文片段}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '原著解析 · 只给"既没有外貌也没有服装"的人物卡回原文补长相，一次调用；引文对不上就丢弃',
  },
  {
    key: 'plot_stage',
    builtin_version: 1,
    name: '原著解析 · 补分幕次',
    template_type: 'plot_stage',
    system: '你是资深的漫剧编剧，但这一趟**只做结构判断**：把已经列好的剧情拍点分到「起/承/转/合」四幕。你不创作、不新增情节、不改写拍点内容、不改人名。严格按要求的 JSON 返回，不要输出 JSON 以外的任何文字、解释或代码块标记。',
    content: [
      '下面是按**原文顺序**排好的剧情拍点（编号从 1 开始）。其中一部分已经由人定好了幕次（标着「已定」），',
      '其余还没有幕次（标着「待定」）。请为**每一个**编号判断它属于四幕中的哪一幕。',
      '',
      '四幕的含义：',
      '- 起：铺垫与建立 —— 人物登场、日常状态、目标或麻烦出现；',
      '- 承：发展与升级 —— 冲突展开、阻碍加码、关系变化、代价变大；',
      '- 转：转折与高潮 —— 真相揭开、形势反转、最危急或最意外的时刻；',
      '- 合：收束与结局 —— 问题解决、结局落定、余波。',
      '',
      '严格要求：',
      '1. stage 只能取「起」「承」「转」「合」四个字之一，**每个编号都要给**，不要留空、不要写别的词。',
      '2. 标着「已定」的幕次是**人定好的，必须原样保持不变**；你只需要判断标着「待定」的那些。',
      '3. 按编号顺序，整串幕次**不能倒退**（起 → 承 → 转 → 合 只能往前走，可以停在同一幕）。',
      '   这是硬要求：分集是靠幕次收口的，幕次来回跳会让分集在错误的位置切开。',
      '4. 不要平均分配。一幕可以只有一拍、也可以有很多拍 —— 按故事本身的结构判断。',
      '5. 只输出 JSON，不要复述拍点、不要解释理由。',
      '',
      '返回 JSON（index 用上面给的编号）：',
      '{"stages":[{"index":1,"stage":"起"},{"index":2,"stage":"承"}]}',
      '',
      '【剧情拍点（按原文顺序）】',
      '{{拍点清单}}',
    ].join('\n'),
    negative_prompt: '',
    notes: '原著解析 · 只给"还没标幕次"的剧情拍点补分幕次，一次调用；绝不覆盖已有的幕次',
  },
  {
    key: 'image_prompt',
    name: '分镜图片提示词',
    template_type: 'image_prompt',
    system: '你是专业的AI漫剧分镜图提示词工程师，请生成适合图像生成的英文提示词，风格统一，细节丰富。只输出提示词本身，不要解释。',
    content: '为以下分镜生成英文图片提示词（只写镜头内容，不写整体画风）：景别:{{景别}}，画面:{{画面描述}}，人物:{{人物}}，动作:{{动作}}',
    negative_prompt: 'low quality, blurry, distorted face, extra fingers, watermark, text',
    notes: '批量补图片提示词时用',
  },
  {
    key: 'video_prompt',
    name: '图生视频运动描述',
    template_type: 'video_prompt',
    system: '你是专业的AI视频提示词工程师。请用英文输出，只描述画面运动与镜头运动，不要重复静态外观。',
    content: '为以下分镜生成英文视频运动提示词：画面:{{画面描述}}，动作:{{动作}}，情绪:{{情绪目标}}，镜头运动:{{镜头运动}}',
    negative_prompt: 'low quality, blurry, distorted face, flickering, unstable motion',
    notes: '批量补视频提示词时用',
  },
  {
    key: 'optimize_opening',
    name: '强化开头 3 秒',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。请保持原有结构与篇幅，只做针对性增强。',
    content: '请优化脚本，大幅强化开头3秒的吸引力，要让观众立刻停下来：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 开头钩子',
  },
  {
    key: 'optimize_conflict',
    name: '强化冲突',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。请保持原有结构与篇幅，只做针对性增强。',
    content: '请优化脚本，强化核心冲突的戏剧张力：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 冲突',
  },
  {
    key: 'optimize_satisfaction',
    name: '强化爽点',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。请保持原有结构与篇幅，只做针对性增强。',
    content: '请优化脚本，强化爽点密度和爽感：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 爽点',
  },
  {
    key: 'optimize_reversal',
    name: '强化反转',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。请保持原有结构与篇幅，只做针对性增强。',
    content: '请优化脚本，添加更强烈的反转：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 反转',
  },
  {
    key: 'optimize_hook',
    name: '强化评论钩子',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。请保持原有结构与篇幅，只做针对性增强。',
    content: '请优化脚本，强化评论互动钩子，引发观众讨论：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 互动',
  },
  {
    key: 'optimize_shorten',
    name: '缩短脚本',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。',
    content: '请精简脚本，删除冗余，保留核心冲突和爽点：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 精简',
  },
  {
    key: 'optimize_cinematic',
    name: '增加镜头感',
    template_type: 'optimize',
    system: '你是专业的AI短视频漫剧编剧。',
    content: '请优化脚本，增加镜头感和画面感描述：\n\n{{脚本内容}}',
    negative_prompt: '',
    notes: '脚本优化 · 镜头感',
  },
];

/**
 * 内置模板同步决策（纯函数，离线可断言）：算出该**新增**哪些、该**更新**哪些、该**保留**哪些。
 *
 * 纯函数的意义：这是唯一一处会**动用户已有数据**的逻辑，必须能脱离 store 反复验。
 * `keep` 带 `reason`，让启动日志能如实说出"为什么没更新"（same/custom/edited/unknown）。
 */
function planTemplateSync(storedRows, defaults, opts = {}) {
  const dig = opts.digest || digestText;
  const hist = opts.superseded || TEMPLATE_SUPERSEDED; // 注入点：离线断言/正对照要能造"历史指纹"
  const byKey = new Map();
  for (const t of (Array.isArray(storedRows) ? storedRows : [])) if (t && t.key) byKey.set(t.key, t);
  const insert = []; const update = []; const keep = [];
  for (const d of (Array.isArray(defaults) ? defaults : [])) {
    const cur = byKey.get(d.key);
    if (!cur) { insert.push(d); continue; }
    const curDigest = dig(cur.content);
    if (curDigest === dig(d.content)) { keep.push({ row: cur, def: d, reason: 'same' }); continue; }
    if (cur.is_builtin === false) { keep.push({ row: cur, def: d, reason: 'custom' }); continue; }
    const superseded = hist[d.key] || [];
    const ours = (cur.builtin_digest && cur.builtin_digest === curDigest) || superseded.indexOf(curDigest) >= 0;
    // 证明不了"还是我们发的那一版"就不动它 —— 覆盖用户改过的提示词是不可逆的伤害，
    // 而漏一次更新只是少一次改进（下次改了还会再遇到）
    if (!ours) { keep.push({ row: cur, def: d, reason: 'edited' }); continue; }
    update.push({ row: cur, def: d });
  }
  return { insert, update, keep };
}

/**
 * 首装写入 + 内置模板更新（批 8 补 28）。
 * 只更新"能证明没被用户改过"的内置模板；用户改过的原样保留并在返回值里点名。
 *
 * **补记指纹（`stamped`）为什么必须有**：本机制上线前装的库里，行上**没有** `builtin_digest`。
 * 内容恰好等于当前默认的那些会被判成 `same`（不需要更新）—— 于是它们**永远拿不到指纹**，
 * 等到将来某一轮真改了这些提示词时，"证明不了还是官方版"就会把它们判成 `edited` 而**永不更新**，
 * 除非维护者恰好记得手工往 `TEMPLATE_SUPERSEDED` 里补一条旧指纹。这是个只会在下一轮才炸的陷阱，
 * 所以内容已经等于官方默认的行要**顺手补记指纹**，让它从今往后都能自证。
 * 反过来说：**绝不能**给 `edited`/`custom` 的行补记 —— 那等于把"用户改过的内容"登记成"官方内容"，
 * 下次同步就会理直气壮地覆盖掉它（把一个静默不更新变成静默丢数据）。
 *
 * @returns {{inserted:number, updated:number, stamped:number, kept_edited:string[], kept_custom:string[]}}
 */
function seedTemplates(store) {
  const empty = { inserted: 0, updated: 0, stamped: 0, kept_edited: [], kept_custom: [] };
  if (!store) return empty;
  const plan = planTemplateSync(store.list('prompt_templates'), DEFAULT_TEMPLATES);
  for (const t of plan.insert) {
    store.insert('prompt_templates', Object.assign({
      is_favorited: false,
      is_builtin: true,
      builtin_version: 1,
    }, t, { builtin_digest: digestText(t.content) }));
  }
  for (const { row, def } of plan.update) {
    // 只动 content/system/版本这几个字段：收藏、自定义名称、notes 一律不碰
    store.update('prompt_templates', row.id, {
      content: def.content,
      system: def.system,
      builtin_version: def.builtin_version || 1,
      builtin_digest: digestText(def.content),
    });
  }
  // 补记指纹：内容**已经**等于官方默认（reason==='same'）、但行上还没有正确指纹的那些。
  // 只补字段、不动 content —— 事实是"这一行的内容就是官方这一版"，登记它不会改变任何显示或行为。
  let stamped = 0;
  for (const k of plan.keep) {
    if (k.reason !== 'same' || k.row.is_builtin === false) continue;
    if (k.row.builtin_digest === digestText(k.def.content)) continue;
    store.update('prompt_templates', k.row.id, {
      builtin_digest: digestText(k.def.content),
      builtin_version: k.def.builtin_version || 1,
    });
    stamped++;
  }
  return {
    inserted: plan.insert.length,
    updated: plan.update.length,
    stamped,
    kept_edited: plan.keep.filter((k) => k.reason === 'edited' || k.reason === 'unknown').map((k) => k.def.key),
    kept_custom: plan.keep.filter((k) => k.reason === 'custom').map((k) => k.def.key),
  };
}

module.exports = { DEFAULT_TEMPLATES, TEMPLATE_SUPERSEDED, planTemplateSync, seedTemplates };
