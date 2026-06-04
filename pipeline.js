/**
 * pipeline.js — 通用多工序内容生成流水线
 * 
 * 使用方式：
 *   1. 打开终端：node pipeline.js
 *   2. 输入课程需求
 *   3. 等着出结果
 * 
 * 嵌入你的平台：
 *   import { runPipeline } from './pipeline.js';
 *   const result = await runPipeline("教Python循环");
 * 
 * 只改下面这4个 prompt 就能换行业/换方法论
 * ————————————————————————————————
 */

// ══════════════════════════════════════════
// 配置区（改 API Key 和模型）
// ══════════════════════════════════════════

const CONFIG = {
  // 部署到 Zeabur 后通过环境变量设置（Dashboard → 环境变量）
  apiKey: process.env.DEEPSEEK_API_KEY || "sk-your-api-key-here",
  baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
  model: process.env.DEEPSEEK_MODEL || "deepseek-chat",

  // 课程默认参数
  defaultDuration: "15-20分钟",
  defaultAudience: "通用学习者",
  defaultStyle: "互动式教学",
};

// ══════════════════════════════════════════
// 工序1：Planner（守门人）
// ══════════════════════════════════════════

const PROMPT_PLANNER = `你是一个课程鉴定师。判断用户的输入是否适合生成课程。

要求：
- 只鉴定，不生成内容
- 如果用户输入的是完整的学习需求，输出 "通过"
- 如果输入过于模糊、无意义或不属于教育范畴，输出 "拒绝" + 原因

输出格式（严格JSON）：
{ "decision": "通过" | "拒绝", "reason": "原因" }
`;

// ══════════════════════════════════════════
// 工序2：Outlines（定大纲）
// ══════════════════════════════════════════

const PROMPT_OUTLINES = `你是一个课程设计师。根据用户需求生成课件大纲。

设计原则：
1. 每节课 15-20 分钟
2. 使用 S+R+F 三段结构：Signal（先想）→ Response（揭晓）→ Feedback（练习）
3. 第一个场景必须是"先想一想"，不能直接给定义

输出格式（严格JSON）：
{
  "title": "课程标题",
  "languageDirective": "教学语言指令",
  "outlines": [
    { "id": "scene_1", "type": "slide", "title": "先想一想：问题", "description": "抛问题", "keyPoints": ["问题1"], "order": 1 },
    { "id": "scene_2", "type": "slide", "title": "原来如此", "description": "揭晓答案", "keyPoints": ["核心概念"], "order": 2 },
    { "id": "scene_3", "type": "quiz", "title": "练练手", "description": "练习", "keyPoints": ["题目1"], "order": 3, "quizConfig": { "questionCount": 2, "difficulty": "easy", "questionTypes": ["single"] } }
  ]
}
`;

// ══════════════════════════════════════════
// 工序3：Slide Content（做PPT）+ Quiz Content（出题）
// ══════════════════════════════════════════

const PROMPT_SLIDE = `你是一个PPT课件制作师。根据大纲生成每个slide的详细内容和题目。

要求：
- 用简单清晰的语言
- 每页slide包含：标题、3-5个要点、1个思考问题
- 出题遵循三级难度：⭐基础巩固 ⭐⭐能力提高 ⭐⭐⭐拓展挑战

输出格式（严格JSON）：
{
  "slides": [
    { "sceneId": "scene_1", "title": "先想一想", "points": ["要点1","要点2","要点3"], "thinkQuestion": "思考问题" }
  ],
  "quizzes": [
    { "topic": "知识点名", "difficultyLevel": "⭐", "type": "single", "question": "题目", "options": [{"label":"A","value":"A"}], "answer": ["A"], "analysis": "解析" }
  ]
}
`;

// ══════════════════════════════════════════
// 工序4：交付（格式化输出）
// ══════════════════════════════════════════

const PROMPT_DELIVERY = `你是一个课程交付专员。把前面生成的所有内容整理成一份完整的课程包。

要求：
- 按场景顺序排列
- 标注每个场景的类型和时长
- 输出格式要清晰，方便直接展示给用户

输出格式（严格JSON）：
{
  "courseTitle": "课程标题",
  "totalScenes": 3,
  "estimatedDuration": "15分钟",
  "scenes": [
    { "order": 1, "type": "slide", "title": "场景标题", "content": "内容" }
  ],
  "quizzes": []
}
`;

// ══════════════════════════════════════════
// 核心引擎（不要改）
// ══════════════════════════════════════════

async function callAI(prompt, userInput) {
  const response = await fetch(`${CONFIG.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CONFIG.apiKey}`
    },
    body: JSON.stringify({
      model: CONFIG.model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: userInput }
      ],
      temperature: 0.7,
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    throw new Error(`API错误: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("无法从AI输出中解析JSON");
  return JSON.parse(match[0]);
}

// ══════════════════════════════════════════
// 流水线主函数
// ══════════════════════════════════════════

async function runPipeline(userInput) {
  console.log("\n🚀 开始生成课程...\n");

  // 工序1：守门
  console.log("📋 [工序1/4] 鉴定需求...");
  const step1 = await callAI(PROMPT_PLANNER, userInput);
  const planResult = extractJSON(step1);
  if (planResult.decision === "拒绝") {
    console.log(`❌ 已拒绝: ${planResult.reason}`);
    return { error: planResult.reason };
  }
  console.log("✅ 需求通过\n");

  // 工序2：定大纲
  console.log("📝 [工序2/4] 生成课件大纲...");
  const step2 = await callAI(PROMPT_OUTLINES, userInput);
  const outlineResult = extractJSON(step2);
  console.log(`   课程标题: ${outlineResult.title}`);
  console.log(`   场景数: ${outlineResult.outlines.length}\n`);

  // 工序3：生成内容
  console.log("🎨 [工序3/4] 生成课件内容...");
  const step3Input = JSON.stringify({
    userInput,
    outline: outlineResult
  });
  const step3 = await callAI(PROMPT_SLIDE, step3Input);
  const contentResult = extractJSON(step3);
  console.log(`   生成了 ${contentResult.slides.length} 页slide`);
  console.log(`   生成了 ${contentResult.quizzes.length} 道题目\n`);

  // 工序4：交付
  console.log("📦 [工序4/4] 打包课程...");
  const step4Input = JSON.stringify({
    outline: outlineResult,
    content: contentResult
  });
  const step4 = await callAI(PROMPT_DELIVERY, step4Input);
  const deliveryResult = extractJSON(step4);
  console.log("✅ 课程生成完成！\n");

  return deliveryResult;
}

// ══════════════════════════════════════════
// 终端入口
// ══════════════════════════════════════════

async function main() {
  const input = process.argv[2];
  if (!input) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question("📚 请输入课程需求: ", async (ans) => {
      rl.close();
      await execute(ans);
    });
  } else {
    await execute(input);
  }
}

async function execute(input) {
  try {
    const result = await runPipeline(input);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("❌ 流水线出错:", err.message);
  }
}

// 直接运行或作为模块导入
if (require.main === module) {
  main();
} else {
  module.exports = { runPipeline };
}
