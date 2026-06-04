/**
 * server.js — 极简学习平台服务器
 * 
 * 启动：node server.js
 * 打开：http://localhost:3000
 * 
 * 功能：
 *   - 用户输入课程需求 → 调 pipeline.js 生成内容 → 展示
 *   - 课堂功能通过 iframe 嵌入 OpenMAIC（https://zfx2026.zeabur.app）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const OPENMAIC_URL = "https://zfx2026.zeabur.app";

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

// Serve static files
function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// Pipeline.js 直接加载（不用 exec，更稳定）
const { runPipeline } = require('./pipeline.js');

// 通用 AI 调用（DeepSeek API）
async function callAI(systemPrompt, userInput) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key || key === 'sk-your-api-key-here') {
    throw new Error('请设置环境变量 DEEPSEEK_API_KEY');
  }
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput }
    ], temperature: 0.7, max_tokens: 2048 })
  });
  if (!response.ok) throw new Error(`API错误: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

// ══════════════════════════════════════════
// AI 家教讲题 Prompt
// ══════════════════════════════════════════

const PROMPT_TUTOR = `你是AI智能家教老师，专门为中国K12学生提供学科辅导。

教学原则：
1. 深入浅出 — 用生活化例子解释抽象概念
2. 互动式教学 — 讲完主动提问验证理解
3. 根据学生年级调整讲解深度
4. 学生说"听不懂"立即换一种方式

讲解格式：
📚 [标题] → 🎯 核心要点 → 💡 理解方法 → ❓ 思考问题 → 📝 练习

题目讲解格式：
📝 原题 → 💭 解题思路 → ✨ 关键点 → ⚠️ 易错点 → 📌 举一反三

每次讲完必须出1-2道练习题。先了解学生信息，再针对性讲解。`;

// ══════════════════════════════════════════
// 生成试卷 Prompt
// ══════════════════════════════════════════

const PROMPT_PAPER = `你是一个出卷老师。根据用户指定的年级、学科生成一张模拟试卷。

要求：
1. 试卷包含 10 道题：选择题 5 道 + 填空题 3 道 + 解答题 2 道
2. 难度分布：基础 40% + 中等 40% + 提高 20%
3. 标注每道题的分值和难度
4. 附参考答案和评分标准

输出格式（严格JSON）：
{
  "title": "试卷标题",
  "grade": "年级",
  "subject": "学科",
  "totalScore": 100,
  "questions": [
    { "type": "choice"|"fill"|"essay", "difficulty": "基础"|"中等"|"提高", "score": 5,
      "question": "题目内容",
      "options": ["A. xxx","B. xxx"],  // 选择题才有
      "answer": "答案",
      "analysis": "解析" }
  ]
}`;

// POST /api/paper 处理函数
async function handlePaper(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { grade, subject, count = 10 } = JSON.parse(body);
      if (!grade || !subject) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: '请指定年级和学科' }));
      }
      const input = `年级：${grade}\n学科：${subject}\n题数：${count}题`;
      const result = await callAI(PROMPT_PAPER, input);
      // 尝试提取 JSON
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(JSON.parse(jsonMatch[0])));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer: result }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// API: 讲题（直接调 AI，不经过 pipeline）
async function handleTutor(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { question, grade, subject } = JSON.parse(body);
      if (!question) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: '请输入题目' }));
      }
      const input = `学生年级：${grade || '未指定'}\n学科：${subject || '未指定'}\n题目/问题：${question}`;
      const result = await callAI(PROMPT_TUTOR, input);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer: result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// HTML pages
function getIndexHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>智慧学习大脑</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #333; min-height: 100vh; }
  .header { background: linear-gradient(135deg, #1F4E79, #2E75B6); color: white; padding: 24px 40px; }
  .header h1 { font-size: 24px; font-weight: 600; }
  .header p { font-size: 14px; opacity: 0.8; margin-top: 4px; }
  .container { max-width: 900px; margin: 0 auto; padding: 24px; }
  .input-box { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 20px; }
  .input-box textarea { width: 100%; min-height: 80px; padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; resize: vertical; }
  .input-box textarea:focus { outline: none; border-color: #2E75B6; box-shadow: 0 0 0 3px rgba(46,117,182,0.1); }
  .btn { background: #2E75B6; color: white; border: none; padding: 10px 28px; border-radius: 8px; font-size: 15px; cursor: pointer; margin-top: 12px; }
  .btn:hover { background: #1F4E79; }
  .btn:disabled { background: #999; cursor: not-allowed; }
  .loading { display: none; text-align: center; padding: 40px; color: #666; }
  .loading .spinner { border: 3px solid #eee; border-top: 3px solid #2E75B6; border-radius: 50%; width: 32px; height: 32px; animation: spin 0.8s linear infinite; margin: 0 auto 12px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .result { display: none; }
  .course-card { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 16px; overflow: hidden; }
  .course-header { padding: 20px 24px; border-bottom: 1px solid #eee; }
  .course-header h2 { font-size: 18px; color: #1F4E79; }
  .course-meta { font-size: 13px; color: #999; margin-top: 4px; }
  .scene { padding: 16px 24px; border-bottom: 1px solid #f0f0f0; }
  .scene:last-child { border-bottom: none; }
  .scene .tag { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; margin-bottom: 8px; }
  .tag-slide { background: #E6F1FB; color: #185FA5; }
  .tag-quiz { background: #EAF3DE; color: #3B6D11; }
  .scene h3 { font-size: 15px; margin-bottom: 8px; }
  .scene p, .scene li { font-size: 14px; line-height: 1.7; color: #555; }
  .quiz-item { background: #FAFAFA; border-radius: 8px; padding: 16px; margin-top: 12px; }
  .quiz-item .q { font-weight: 500; margin-bottom: 8px; }
  .quiz-item .opt { padding: 4px 0; font-size: 13px; }
  .quiz-item .ans { color: #3B6D11; font-weight: 500; margin-top: 6px; }
  .quiz-item .diff { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; background: #FFF3CD; color: #856404; margin-left: 8px; }
  .classroom-link { text-align: center; padding: 20px; background: #F0F7FF; border-radius: 12px; margin-top: 20px; }
  .classroom-link a { color: #2E75B6; font-weight: 500; text-decoration: none; }
  .classroom-link a:hover { text-decoration: underline; }
  .error-msg { color: #A32D2D; background: #FCEBEB; padding: 12px; border-radius: 8px; display: none; }
  .tabs { display: flex; gap: 0; margin-bottom: 20px; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .tab { flex: 1; padding: 14px; text-align: center; cursor: pointer; font-size: 15px; font-weight: 500; border: none; background: white; color: #999; transition: all 0.2s; }
  .tab.active { background: #2E75B6; color: white; }
  .tab:hover:not(.active) { background: #F0F7FF; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .tutor-answer { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); padding: 24px; line-height: 1.8; font-size: 15px; white-space: pre-wrap; }
  .form-row { display: flex; gap: 12px; margin-bottom: 12px; }
  .form-row input { flex: 1; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
  .form-row input:focus { outline: none; border-color: #2E75B6; }
</style>
</head>
<body>
<div class="header">
  <h1>智慧学习大脑</h1>
  <p>AI 课程生成 + 一对一讲题辅导</p>
</div>
<div class="container">

  <div class="tabs">
    <div class="tab active" onclick="switchTab('course')">生成课程</div>
    <div class="tab" onclick="switchTab('tutor')">AI 讲题</div>
  </div>

  <!-- 生成课程 -->
  <div class="tab-content active" id="tab-course">
    <div class="input-box">
      <textarea id="input" placeholder="请输入课程主题，例如：用Python教小学生做猜数字游戏"></textarea>
      <br>
      <button class="btn" onclick="generate()">生成课程</button>
    </div>
    <div class="loading" id="loading">
      <div class="spinner"></div>
      <p>正在生成课程，请稍候（约30秒）...</p>
    </div>
    <div class="error-msg" id="error"></div>
    <div class="result" id="result">
      <div class="course-card" id="courseHeader">
        <div class="course-header">
          <h2 id="courseTitle"></h2>
          <div class="course-meta" id="courseMeta"></div>
        </div>
        <div id="scenes"></div>
      </div>
      <div id="quizzes"></div>
      <div class="classroom-link">
        <a href="${OPENMAIC_URL}" target="_blank">进入课堂模式 \u2192</a>
        <p style="color:#999;font-size:12px;margin-top:4px">在 OpenMAIC 中查看和播放课件</p>
      </div>
    </div>
  </div>

  <!-- AI 讲题 -->
  <div class="tab-content" id="tab-tutor">
    <div class="input-box">
      <div class="form-row">
        <input id="tutorGrade" placeholder="年级（如：三年级）" value="三年级">
        <input id="tutorSubject" placeholder="学科（如：数学）" value="数学">
      </div>
      <textarea id="tutorInput" placeholder="输入题目或学习问题，例如：小明有5个苹果，给了小红2个，还剩几个？" style="min-height:60px"></textarea>
      <br>
      <button class="btn" onclick="askTutor()" style="background:#639922">AI 讲题</button>
    </div>
    <div class="loading" id="tutorLoading">
      <div class="spinner"></div>
      <p>AI 家教正在讲解，请稍候...</p>
    </div>
    <div class="error-msg" id="tutorError"></div>
    <div class="tutor-answer" id="tutorAnswer" style="display:none"></div>
  </div>

</div>

<script>
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  if (name === 'course') {
    document.querySelector('.tab').classList.add('active');
    document.getElementById('tab-course').classList.add('active');
  } else {
    document.querySelectorAll('.tab')[1].classList.add('active');
    document.getElementById('tab-tutor').classList.add('active');
  }
}

async function generate() {
  const input = document.getElementById('input').value.trim();
  if (!input) { alert('请输入课程主题'); return; }

  document.getElementById('loading').style.display = 'block';
  document.getElementById('result').style.display = 'none';
  document.getElementById('error').style.display = 'none';
  document.getElementById('generateBtn').disabled = true;

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderResult(data);
  } catch (err) {
    document.getElementById('error').textContent = '生成失败: ' + err.message;
    document.getElementById('error').style.display = 'block';
  } finally {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('generateBtn').disabled = false;
  }
}

function renderResult(data) {
  document.getElementById('courseTitle').textContent = data.courseTitle || '';
  document.getElementById('courseMeta').textContent = data.totalScenes + '个场景 \u00B7 ' + (data.estimatedDuration || '');

  let scenesHtml = '';
  (data.scenes || []).forEach((s, i) => {
    const isQuiz = s.type === 'quiz';
    scenesHtml += \`
      <div class="scene">
        <span class="tag \${isQuiz ? 'tag-quiz' : 'tag-slide'}">\${isQuiz ? '练习' : '讲解'}</span>
        <h3>\${s.order}. \${s.title}</h3>
        <p>\${s.content}</p>
      </div>
    \`;
  });
  document.getElementById('scenes').innerHTML = scenesHtml;

  let quizHtml = '';
  (data.quizzes || []).forEach((q, i) => {
    quizHtml += \`
      <div class="quiz-item">
        <div class="q">\${i+1}. \${q.question} <span class="diff">\${q.difficultyLevel || ''}</span></div>
        \${(q.options || []).map(o => '<div class="opt">' + o.label + '. ' + o.value + '</div>').join('')}
        <div class="ans">\u2705 答案: \${(q.answer || []).join(', ')}</div>
        <div style="font-size:13px;color:#666;margin-top:4px">\${q.analysis || ''}</div>
      </div>
    \`;
  });
  if (quizHtml) {
    document.getElementById('quizzes').innerHTML = '<div class="course-card"><div class="course-header"><h2>练习题</h2></div>' + quizHtml + '</div>';
  }

  document.getElementById('result').style.display = 'block';
}

async function askTutor() {
  const question = document.getElementById('tutorInput').value.trim();
  const grade = document.getElementById('tutorGrade').value.trim();
  const subject = document.getElementById('tutorSubject').value.trim();
  if (!question) { alert('请输入题目'); return; }

  document.getElementById('tutorLoading').style.display = 'block';
  document.getElementById('tutorAnswer').style.display = 'none';
  document.getElementById('tutorError').style.display = 'none';

  try {
    const res = await fetch('/api/tutor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, grade, subject })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    document.getElementById('tutorAnswer').textContent = data.answer;
    document.getElementById('tutorAnswer').style.display = 'block';
  } catch (err) {
    document.getElementById('tutorError').textContent = '讲题失败: ' + err.message;
    document.getElementById('tutorError').style.display = 'block';
  } finally {
    document.getElementById('tutorLoading').style.display = 'none';
  }
}
</script>
</body>
</html>`;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // API: generate course
  if (pathname === '/api/generate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { input } = JSON.parse(body);
        if (!input) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '请输入课程主题' }));
        }
        const result = await runPipeline(input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: 讲题（AI 家教）
  if (pathname === '/api/tutor' && req.method === 'POST') {
    return handleTutor(req, res);
  }

  // Serve main page
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getIndexHTML());
    return;
  }

  // API: 生成试卷
  if (pathname === '/api/paper' && req.method === 'POST') {
    return handlePaper(req, res);
  }

  // API: 生成试卷（GET 版，供 WorkBuddy 调用）
  if (pathname === '/api/paper-get' && req.method === 'GET') {
    const grade = parsed.query.grade || '未指定';
    const subject = parsed.query.subject || '未指定';
    const count = parsed.query.count || 10;
    try {
      const input = `年级：${grade}\n学科：${subject}\n题数：${count}题`;
      const result = await callAI(PROMPT_PAPER, input);
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(JSON.parse(jsonMatch[0])));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer: result }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: 讲题（GET 版，供 WorkBuddy 调用）
  if (pathname === '/api/tutor-get' && req.method === 'GET') {
    const question = parsed.query.question;
    const grade = parsed.query.grade || '未指定';
    const subject = parsed.query.subject || '未指定';
    if (!question) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '缺少 question 参数' }));
    }
    try {
      const input = `学生年级：${grade}\n学科：${subject}\n题目/问题：${decodeURIComponent(question)}`;
      const result = await callAI(PROMPT_TUTOR, input);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer: result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Serve static files
  const filePath = path.join(__dirname, pathname === '/pipeline.js' ? 'pipeline.js' : pathname);
  if (fs.existsSync(filePath)) {
    serveFile(res, filePath);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 智慧学习大脑已启动!`);
  console.log(`   打开 http://localhost:${PORT}`);
  console.log(`   输入课程主题，体验 AI 课程生成\n`);
});
